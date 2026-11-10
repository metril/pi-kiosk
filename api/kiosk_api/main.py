import re
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse

from .config import Settings

ID = r"[A-Za-z0-9-]+"


def _c(*pats: str) -> list[re.Pattern]:
    return [re.compile(p.replace("{id}", ID)) for p in pats]


ALLOW = {
    "papyrus": {
        "GET": _c(
            "system/health", "printers/default/status", "scanners/default/status",
            "scanners/default/options", "scan-profiles", "scans",
            "scans/{id}/thumbnail", "jobs", "jobs/{id}/thumbnail",
        ),
        "POST": _c(
            "scans", "copy", "jobs/{id}/release", "jobs/{id}/cancel",
            "scans/{id}/(?:smb|email|cloud|paperless)",
        ),
    },
    "labels": {
        "GET": _c("health", "presets", "printer/status", "history",
                  "history/{id}/thumbnail", "print/jobs/{id}"),
        "POST": _c("presets/{id}/print", "history/{id}/reprint",
                   "print/jobs/{id}/cancel"),
    },
}
LONG = [re.compile("copy"), re.compile("scans")]
DROP_REQ = {"authorization", "cookie", "host", "content-length", "connection",
            "transfer-encoding", "accept-encoding"}
HOP = {"connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade",
       "proxy-authenticate", "proxy-authorization"}
DROP_RESP = HOP | {"set-cookie", "content-length", "content-encoding", "location"}


def create_app(settings: Settings | None = None) -> FastAPI:
    s = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with httpx.AsyncClient(timeout=15) as client:
            app.state.client = client
            yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    upstreams = {
        "papyrus": (s.papyrus_url.rstrip("/"), s.papyrus_token),
        "labels": (s.labelmaker_url.rstrip("/"), s.labelmaker_token),
    }

    @app.get("/kiosk/config")
    async def config():
        return {
            "idle_minutes": s.idle_minutes,
            "destinations": {
                "paperless": s.scan_paperless,
                "smb": {"share_id": s.scan_smb_share_id, "path": s.scan_smb_path}
                if s.scan_smb_share_id else None,
                "cloud": {"provider_id": s.scan_cloud_provider_id}
                if s.scan_cloud_provider_id else None,
                "email": {"to": s.scan_email_to} if s.scan_email_to else None,
            },
        }

    @app.post("/kiosk/screen/{state}")
    async def screen(state: str):
        if state not in ("on", "off"):
            return JSONResponse({"error": {"code": "not_found"}}, 404)
        devs = sorted(p for p in Path(s.backlight_path).glob("*") if p.is_dir()) \
            if Path(s.backlight_path).is_dir() else []
        if not devs:
            return JSONResponse({"error": {"code": "no_backlight"}}, 503)
        try:
            (devs[0] / "bl_power").write_text("0" if state == "on" else "1")
        except OSError:
            return JSONResponse({"error": {"code": "backlight_write_failed"}}, 500)
        return Response(status_code=204)

    async def proxy(name: str, path: str, request: Request) -> Response:
        method = request.method
        if not any(p.fullmatch(path) for p in ALLOW[name].get(method, [])):
            return JSONResponse({"error": {"code": "not_found"}}, 404)
        base, token = upstreams[name]
        headers = {k: v for k, v in request.headers.items() if k.lower() not in DROP_REQ}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        timeout = 600 if name == "papyrus" and method == "POST" and \
            any(p.fullmatch(path) for p in LONG) else 15
        try:
            r = await request.app.state.client.request(
                method, f"{base}/api/v1/{path}",
                params=request.query_params.multi_items(),
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

    @app.api_route("/papyrus/{path:path}", methods=["GET", "POST"])
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
        if path and f.is_file() and f.is_relative_to(root):
            return FileResponse(f)
        index = root / "index.html"
        if index.is_file():
            return FileResponse(index)
        return JSONResponse({"error": {"code": "not_found"}}, 404)

    return app
