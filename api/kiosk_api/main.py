import asyncio
import logging
import re
import time
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse

from . import mqtt
from .config import Settings
from . import papyrus_auth as pa
from .settings_store import SettingsStore, effective, refresh_cache
from .session import Unlock
from .screen import NoBacklight, NoBrightness, Screen
from .stats import Stats

log = logging.getLogger("kiosk.api")
ID = r"[A-Za-z0-9-]+"


def _c(*pats: str) -> list[re.Pattern]:
    return [re.compile(p.replace("{id}", ID)) for p in pats]


ALLOW_LOCKED = {
    "papyrus": {
        "GET": _c(
            "system/health", "printers/default/status", "scanners/default/status",
            "scanners/default/options", "scan-profiles", "scans",
            "scans/{id}/thumbnail", "scans/{id}/download", "jobs", "jobs/{id}/thumbnail",
        ),
        "POST": _c("scans", "copy", "jobs/{id}/release", "jobs/{id}/cancel"),
    },
    "labels": {
        "GET": _c("health", "presets", "printer/status", "history",
                  "history/{id}/thumbnail", "print/jobs/{id}"),
        "POST": _c("presets/{id}/print", "history/{id}/reprint",
                   "print/jobs/{id}/cancel"),
    },
}
# Need an unlock session; the user's token is injected. Email is never proxied.
ALLOW_UNLOCKED = {
    "papyrus": {
        "GET": _c(
            "smb/shares", "smb/browse/{id}", "smb/download/{id}", "cloud/providers",
            "cloud/files/{id}", "cloud/download/{id}", "email/config",
        ),
        "POST": _c("scans/{id}/(?:smb|cloud|paperless|ocr|enhance|backs)",
                   "scans/collate", "jobs/upload"),
        "DELETE": _c("scans/{id}"),
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
TGT_STR = {"type", "share_id", "provider_id", "contact_id", "path", "folder_id"}
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
    started = time.time()
    last_papyrus: dict = {"t": None}

    scr = Screen(s.backlight_path)
    unlock = Unlock(s.unlock_idle_s, s.unlock_max_s)
    flow: dict = {"task": None}
    contacts: dict = {}
    upstreams: dict = {}

    def apply_settings():
        """Re-derive effective settings; closures below read s/contacts/upstreams live."""
        nonlocal s, contacts
        s = effective(base, store.current())
        contacts = {c["id"]: c for c in s.contacts()}
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
    app.state.store, app.state.base = store, base
    app.state.on_change = on_change
    store.applier = on_change
    app.state.effective = lambda: s
    app.state.mgr, app.state.screen = mgr, scr
    app.state.started, app.state.last_papyrus = started, last_papyrus
    app.state.call = pcall
    app.state.refresh = lambda: refresh_cache(store, pcall)

    @app.get("/kiosk/config")
    async def config():
        return {
            "config_rev": store.rev,
            "idle_minutes": s.idle_minutes,
            "name": s.kiosk_name,
            "public_url": s.papyrus_public_url.rstrip("/"),
            "unlock": {"idle_s": s.unlock_idle_s, "max_s": s.unlock_max_s},
            "presets": s.presets(),
            "smb_shares": s.shares,
            "contacts": [{"id": c["id"], "name": c.get("name") or c["id"]} for c in contacts.values()],
            "destinations": {
                "paperless": s.scan_paperless,
                "smb": {"share_id": s.scan_smb_share_id, "path": s.scan_smb_path}
                if s.scan_smb_share_id else None,
                "cloud": {"provider_id": s.scan_cloud_provider_id}
                if s.scan_cloud_provider_id else None,
                "email": {"to": s.scan_email_to} if s.scan_email_to else None,
            },
        }

    # ---- unlock ----
    def err(code: str, status: int, **kw):
        return JSONResponse({"error": {"code": code, **kw}}, status)

    def locked():
        return JSONResponse({"detail": "locked"}, 401)

    async def run_poll(g: pa.Grant, gen: int):
        out, body = await pa.poll_grant(pcall, g, unlock.clock, lambda: unlock.gen == gen)
        if out == "ok":
            return await unlock.start(body.get("user"), body["access_token"],
                                      str(body["token_id"]), gen)
        if out != "stale":
            unlock.set_flow({"reset": "locked"}.get(out, out))

    @app.post("/kiosk/unlock/start")
    async def unlock_start():
        if unlock.active():
            return unlock.snapshot()
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

    def session_token():
        """Active session token (touching it), or None."""
        if unlock.active():
            unlock.touch()
            return unlock.session.token
        return None

    # ---- send / print ----
    def bad_id(*vals) -> bool:
        return any(not isinstance(v, str) or not re.fullmatch(ID, v) for v in vals)

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
            c = contacts.get(tgt.get("contact_id"))
            if not c:
                return {**res, "error": "unknown_contact"}
            r = await pcall("POST", PP["scan_email"].format(id=scan_id), token, 120, json={
                "to": c["email"], "subject": f"Scan from {s.kiosk_name}",
                "body": f"Scanned on {s.kiosk_name}."})
        else:
            return {**res, "error": "bad_target"}
        if r is None:
            return {**res, "error": "upstream_unreachable"}
        return {**res, "ok": r.is_success, "status": r.status_code}

    @app.post("/kiosk/send/email")
    async def send_email(body: dict):
        token = session_token()
        if not token:
            return locked()
        sid = body.get("scan_id")
        if bad_id(sid):
            return err("bad_request", 400)
        if body.get("contact_id") not in contacts:
            return err("unknown_contact", 400)
        res = await send_one(sid, {"type": "email", "contact_id": body["contact_id"]}, token)
        return JSONResponse(res, 200 if res["ok"] else 502)

    @app.post("/kiosk/send")
    async def send(body: dict):
        token = session_token()
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

    async def relay_print(dl_path: str, dl_params: dict, token: str, filename: str,
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
        token = session_token()
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
        token = session_token()
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
        if any(p.fullmatch(path) for p in ALLOW_LOCKED[name].get(method, [])):
            if name == "papyrus":
                sess = unlock.active()
                if sess:  # session token for every call; shared token only when locked
                    token = sess.token
                if method == "GET" and path == "scans":
                    session_token()
                    params = [(k, v) for k, v in params if k != "mine"] + [("mine", "true")]
        elif any(p.fullmatch(path) for p in ALLOW_UNLOCKED.get(name, {}).get(method, [])):
            token = session_token()
            if not token:
                return locked()
        else:
            return JSONResponse({"error": {"code": "not_found"}}, 404)
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
        drop = DROP_RESP | {
            tok.strip().lower()
            for v in r.headers.get_list("connection") for tok in v.split(",") if tok.strip()
        }
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
        if path and path != "admin.html" and f.is_file() and f.is_relative_to(root):
            return FileResponse(f)
        index = root / "index.html"
        if index.is_file():
            return FileResponse(index)
        return JSONResponse({"error": {"code": "not_found"}}, 404)

    return app
