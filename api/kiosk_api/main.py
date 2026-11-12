import asyncio
import logging
import re
import unicodedata
import time
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse

from . import mqtt
from .admin import RateLimit
from .config import Settings
from . import papyrus_auth as pa
from .settings_store import SettingsStore, effective, refresh_cache
from .recent_store import RecentStore
from .session import Unlock
from .screen import NoBacklight, NoBrightness, Screen
from .stats import Stats

log = logging.getLogger("kiosk.api")
ID = r"[A-Za-z0-9-]+"


def _c(*pats: str) -> list[re.Pattern]:
    return [re.compile(p.replace("{id}", ID)) for p in pats]


# Everything proxied needs an unlock session (locked kiosk shows only the sign-in screen).
# Papyrus calls use the user's token; label calls keep the LABELMAKER token. Email is never proxied.
ALLOW = {
    "papyrus": {
        "GET": _c(
            "system/health", "printers/default/status", "scanners/default/status",
            "scanners/default/options", "scan-profiles", "scans",
            "scans/{id}", "scans/{id}/thumbnail", "scans/{id}/download", "copy/{id}", "jobs", "jobs/{id}/thumbnail",
            "smb/shares", "smb/browse/{id}", "smb/download/{id}", "cloud/providers",
            "cloud/files/{id}", "cloud/download/{id}", "email/config",
        ),
        "POST": _c("scans", "copy", "scans/{id}/cancel", "copy/{id}/cancel",
                   "jobs/{id}/release", "jobs/{id}/cancel",
                   "scans/{id}/(?:smb|cloud|paperless|ocr|enhance|backs)",
                   "scans/collate", "jobs/upload"),
        "DELETE": _c("scans/{id}"),
    },
    "labels": {
        "GET": _c("health", "presets", "printer/status", "history",
                  "history/{id}/thumbnail", "print/jobs/{id}"),
        "POST": _c("presets/{id}/print", "history/{id}/reprint",
                   "print/jobs/{id}/cancel"),
    },
}
# All Papyrus paths the kiosk calls itself, in one place.
PP = {
    "scan_download": "scans/{id}/download",
    "scan_email": "scans/{id}/email",
    "scan_smb": "scans/{id}/smb",
    "scan_cloud": "scans/{id}/cloud",
    "scan_paperless": "scans/{id}/paperless",
    "scan_ocr": "scans/{id}/ocr",
    "scan_enhance": "scans/{id}/enhance",
    "scan_delete": "scans/{id}",
    "smb_download": "smb/download/{id}",
    "cloud_download": "cloud/download/{id}",
    "jobs_upload": "jobs/upload",
}
TGT_STR = {"type", "share_id", "provider_id", "contact_id", "to", "path", "folder_id"}
LONG = _c("copy", "scans", "jobs/upload", "scans/{id}/(?:smb|cloud|paperless|ocr|enhance|backs)",
          "scans/collate")
DROP_REQ = {"authorization", "cookie", "host", "content-length", "connection",
            "transfer-encoding", "accept-encoding"}
HOP = {"connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade",
       "proxy-authenticate", "proxy-authorization"}
DROP_RESP = HOP | {"set-cookie", "content-length", "content-encoding", "location"}


def create_app(settings: Settings | None = None) -> FastAPI:
    base = settings or Settings()
    s = base
    store = SettingsStore(base.settings_path)
    recent = RecentStore(base.recent_path)
    ucache: dict = {"t": 0.0, "users": None}
    started = time.time()
    last_papyrus: dict = {"t": None}

    scr = Screen(s.backlight_path)
    unlock = Unlock(s.unlock_idle_s, s.unlock_max_s)
    flow: dict = {"task": None}
    pin_limiter = RateLimit(lambda: unlock.clock(), limit=10, window=60.0)
    search_limiter = RateLimit(lambda: unlock.clock(), limit=30, window=60.0)
    upstreams: dict = {}

    def apply_settings():
        """Re-derive effective settings; closures below read s/upstreams live."""
        nonlocal s
        s = effective(base, store.current())
        upstreams["papyrus"] = (s.papyrus_url.rstrip("/"), s.papyrus_token)
        upstreams["labels"] = (s.labelmaker_url.rstrip("/"), s.labelmaker_token)
        unlock.idle_s, unlock.max_s = s.unlock_idle_s, s.unlock_max_s

    def new_labels_client() -> httpx.AsyncClient | None:
        url, tok = upstreams["labels"]
        if not url:
            return None
        return httpx.AsyncClient(timeout=15, headers={"Authorization": f"Bearer {tok}"} if tok else {})

    store.load()
    apply_settings()
    lm_key = {"k": None}

    async def on_change():
        apply_settings()
        await swap_labels()
        await mgr.apply(s)

    async def swap_labels():
        k = upstreams["labels"]
        if k == lm_key["k"]:
            return
        old, app.state.labels = app.state.labels, new_labels_client()
        lm_key["k"] = k
        if old:
            await old.aclose()

    devices: dict = {k: {"data": None, "at": None, "stale": False} for k in ("printer", "scanner")}
    devices_tried = {"v": False}
    dev_lock = asyncio.Lock()

    async def refresh_devices():
        """Probe printer+scanner once; a failed probe keeps that device's last value and marks it stale."""
        async with dev_lock:
            rs = await asyncio.gather(pcall("GET", "printers/default/status"),
                                      pcall("GET", "scanners/default/status"))
            for key, r in zip(("printer", "scanner"), rs):
                try:
                    d = r.json() if r is not None and r.is_success else None
                except ValueError:
                    d = None
                dv = devices[key]
                if isinstance(d, dict):
                    dv.update(data=d, at=time.time(), stale=False)
                else:
                    dv["stale"] = True
            devices_tried["v"] = True

    async def status_loop():
        while True:
            try:
                await asyncio.sleep(15)
            except asyncio.CancelledError:
                raise
            try:
                await refresh_devices()
            except Exception:  # keep polling whatever happens
                log.exception("device refresh failed")

    async def cache_loop():
        while True:
            if store.current():
                await refresh_cache(store, pcall)
            await asyncio.sleep(600)

    async def pcall(method: str, path: str, token: str | None = None, timeout: float = 15,
                    **kw) -> httpx.Response | None:
        """Call Papyrus; None on transport failure."""
        base, shared = upstreams["papyrus"]
        try:
            r = await app.state.client.request(
                method, f"{base}/api/v1/{path}", timeout=timeout, follow_redirects=False,
                headers={"Authorization": f"Bearer {token or shared}"}, **kw)
            last_papyrus["t"] = time.time()
            return r
        except httpx.HTTPError:
            return None

    async def revoke(sess):
        if sess.token_id:
            await pa.revoke_token(pcall, sess.token, sess.token_id)

    unlock.revoke = revoke

    mgr = mqtt.Manager(scr, Stats(s.proc_root, s.sys_root, s.hostfs), unlock)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with httpx.AsyncClient(timeout=15) as client:
            app.state.client = client
            app.state.labels = new_labels_client()
            lm_key["k"] = upstreams["labels"]
            await mgr.apply(s)
            bg = [asyncio.create_task(unlock.reaper())]
            if base.papyrus_token:
                bg.append(asyncio.create_task(cache_loop()))
                bg.append(asyncio.create_task(status_loop()))
            try:
                yield
            finally:
                await asyncio.shield(unlock.lock())  # revoke the token on shutdown
                ts = [*bg, flow["task"]]
                for t in ts:
                    if t:
                        t.cancel()
                await asyncio.gather(*(t for t in ts if t), return_exceptions=True)
                await mgr.stop()
                if app.state.labels:
                    await app.state.labels.aclose()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.unlock = unlock
    app.state.expire_users = lambda: ucache.update(t=-1e9)
    app.state.store, app.state.base, app.state.recent = store, base, recent
    app.state.on_change = on_change
    store.applier = on_change
    app.state.effective = lambda: s
    app.state.mgr, app.state.screen = mgr, scr
    app.state.started, app.state.last_papyrus = started, last_papyrus
    app.state.call = pcall
    app.state.refresh = lambda: refresh_cache(store, pcall)
    app.state.refresh_devices = refresh_devices

    @app.get("/kiosk/config")
    async def config():
        pub = {
            "config_rev": store.rev,
            "idle_minutes": s.idle_minutes,
            "name": s.kiosk_name,
            "public_url": s.papyrus_public_url.rstrip("/"),
            "unlock": {"idle_s": s.unlock_idle_s, "max_s": s.unlock_max_s},
        }
        if not unlock.active():
            return pub
        return {
            **pub,
            "presets": s.presets(),
            "smb_shares": s.shares,
            "destinations": {
                "paperless": s.scan_paperless,
                "smb": {"share_id": s.scan_smb_share_id, "path": s.scan_smb_path}
                if s.scan_smb_share_id else None,
                "cloud": {"provider_id": s.scan_cloud_provider_id}
                if s.scan_cloud_provider_id else None,
            },
        }

    async def ensure_devices():
        if not devices_tried["v"]:
            await refresh_devices()

    @app.get("/kiosk/devices")
    async def kiosk_devices():
        """Cached printer/scanner status (refreshed every 15 s in the background)."""
        if not unlock.active():
            return locked()
        await ensure_devices()
        now = time.time()
        out = {}
        for k, dv in devices.items():
            out[k] = dv["data"]
            out[f"{k}_stale"] = dv["stale"]
            out[f"{k}_age_s"] = None if dv["at"] is None else max(0, int(now - dv["at"]))
        return out

    @app.get("/kiosk/status")
    async def kiosk_status():
        """Locked-screen readiness: two booleans via the shared token, nothing else."""
        await ensure_devices()
        p, c = devices["printer"]["data"] or {}, devices["scanner"]["data"] or {}
        return {"printer_ready": bool(p and p.get("accepting_jobs") and p.get("state") != 5),
                "scanner_ready": bool(c.get("available") and not c.get("busy"))}

    # ---- unlock ----
    def err(code: str, status: int, **kw):
        return JSONResponse({"error": {"code": code, **kw}}, status)

    def locked():
        return JSONResponse({"detail": "locked"}, 401)

    def remember(uid):
        if s.login_show_recent and uid is not None:
            recent.record(uid)

    async def run_poll(g: pa.Grant, gen: int, uid=None):
        out, body = await pa.poll_grant(pcall, g, unlock.clock, lambda: unlock.gen == gen)
        if out == "ok":
            remember(uid)
            return await unlock.start(body.get("user"), body["access_token"],
                                      str(body["token_id"]), gen)
        if out != "stale":
            unlock.set_flow({"reset": "locked"}.get(out, out))

    @app.post("/kiosk/unlock/start")
    async def unlock_start():
        if unlock.active():
            return unlock.snapshot()
        if not s.login_qr:
            return err("disabled", 403)
        gen0 = unlock.gen
        g, e = await pa.request_grant(pcall, s.kiosk_name, unlock.clock)
        if unlock.gen != gen0:  # locked/restarted meanwhile: drop the result
            return unlock.snapshot()
        if e:
            return JSONResponse({"error": {"code": e[0]}}, e[1], e[2])
        unlock.gen += 1  # stales any earlier poll
        unlock.set_flow("pending", qr_uri=pa.public_uri(s.papyrus_public_url, g.uri),
                        user_code=g.user_code, expires_in=int(g.expires_in))
        flow["task"] = asyncio.create_task(run_poll(g, unlock.gen))
        return unlock.snapshot()

    async def methods() -> dict:
        """Effective login methods: kiosk toggle AND what Papyrus reports as enabled."""
        pc = await pa.login_config(pcall)
        return {"qr": s.login_qr, "approve": s.login_approve and pc["approve"],
                "pin": s.login_pin and pc["pin"], "pin_length": pc["pin_length"]}

    @app.get("/kiosk/unlock/methods")
    async def unlock_methods():
        return await methods()

    def fold(x: str) -> str:
        return "".join(c for c in unicodedata.normalize("NFKD", x.casefold()) if not unicodedata.combining(c))

    async def all_users() -> list[dict] | None:
        """Papyrus user list, cached ~60s server-side; never sent to the browser whole."""
        now = time.monotonic()
        if ucache["users"] is not None and now - ucache["t"] < 60:
            return ucache["users"]
        users = await pa.list_users(pcall)
        if users is not None:
            ucache["users"], ucache["t"] = users, now
        return users if users is not None else ucache["users"]

    @app.get("/kiosk/unlock/users")
    async def unlock_users(q: str = "", mode: str = ""):
        m = await methods()
        if not m["approve"] and not m["pin"]:
            return err("disabled", 403)
        if q.strip() and not search_limiter.allow("q"):
            return err("rate_limited", 429)
        users = await all_users()
        if users is None:
            return err("upstream_unreachable", 502)
        q = fold(q.strip())
        if len(q) >= 2:
            out = [u for u in users if any(w.startswith(q) for w in fold(u["display_name"]).split())
                   or fold(u["display_name"]).startswith(q)]
        elif q:
            out = []
        elif s.login_show_recent:
            byid = {u["id"]: u for u in users}
            out = [byid[i] for i in recent.ids() if i in byid]
        else:
            out = []
        if mode == "pin":
            out = [u for u in out if u["has_pin"]]
        return out[:8]

    def good_user(v) -> bool:
        return isinstance(v, (str, int)) and not isinstance(v, bool) and bool(re.fullmatch(ID, str(v)))

    @app.post("/kiosk/unlock/approve")
    async def unlock_approve(body: dict):
        if unlock.active():
            return unlock.snapshot()
        if not (await methods())["approve"]:
            return err("disabled", 403)
        uid = body.get("user_id")
        if not good_user(uid):
            return err("bad_request", 400)
        gen0 = unlock.gen
        g, e = await pa.approve_request(pcall, str(uid), s.kiosk_name, unlock.clock)
        if unlock.gen != gen0:
            return unlock.snapshot()
        if e:
            if e[0] == "unknown_user":
                ucache["t"] = -1e9
            return JSONResponse({"error": {"code": e[0]}}, e[1], e[2])
        unlock.gen += 1
        unlock.set_flow("pending", match_code=g.match_code, expires_in=int(g.expires_in))
        flow["task"] = asyncio.create_task(run_poll(g, unlock.gen, str(uid)))
        return unlock.snapshot()

    @app.post("/kiosk/unlock/pin")
    async def unlock_pin(body: dict):
        if unlock.active():
            return unlock.snapshot()
        m = await methods()
        if not m["pin"]:
            return err("disabled", 403)
        uid, pin = body.get("user_id"), body.get("pin")
        if not good_user(uid) or not isinstance(pin, str) or not re.fullmatch(r"\d{1,12}", pin):
            return err("bad_request", 400)
        if not pin_limiter.allow("pin"):
            return err("rate_limited", 429)
        gen0 = unlock.gen
        r = await pa.pin_login(pcall, str(uid), pin, s.kiosk_name)
        if r is None:
            return err("upstream_unreachable", 502)
        try:
            d = r.json()
        except ValueError:
            d = {}
        d = d if isinstance(d, dict) else {}
        if isinstance(d.get("detail"), dict):
            d = {**d, **d["detail"]}
        if r.status_code == 200:
            if not d.get("access_token") or not d.get("token_id"):
                return err("upstream_error", 502)
            user = d.get("user")
            if not user:
                mr = await pcall("GET", pa.ME, d["access_token"])
                try:
                    user = mr.json() if mr is not None and mr.status_code == 200 else None
                except ValueError:
                    user = None
            if unlock.gen != gen0:  # locked/restarted meanwhile: drop the token
                await pa.revoke_token(pcall, d["access_token"], str(d["token_id"]))
                return unlock.snapshot()
            unlock.gen += 1  # stales any in-flight QR/approve poll
            remember(uid)
            await unlock.start(user, d["access_token"], str(d["token_id"]), unlock.gen)
            return unlock.snapshot()
        if r.status_code == 401:
            rem = d.get("remaining")
            return err("wrong_pin", 401, remaining=rem if isinstance(rem, int) else None)
        if r.status_code == 423:
            ra = d.get("retry_after")
            ra = ra if isinstance(ra, (int, float)) and not isinstance(ra, bool) else pa.retry_after(r)
            return JSONResponse({"error": {"code": "locked", "retry_after": ra}}, 423,
                                {"Retry-After": str(int(ra))})
        if r.status_code == 403:  # unknown user or no PIN set (same answer by design)
            ucache["t"] = -1e9
            return err("pin_unavailable", 403)
        if r.status_code == 429:
            return err("rate_limited", 429)
        return err("upstream_error", 502)

    @app.get("/kiosk/unlock/state")
    async def unlock_state():
        return unlock.snapshot()

    @app.post("/kiosk/unlock/touch")
    async def unlock_touch():
        unlock.touch()
        return unlock.snapshot()

    @app.post("/kiosk/lock")
    async def lock():
        await unlock.lock()
        return unlock.snapshot()

    def session_token(touch: bool = False):
        """Active session token (optionally touching it), or None."""
        if unlock.active():
            if touch:
                unlock.touch()
            return unlock.session.token
        return None

    # ---- send / print ----
    def bad_id(*vals) -> bool:
        return any(not isinstance(v, str) or not re.fullmatch(ID, v) for v in vals)

    async def user_contacts(token: str) -> list[dict] | None:
        r = await pcall("GET", "contacts", token)
        try:
            d = r.json() if r is not None and r.status_code == 200 else None
        except ValueError:
            return None
        return [c for c in d if isinstance(c, dict)] if isinstance(d, list) else None

    async def my_email(token: str) -> str | None:
        r = await pcall("GET", "auth/me", token)
        try:
            e = r.json().get("email") if r is not None and r.status_code == 200 else None
        except (ValueError, AttributeError):
            return None
        return e if isinstance(e, str) and e else None

    async def resolve_email(tgt: dict, token: str) -> str | None:
        """Address for {to:"me"} or {contact_id} (one of the user's own contacts); never free-form."""
        if tgt.get("to") == "me":
            return await my_email(token)
        cid = tgt.get("contact_id")
        if cid is None or isinstance(cid, bool):
            return None
        for c in await user_contacts(token) or []:
            if str(c.get("id")) == str(cid) and c.get("email"):
                return c["email"]
        return None

    async def send_one(scan_id: str, tgt: dict, token: str) -> dict:
        typ = tgt.get("type")
        res = {"type": typ, "ok": False}
        if typ == "paperless":
            r = await pcall("POST", PP["scan_paperless"].format(id=scan_id), token, 600)
        elif typ == "smb":
            if bad_id(tgt.get("share_id")):
                return {**res, "error": "bad_target"}
            r = await pcall("POST", PP["scan_smb"].format(id=scan_id), token, 600,
                            params={"share_id": tgt["share_id"], "remote_path": tgt.get("path", "")})
        elif typ == "cloud":
            if bad_id(tgt.get("provider_id")):
                return {**res, "error": "bad_target"}
            params = {"provider_id": tgt["provider_id"]}
            for k in ("folder_id", "path"):
                if tgt.get(k):
                    params[k] = tgt[k]
            r = await pcall("POST", PP["scan_cloud"].format(id=scan_id), token, 600, params=params)
        elif typ == "email":
            to = await resolve_email(tgt, token)
            if not to:
                return {**res, "error": "unknown_contact"}
            r = await pcall("POST", PP["scan_email"].format(id=scan_id), token, 120, json={
                "to": to, "subject": f"Scan from {s.kiosk_name}",
                "body": f"Scanned on {s.kiosk_name}."})
        else:
            return {**res, "error": "bad_target"}
        if r is None:
            return {**res, "error": "upstream_unreachable"}
        return {**res, "ok": r.is_success, "status": r.status_code}

    @app.get("/kiosk/contacts")
    async def kiosk_contacts():
        token = session_token()
        if not token:
            return locked()
        me, cs = await asyncio.gather(my_email(token), user_contacts(token))
        out = [{"id": "me", "name": f"Me ({me})" if me else "Me"}]
        out += [{"id": str(c["id"]), "name": c.get("name") or str(c["id"])}
                for c in cs or [] if c.get("id") is not None]
        return out

    @app.post("/kiosk/send/email")
    async def send_email(body: dict):
        token = session_token()
        if not token:
            return locked()
        sid = body.get("scan_id")
        if bad_id(sid):
            return err("bad_request", 400)
        tgt = {"type": "email", "to": body.get("to"), "contact_id": body.get("contact_id")}
        if body.get("to") is not None and body.get("to") != "me":
            return err("unknown_contact", 400)
        to = await resolve_email(tgt, token)
        if not to:
            return err("unknown_contact", 400)
        res = await send_one(sid, tgt, token)
        return JSONResponse(res, 200 if res["ok"] else 502)

    @app.post("/kiosk/send")
    async def send(body: dict):
        token = session_token(touch=True)
        if not token:
            return locked()
        sid = body.get("scan_id")
        targets = body.get("targets")
        if bad_id(sid) or not isinstance(targets, list) or not targets \
                or not all(isinstance(t, dict) for t in targets):
            return err("bad_request", 400)
        post = body.get("post")
        if post is None:
            post = {}
        if not isinstance(post, dict) or not all(
                v is None or isinstance(v, str) for t in targets
                for k, v in t.items() if k in TGT_STR):
            return err("bad_request", 400)
        for t in targets:
            if t.get("type") == "email" and (t.get("to") not in (None, "me")
                                             or not await resolve_email(t, token)):
                return err("unknown_contact", 400)
        async with unlock.busy():
            return await do_send(sid, targets, post, body, token)

    async def do_send(sid, targets, post, body, token):
        post_res = {}
        for step in ("ocr", "enhance"):
            if post.get(step):
                r = await pcall("POST", PP[f"scan_{step}"].format(id=sid), token, 600)
                post_res[step] = {"ok": bool(r is not None and r.is_success),
                                  "status": r.status_code if r is not None else None}
        if not all(v["ok"] for v in post_res.values()):
            return {"post": post_res, "results": [], "all_ok": False, "deleted": False}
        results = await asyncio.gather(*(send_one(sid, t, token) for t in targets))
        all_ok = all(x["ok"] for x in results)
        deleted = False
        if body.get("delete_after") and all_ok:
            r = await pcall("DELETE", PP["scan_delete"].format(id=sid), token)
            deleted = bool(r is not None and r.is_success)
        return {"post": post_res, "results": results, "all_ok": all_ok, "deleted": deleted}

    async def relay_print(*a):
        async with unlock.busy():
            return await _relay_print(*a)

    async def _relay_print(dl_path: str, dl_params: dict, token: str, filename: str,
                           copies: int, duplex: bool, media: str | None):
        """Stream the download from Papyrus into a temp file, then multipart-POST it as a job."""
        base = upstreams["papyrus"][0]
        cap = s.print_max_bytes
        try:
            Path(s.spool_dir).mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        with tempfile.SpooledTemporaryFile(max_size=8 << 20, dir=s.spool_dir) as f:
            try:
                async with app.state.client.stream(
                        "GET", f"{base}/api/v1/{dl_path}", params=dl_params, timeout=600,
                        headers={"Authorization": f"Bearer {token}"}) as dl:
                    if dl.status_code != 200:
                        return err("download_failed", 502, upstream_status=dl.status_code)
                    ctype = dl.headers.get("content-type", "application/octet-stream")
                    try:
                        if int(dl.headers.get("content-length", 0)) > cap:
                            return err("too_large", 413)
                    except ValueError:
                        pass
                    size = 0
                    async for chunk in dl.aiter_bytes():
                        size += len(chunk)
                        if size > cap:
                            return err("too_large", 413)
                        f.write(chunk)
            except httpx.HTTPError:
                return err("upstream_unreachable", 502)
            except OSError:
                return err("spool_failed", 500)
            f.seek(0)
            data = {"copies": str(copies), "duplex": "true" if duplex else "false"}
            if media:
                data["media"] = media
            r = await pcall("POST", PP["jobs_upload"], token, 600, data=data,
                            files={"file": (filename, f, ctype)})
        if r is None:
            return err("upstream_unreachable", 502)
        try:
            return JSONResponse(r.json(), r.status_code)
        except ValueError:
            return Response(status_code=r.status_code)

    def print_opts(body: dict):
        try:
            copies = max(1, min(99, int(body.get("copies", 1))))
        except (TypeError, ValueError):
            copies = 1
        media = body.get("media")
        return copies, bool(body.get("duplex")), media if isinstance(media, str) else None

    @app.post("/kiosk/print/remote")
    async def print_remote(body: dict):
        token = session_token(touch=True)
        if not token:
            return locked()
        src, ref, path = body.get("source"), body.get("ref"), body.get("path")
        if src not in ("smb", "cloud") or bad_id(ref) or not isinstance(path, str) or not path:
            return err("bad_request", 400)
        params = {"path": path}
        if src == "cloud" and isinstance(body.get("file_id"), str):
            params["file_id"] = body["file_id"]
        name = path.rstrip("/").rsplit("/", 1)[-1] or "file"
        return await relay_print(PP[f"{src}_download"].format(id=ref), params, token, name,
                                 *print_opts(body))

    @app.post("/kiosk/print/scan/{scan_id}")
    async def print_scan(scan_id: str, body: dict | None = None):
        token = session_token(touch=True)
        if not token:
            return locked()
        if bad_id(scan_id):
            return err("bad_request", 400)
        return await relay_print(PP["scan_download"].format(id=scan_id), {}, token,
                                 f"{scan_id}.pdf", *print_opts(body or {}))

    @app.get("/kiosk/screen")
    async def screen_state():
        return {**scr.state(), "config_rev": store.rev}  # web: refetch /kiosk/config when this changes

    @app.post("/kiosk/screen/brightness/{n}")
    async def brightness(n: int):
        try:
            scr.set_brightness(n)
        except NoBrightness:
            return JSONResponse({"error": {"code": "no_brightness"}}, 503)
        return Response(status_code=204)

    @app.post("/kiosk/screen/{state}")
    async def screen(state: str):
        if state not in ("on", "off"):
            return JSONResponse({"error": {"code": "not_found"}}, 404)
        try:
            scr.set_on(state == "on")
        except NoBacklight:
            return JSONResponse({"error": {"code": "no_backlight"}}, 503)
        except OSError:
            return JSONResponse({"error": {"code": "backlight_write_failed"}}, 500)
        return Response(status_code=204)

    async def proxy(name: str, path: str, request: Request) -> Response:
        method = request.method
        pbase, token = upstreams[name]
        if name == "labels" and not pbase:
            return JSONResponse({"error": {"code": "not_configured"}}, 503)
        params = request.query_params.multi_items()
        if not any(p.fullmatch(path) for p in ALLOW[name].get(method, [])):
            return JSONResponse({"error": {"code": "not_found"}}, 404)
        utok = session_token(touch=method in ("POST", "PUT", "DELETE"))
        if not utok:
            return locked()
        if name == "papyrus":
            token = utok
            if method == "GET" and path == "scans":
                params = [(k, v) for k, v in params if k != "mine"] + [("mine", "true")]
        headers = {k: v for k, v in request.headers.items() if k.lower() not in DROP_REQ}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        timeout = 600 if name == "papyrus" and method == "POST" and \
            any(p.fullmatch(path) for p in LONG) else 15
        try:
            http = request.app.state.labels if name == "labels" else request.app.state.client
            r = await http.request(
                method, f"{pbase}/api/v1/{path}",
                params=params,
                content=await request.body() if method == "POST" else None,
                headers=headers, timeout=timeout, follow_redirects=False,
            )
        except httpx.TimeoutException:
            return JSONResponse({"error": {"code": "upstream_timeout"}}, 504)
        except httpx.HTTPError:
            return JSONResponse({"error": {"code": "upstream_unreachable"}}, 502)
        if 300 <= r.status_code < 400:
            return JSONResponse({"error": {"code": "upstream_redirect"}}, 502)
        if name == "papyrus" and r.status_code == 401:
            await unlock.lock()  # user token revoked (e.g. user deactivated): end the session
            return locked()
        drop = DROP_RESP | {
            tok.strip().lower()
            for v in r.headers.get_list("connection") for tok in v.split(",") if tok.strip()
        }
        if name == "papyrus" and method == "POST" and path in ("scans", "copy"):
            try:
                await refresh_devices()  # clear "Busy" before the client re-reads status
            except Exception:
                log.exception("device refresh failed")
        resp = Response(r.content, r.status_code)
        for k, v in r.headers.multi_items():
            if k.lower() not in drop:
                resp.headers.append(k, v)
        return resp

    @app.api_route("/papyrus/{path:path}", methods=["GET", "POST", "DELETE"])
    async def papyrus(path: str, request: Request):
        return await proxy("papyrus", path, request)

    @app.api_route("/labels/{path:path}", methods=["GET", "POST"])
    async def labels(path: str, request: Request):
        return await proxy("labels", path, request)

    static = Path(s.static_dir)

    @app.get("/{path:path}")
    async def spa(path: str):
        if path.split("/")[0] in ("papyrus", "labels", "kiosk"):
            return JSONResponse({"error": {"code": "not_found"}}, 404)
        root = static.resolve()
        if not root.is_dir():
            return JSONResponse({"error": {"code": "static_missing"}}, 404)
        f = (root / path).resolve()
        if path and f != (root / "admin.html").resolve() and f.is_file() \
                and f.is_relative_to(root):
            return FileResponse(f)
        index = root / "index.html"
        if index.is_file():
            return FileResponse(index)
        return JSONResponse({"error": {"code": "not_found"}}, 404)

    return app
