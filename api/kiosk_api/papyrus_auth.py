"""Papyrus device-grant helpers, shared by the kiosk unlock flow and the admin login.

`call(method, path, token=None, **kw)` is any coroutine that talks to Papyrus and returns an
httpx.Response, or None on transport failure.
"""
import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

import httpx

DEVICE_CODE = "auth/device/code"
DEVICE_TOKEN = "auth/device/token"
REVOKE = "auth/tokens/{id}"
ME = "auth/me"
LOGIN_CONFIG = "auth/kiosk-login/config"
LOGIN_USERS = "auth/kiosk-login/users"
APPROVE_REQUEST = "auth/device/approve-request"
DEVICE_PIN = "auth/device/pin"

Call = Callable[..., Awaitable[httpx.Response | None]]


@dataclass
class Grant:
    device_code: str
    user_code: str
    uri: str
    expires_in: float
    interval: float
    deadline: float = 0.0  # on the caller's clock, set at request time
    match_code: str = ""  # approve flow only


def retry_after(r: httpx.Response) -> float:
    try:
        return min(60.0, max(0.0, float(r.headers.get("retry-after", 5))))
    except ValueError:
        return 5.0


def public_uri(public_url: str, uri: str) -> str:
    """Rewrite the verification URI onto the user-facing Papyrus URL, when one is set."""
    pub = public_url.rstrip("/")
    if not pub:
        return uri
    u = urlsplit(uri)
    return pub + u.path + (f"?{u.query}" if u.query else "")


async def request_grant(call: Call, client_name: str, clock: Callable[[], float]) -> tuple[Grant | None, tuple | None]:
    """Returns (grant, None) or (None, (error_code, http_status, headers))."""
    r = await call("POST", DEVICE_CODE, json={"client_name": client_name})
    if r is None:
        return None, ("upstream_unreachable", 502, {})
    if r.status_code == 429:
        return None, ("rate_limited", 429, {"Retry-After": str(int(retry_after(r)))})
    try:
        d = r.json()
        g = Grant(d["device_code"], d["user_code"],
                  d.get("verification_uri_complete") or d["verification_uri"],
                  float(d.get("expires_in", 300)), float(d.get("interval", 5)))
    except (ValueError, KeyError, TypeError):
        return None, ("upstream_error", 502, {})
    if r.status_code != 200:
        return None, ("upstream_error", 502, {})
    g.deadline = clock() + g.expires_in
    return g, None


async def poll_grant(call: Call, g: Grant, clock: Callable[[], float],
                     current: Callable[[], bool]) -> tuple[str, dict | None]:
    """Poll until the grant resolves. Outcomes: ok (token body, with token_id), denied,
    expired, reset (unusable/unexpected), stale (current() went False: caller moved on).
    Never cancelled mid-request: callers invalidate via current()."""
    interval, deadline = g.interval, g.deadline
    while True:
        await asyncio.sleep(interval)
        if not current():
            return "stale", None
        if clock() >= deadline:
            return "expired", None
        r = await call("POST", DEVICE_TOKEN, json={"device_code": g.device_code})
        try:
            body: Any = r.json() if r is not None else {}
        except ValueError:
            body = {}
        if r is not None and r.status_code == 200 and isinstance(body, dict) \
                and body.get("access_token"):
            if not body.get("token_id"):  # unusable grant: reject, nothing to revoke
                return "reset", None
            return "ok", body
        if not current():
            return "stale", None
        if r is None:
            continue
        if r.status_code == 429:
            interval = max(interval, retry_after(r))
            continue
        code = body.get("code") if isinstance(body, dict) else None
        if code == "authorization_pending" or r.status_code >= 500:
            continue
        if code == "slow_down":
            interval += 5
        elif code == "access_denied":
            return "denied", None
        elif code == "expired_token":
            return "expired", None
        else:  # invalid_grant or anything unexpected
            return "reset", None


async def revoke_token(call: Call, token: str, token_id: str):
    """Revoke with the token itself; fall back to the shared token (e.g. already expired)."""
    path = REVOKE.format(id=token_id)
    r = await call("DELETE", path, token)
    if r is None or (not r.is_success and r.status_code != 404):
        await call("DELETE", path)


async def login_config(call: Call) -> dict:
    """Papyrus's view of the optional login methods. Any failure (older Papyrus) means unavailable."""
    off = {"approve": False, "pin": False, "pin_length": 6}
    r = await call("GET", LOGIN_CONFIG)
    try:
        d = r.json() if r is not None and r.status_code == 200 else None
        if not isinstance(d, dict):
            return off
        n = d.get("pin_length")
        return {"approve": d.get("approve") is True, "pin": d.get("pin") is True,
                "pin_length": n if isinstance(n, int) and not isinstance(n, bool) and 4 <= n <= 12 else 6}
    except ValueError:
        return off


async def list_users(call: Call) -> list[dict] | None:
    r = await call("GET", LOGIN_USERS)
    try:
        d = r.json() if r is not None and r.status_code == 200 else None
    except ValueError:
        return None
    if not isinstance(d, list):
        return None
    return [{"id": str(u["id"]), "display_name": str(u.get("display_name") or u["id"]),
             "has_pin": bool(u.get("has_pin"))} for u in d if isinstance(u, dict) and u.get("id") is not None]


async def approve_request(call: Call, user_id: str, client_name: str,
                          clock: Callable[[], float]) -> tuple[Grant | None, tuple | None]:
    """Like request_grant, for a named user; the grant carries the 2-digit match_code."""
    r = await call("POST", APPROVE_REQUEST, json={"user_id": user_id, "client_name": client_name})
    if r is None:
        return None, ("upstream_unreachable", 502, {})
    if r.status_code == 429:
        return None, ("rate_limited", 429, {"Retry-After": str(int(retry_after(r)))})
    if r.status_code == 404:  # unknown or inactive user: the caller should refresh its list
        return None, ("unknown_user", 404, {})
    if r.status_code in (400, 409):
        return None, ("request_rejected", r.status_code, {})
    try:
        d = r.json()
        g = Grant(d["device_code"], "", "", float(d.get("expires_in", 120)),
                  float(d.get("interval", 2)), match_code=str(d["match_code"]))
    except (ValueError, KeyError, TypeError):
        return None, ("upstream_error", 502, {})
    if r.status_code != 200:
        return None, ("upstream_error", 502, {})
    g.deadline = clock() + g.expires_in
    return g, None


async def pin_login(call: Call, user_id: str, pin: str, client_name: str) -> httpx.Response | None:
    return await call("POST", DEVICE_PIN, json={"user_id": user_id, "pin": pin, "client_name": client_name})
