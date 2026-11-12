"""Admin app: LAN-facing settings UI + API. Separate ASGI app from the kiosk API; it mounts
none of the kiosk routes (/papyrus, /kiosk, /labels). Login is the Papyrus device grant; the
user must be a Papyrus admin."""
import asyncio
import collections
import contextlib
import importlib.metadata
import logging
import re
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import ValidationError

from . import mqtt as mqtt_mod
from . import papyrus_auth as pa
from .settings_store import Config, Mqtt, mask, merge_secrets, seed

log = logging.getLogger("kiosk.admin")

COOKIE = "kiosk_admin"
CSRF_HEADER = "x-kiosk-admin"
IDLE_S, MAX_S = 15 * 60, 60 * 60
LOGIN_LIMIT, LOGIN_WINDOW = 5, 60.0
MAX_PENDING, MAX_PENDING_IP, POLL_STALE_S = 20, 3, 30.0
NO_TOUCH = {"/admin/api/status", "/admin/api/session"}  # background polls keep no session alive
# Links into Papyrus (relative to its public URL, else its API base URL).
PAPYRUS_CONTACTS_PATH = "/contacts"
PAPYRUS_KIOSK_TOKEN_PATH = "/settings?tab=kiosks"
ID = re.compile(r"[A-Za-z0-9-]+")
CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'")


@dataclass
class AdminSession:
    token: str
    token_id: str
    user: str
    created: float
    last: float


class Sessions:
    def __init__(self, clock, idle_s=IDLE_S, max_s=MAX_S):
        self.clock, self.idle_s, self.max_s = clock, idle_s, max_s
        self.items: dict[str, AdminSession] = {}
        self.dead: list[AdminSession] = []  # expired, awaiting Papyrus token revocation

    def create(self, token: str, token_id: str, user: str) -> str:
        sid, now = secrets.token_urlsafe(32), self.clock()  # 256 random bits
        self.items[sid] = AdminSession(token, token_id, user, now, now)
        return sid

    def _expired(self, s: AdminSession, now: float) -> bool:
        return now - s.last > self.idle_s or now - s.created > self.max_s

    def get(self, sid: str | None, touch: bool = True) -> AdminSession | None:
        s = self.items.get(sid or "")
        if not s:
            return None
        now = self.clock()
        if self._expired(s, now):
            self.dead.append(self.items.pop(sid))
            return None
        if touch:
            s.last = now
        return s

    def reap(self):
        now = self.clock()
        for sid in [k for k, s in self.items.items() if self._expired(s, now)]:
            self.dead.append(self.items.pop(sid))

    def remaining(self, s: AdminSession) -> int:
        now = self.clock()
        return int(max(0, min(self.idle_s - (now - s.last), self.max_s - (now - s.created))))


class RateLimit:
    def __init__(self, clock, limit=LOGIN_LIMIT, window=LOGIN_WINDOW):
        self.clock, self.limit, self.window = clock, limit, window
        self.hits: dict[str, collections.deque] = {}

    def allow(self, key: str) -> bool:
        now = self.clock()
        q = self.hits.setdefault(key, collections.deque())
        while q and now - q[0] > self.window:
            q.popleft()
        if len(self.hits) > 1024:
            for k in [k for k, v in self.hits.items() if not v or now - v[-1] > self.window]:
                del self.hits[k]
        if len(q) >= self.limit:
            return False
        q.append(now)
        return True


@dataclass
class Login:
    state: str = "pending"
    sid: str | None = None
    created: float = 0.0
    ip: str = ""
    polled: float = 0.0
    task: asyncio.Task | None = field(default=None, repr=False)


def _errs(e: ValidationError) -> list[dict]:
    """loc and msg only: never echo request input (secrets) back."""
    return [{"loc": list(x["loc"]), "msg": x["msg"]}
            for x in e.errors(include_input=False, include_url=False)]


def _version() -> str:
    try:
        return importlib.metadata.version("kiosk-api")
    except importlib.metadata.PackageNotFoundError:
        return "dev"


def create_admin_app(kiosk: FastAPI, *, tls: bool = True, cookie_secure: bool = True, clock=time.monotonic) -> FastAPI:
    ks = kiosk.state
    sessions, limiter = Sessions(clock), RateLimit(clock)
    logins: dict[str, Login] = {}
    http: dict = {}

    def eff():
        return ks.effective()

    async def pcall(method: str, path: str, token: str | None = None, timeout: float = 15, **kw):
        s = eff()
        try:
            r = await http["c"].request(
                method, f"{s.papyrus_url.rstrip('/')}/api/v1/{path}", timeout=timeout,
                follow_redirects=False,
                headers={"Authorization": f"Bearer {token or s.papyrus_token}"}, **kw)
            ks.last_papyrus["t"] = time.time()
            return r
        except httpx.HTTPError:
            return None

    async def flush_dead():
        dead, sessions.dead = sessions.dead, []
        for d in dead:
            with contextlib.suppress(Exception):
                await pa.revoke_token(pcall, d.token, d.token_id)

    async def reaper():
        while True:
            await asyncio.sleep(5)
            sessions.reap()
            now = clock()
            for k in [k for k, v in logins.items() if now - v.created > 900 or (
                    v.state == "pending" and now - v.polled > POLL_STALE_S)]:
                lg = logins.pop(k)
                if lg.task:
                    lg.task.cancel()
            await flush_dead()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        async with httpx.AsyncClient(timeout=15) as c:
            http["c"] = c
            bg = asyncio.create_task(reaper())
            try:
                yield
            finally:
                bg.cancel()
                for lg in logins.values():
                    if lg.task:
                        lg.task.cancel()
                sessions.reap()
                for sid in list(sessions.items):
                    sessions.dead.append(sessions.items.pop(sid))
                with contextlib.suppress(Exception):
                    await asyncio.shield(flush_dead())

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.sessions, app.state.limiter, app.state.logins = sessions, limiter, logins

    @app.middleware("http")
    async def guard(request: Request, call_next):
        path = request.url.path
        api = path.startswith("/admin/api/")
        if api and request.method not in ("GET", "HEAD", "OPTIONS") \
                and request.headers.get(CSRF_HEADER) != "1":
            resp: Response = JSONResponse({"error": {"code": "csrf"}}, 403)
        else:
            resp = await call_next(request)
        h = resp.headers
        h["Content-Security-Policy"] = CSP
        h["X-Content-Type-Options"] = "nosniff"
        h["X-Frame-Options"] = "DENY"
        h["Referrer-Policy"] = "no-referrer"
        if tls:
            h["Strict-Transport-Security"] = "max-age=31536000"
        if api or not path.startswith("/assets/"):
            h["Cache-Control"] = "no-store"
        return resp

    def err(code: str, status: int, headers: dict | None = None):
        return JSONResponse({"error": {"code": code}}, status, headers)

    async def need(request: Request) -> AdminSession:
        s = sessions.get(request.cookies.get(COOKIE),
                       touch=request.url.path not in NO_TOUCH)
        if sessions.dead:
            await flush_dead()
        if not s:
            raise HTTPException(401, "unauthorized")
        return s

    @app.exception_handler(HTTPException)
    async def http_exc(request: Request, e: HTTPException):
        return JSONResponse({"error": {"code": str(e.detail)}}, e.status_code)

    # ---- login (Papyrus device grant) ----
    async def login_task(lg: Login, g: pa.Grant):
        out, body = await pa.poll_grant(pcall, g, clock, lambda: True)
        if out != "ok":
            lg.state = {"reset": "error"}.get(out, out)
            return
        tok, tid = body["access_token"], str(body["token_id"])
        r = await pcall("GET", pa.ME, tok)
        me = None
        with contextlib.suppress(ValueError):
            me = r.json() if r is not None and r.status_code == 200 else None
        if not isinstance(me, dict) or me.get("role") != "admin":
            await pa.revoke_token(pcall, tok, tid)
            lg.state = "forbidden" if isinstance(me, dict) else "error"
            return
        lg.sid = sessions.create(tok, tid, me.get("display_name") or me.get("email") or "admin")
        lg.state = "ok"

    @app.post("/admin/api/login/start")
    async def login_start(request: Request):
        ip = request.client.host if request.client else "?"
        if not limiter.allow(ip):
            return err("rate_limited", 429, {"Retry-After": str(int(LOGIN_WINDOW))})
        if sum(1 for v in logins.values() if v.state == "pending") >= MAX_PENDING:
            return err("busy", 429)
        if sum(1 for v in logins.values() if v.state == "pending" and v.ip == ip) >= MAX_PENDING_IP:
            return err("busy", 429)
        g, e = await pa.request_grant(pcall, f"{eff().kiosk_name} admin", clock)
        if e:
            return err(e[0], e[1], e[2])
        lid = secrets.token_urlsafe(32)
        lg = logins[lid] = Login(created=clock(), ip=ip, polled=clock())
        lg.task = asyncio.create_task(login_task(lg, g))
        return {"login_id": lid, "qr_uri": pa.public_uri(eff().papyrus_public_url, g.uri),
                "user_code": g.user_code, "expires_in": int(g.expires_in)}

    @app.get("/admin/api/login/{lid}")
    async def login_state(lid: str, response: Response):
        lg = logins.get(lid)
        if not lg:
            return err("not_found", 404)
        lg.polled = clock()
        if lg.state == "pending":
            return {"state": "pending"}
        logins.pop(lid, None)
        if lg.state == "ok" and lg.sid:
            response.set_cookie(COOKIE, lg.sid, httponly=True, secure=cookie_secure, samesite="strict",
                                path="/admin", max_age=MAX_S)
        return {"state": lg.state}

    @app.post("/admin/api/logout")
    async def logout(request: Request, response: Response):
        sid = request.cookies.get(COOKIE)
        s = sessions.items.pop(sid or "", None)
        if s:
            sessions.dead.append(s)
        await flush_dead()
        response.delete_cookie(COOKIE, path="/admin")
        return {"ok": True}

    @app.get("/admin/api/session")
    async def session(s: AdminSession = Depends(need)):
        return {"user": s.user, "remaining_s": sessions.remaining(s)}

    # ---- settings ----
    def links() -> dict:
        e = eff()
        b = (e.papyrus_public_url or e.papyrus_url).rstrip("/")
        return {"contacts": b + PAPYRUS_CONTACTS_PATH, "kiosk_token": b + PAPYRUS_KIOSK_TOKEN_PATH}

    def view() -> dict:
        cur = ks.store.current()
        return {"config": mask(cur.config if cur else seed(ks.base)), "persisted": bool(cur),
                "cache": {"smb_shares": [x.model_dump() for x in cur.smb_shares] if cur else []},
                "links": links()}

    @app.get("/admin/api/settings")
    async def get_settings(_: AdminSession = Depends(need)):
        return view()

    @app.put("/admin/api/settings")
    async def put_settings(body: dict, _: AdminSession = Depends(need)):
        cur = ks.store.current()
        old = cur.config if cur else seed(ks.base)
        try:
            cfg = Config.model_validate(merge_secrets(old, body.get("config") or {}))
            await ks.store.set_config(cfg)
        except ValidationError as e:
            return JSONResponse({"error": {"code": "invalid", "detail": _errs(e)}}, 422)
        except ValueError:
            return JSONResponse({"error": {"code": "invalid"}}, 422)
        except OSError:
            log.exception("settings not written")
            return err("write_failed", 500)
        if not cfg.login.show_recent and not ks.recent.clear():
            return err("write_failed", 500)
        if not cur:
            asyncio.create_task(ks.refresh())  # resolve share names for offline use
        return view()

    @app.post("/admin/api/recent/clear")
    async def recent_clear(_: AdminSession = Depends(need)):
        if not ks.recent.clear():
            return err("write_failed", 500)
        return {"ok": True}

    @app.get("/admin/api/login-config")
    async def login_config(_: AdminSession = Depends(need)):
        """What Papyrus allows (shared token); older Papyrus reports everything optional off."""
        r = await pcall("GET", pa.LOGIN_CONFIG)
        avail = r is not None and r.status_code == 200
        return {**await pa.login_config(pcall), "available": avail}

    # ---- Papyrus pickers (admin's own token) ----
    async def papyrus_get(s: AdminSession, path: str, params=None):
        r = await pcall("GET", path, s.token, params=params)
        if r is None:
            return err("upstream_unreachable", 502)
        if 300 <= r.status_code < 400:
            return err("upstream_redirect", 502)
        return Response(r.content, r.status_code, media_type="application/json")

    @app.get("/admin/api/papyrus/contacts")
    async def p_contacts(s: AdminSession = Depends(need)):
        return await papyrus_get(s, "contacts")

    @app.get("/admin/api/papyrus/smb/shares")
    async def p_shares(s: AdminSession = Depends(need)):
        return await papyrus_get(s, "smb/shares")

    @app.get("/admin/api/papyrus/smb/browse/{share_id}")
    async def p_browse(share_id: str, path: str = "", s: AdminSession = Depends(need)):
        if not ID.fullmatch(share_id):
            return err("bad_request", 400)
        return await papyrus_get(s, f"smb/browse/{share_id}", {"path": path})

    @app.get("/admin/api/papyrus/scan-profiles")
    async def p_profiles(s: AdminSession = Depends(need)):
        return await papyrus_get(s, "scan-profiles")

    @app.get("/admin/api/papyrus/scanners/default/options")
    async def p_options(s: AdminSession = Depends(need)):
        return await papyrus_get(s, "scanners/default/options")

    # ---- tests, status, screen ----
    async def lm_probe(url: str, token: str):
        if not re.fullmatch(r"https?://\S+", url or ""):
            return {"ok": False, "error": "bad url"}
        try:
            async with httpx.AsyncClient(timeout=8, follow_redirects=False) as c:
                r = await c.get(f"{url.rstrip('/')}/api/v1/health",
                                headers={"Authorization": f"Bearer {token}"} if token else {})
        except httpx.HTTPError as e:
            return {"ok": False, "error": type(e).__name__}
        return {"ok": r.is_success, "status": r.status_code}

    @app.get("/admin/api/labelmaker/test")
    async def lm_test(_: AdminSession = Depends(need)):
        cur = ks.store.current()
        lm = cur.config.labelmaker if cur else seed(ks.base).labelmaker
        return await lm_probe(lm.url, lm.token) if lm else {"ok": False, "error": "not configured"}

    @app.post("/admin/api/labelmaker/test")
    async def lm_test_body(body: dict, _: AdminSession = Depends(need)):
        cur = ks.store.current()
        old = cur.config if cur else seed(ks.base)
        d = merge_secrets(old, {"labelmaker": body}).get("labelmaker") or {}
        return await lm_probe(d.get("url", ""), d.get("token", ""))

    @app.post("/admin/api/mqtt/test")
    async def mqtt_test(body: dict, _: AdminSession = Depends(need)):
        cur = ks.store.current()
        old = cur.config if cur else seed(ks.base)
        try:
            m = Mqtt.model_validate(merge_secrets(old, {"mqtt": body})["mqtt"])
        except ValidationError as e:
            return {"ok": False, "error": "invalid: " + "; ".join(
                ".".join(map(str, x["loc"])) + " " + x["msg"] for x in _errs(e))}
        except ValueError:
            return {"ok": False, "error": "invalid"}
        s = ks.base.model_copy(update=dict(
            mqtt_host=m.host, mqtt_port=m.port, mqtt_username=m.username,
            mqtt_password=m.password, mqtt_tls=m.tls, mqtt_ca_pem=m.ca_pem,
            mqtt_ca_file="", mqtt_tls_insecure=m.tls_insecure))
        try:
            await mqtt_mod.probe(s)
        except Exception as e:  # MqttError, OSError, timeout, bad CA
            return {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
        return {"ok": True}

    @app.get("/admin/api/status")
    async def status(_: AdminSession = Depends(need)):
        e = eff()
        return {"version": _version(), "uptime_s": int(time.time() - ks.started),
                "mqtt": {"enabled": bool(e.mqtt_host), "connected": mqtt_mod.STATE["connected"]},
                "papyrus_last_contact": ks.last_papyrus["t"], "config_rev": ks.store.rev,
                "links": links()}

    @app.post("/admin/api/screen/reload")
    async def screen_reload(_: AdminSession = Depends(need)):
        ks.screen.reload()
        return {"ok": True}

    # ---- SPA (admin.html only; the kiosk SPA is never served here) ----
    def root() -> Path:
        return Path(eff().static_dir).resolve()

    @app.get("/")
    async def home():
        return RedirectResponse("/admin")

    @app.get("/assets/{path:path}")
    async def assets(path: str):
        base = (root() / "assets").resolve()
        f = (base / path).resolve()
        if f.is_file() and f.is_relative_to(base):
            return FileResponse(f)
        return err("not_found", 404)

    @app.get("/admin/{path:path}")
    async def spa(path: str):
        f = root() / "admin.html"
        if path.startswith("api/") or not f.is_file():
            return err("not_found", 404)
        return FileResponse(f)

    @app.get("/admin")
    async def spa_root():
        return await spa("")

    return app
