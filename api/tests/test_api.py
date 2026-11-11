import httpx
import pytest
import respx

from kiosk_api.config import Settings
from kiosk_api.main import create_app

from conftest import force_unlock

P, L = "http://pap.test", "http://lm.test"


@pytest.fixture
def env(tmp_path):
    bl = tmp_path / "bl"
    (bl / "dev0").mkdir(parents=True)
    st = tmp_path / "static"
    st.mkdir()
    (st / "index.html").write_text("<html>spa</html>")
    (st / "a.js").write_text("js")
    s = Settings(papyrus_url=P, papyrus_token="PTOK", labelmaker_url=L,
                 labelmaker_token="LTOK", idle_minutes=7,
                 backlight_path=str(bl), static_dir=str(st))
    return s, bl


async def _mk(env, unlocked):
    app = create_app(env[0])
    async with app.router.lifespan_context(app):
        if unlocked:
            force_unlock(app)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://k") as c:
            yield c


@pytest.fixture
async def client(env):  # unlocked session
    async for c in _mk(env, True):
        yield c


@pytest.fixture
async def locked_client(env):
    async for c in _mk(env, False):
        yield c


@pytest.mark.parametrize("path", [
    "/papyrus/system/health", "/papyrus/scans/ab-1/thumbnail", "/papyrus/jobs",
    "/labels/presets", "/labels/print/jobs/x1", "/labels/history/9/thumbnail"])
@respx.mock
async def test_allowed_get(client, path):
    up = P if path.startswith("/papyrus") else L
    route = respx.get(f"{up}/api/v1/{path.split('/', 2)[2]}").respond(200, json={"ok": 1})
    r = await client.get(path)
    assert r.status_code == 200 and route.called


@pytest.mark.parametrize("method,path", [
    ("GET", "/papyrus/admin"), ("POST", "/papyrus/system/health"),
    ("GET", "/papyrus/scans/../admin"), ("GET", "/papyrus/scans/%2e%2e/admin/thumbnail"),
    ("GET", "/papyrus/scans/a%2f..%2fb/thumbnail"), ("GET", "/papyrus/scans/a.b/thumbnail"),
    ("POST", "/labels/presets"), ("GET", "/labels/presets/1/print"),
    ("POST", "/papyrus/scans/x/ftp"), ("GET", "/labels/%2e%2e/health"),
    ("DELETE", "/labels/presets")])
@respx.mock
async def test_denied(client, method, path):
    r = await client.request(method, path)
    assert r.status_code in (404, 405)
    assert not respx.calls


@pytest.mark.parametrize("path,tok", [("/papyrus/jobs", "UTOK"), ("/labels/health", "LTOK")])
@respx.mock
async def test_token_and_scrub(client, path, tok):
    up = P if "papyrus" in path else L
    route = respx.get(f"{up}/api/v1/{path.split('/', 2)[2]}").respond(
        200, json={"a": 1}, headers={"Set-Cookie": "s=1", "X-Keep": "y"})
    r = await client.get(path, headers={"Authorization": "Bearer evil", "Cookie": "c=1"})
    sent = route.calls[0].request.headers
    assert sent["authorization"] == f"Bearer {tok}"
    assert "cookie" not in sent
    assert "set-cookie" not in r.headers and r.headers["x-keep"] == "y"
    assert "TOK" not in r.text and all("TOK" not in v for v in r.headers.values())


@respx.mock
async def test_query_and_post_body(client):
    g = respx.get(f"{P}/api/v1/jobs").respond(200, json={})
    await client.get("/papyrus/jobs?limit=5&offset=2&x=a&x=b")
    assert g.calls[0].request.url.query == b"limit=5&offset=2&x=a&x=b"
    p = respx.post(f"{P}/api/v1/jobs/j1/release").respond(204)
    r = await client.post("/papyrus/jobs/j1/release", json={"pin": "1234"})
    assert r.status_code == 204 and b"1234" in p.calls[0].request.content


@respx.mock
async def test_status_passthrough(client):
    respx.get(f"{P}/api/v1/scans").respond(422, json={"detail": "x", "code": "bad"})
    r = await client.get("/papyrus/scans")
    assert r.status_code == 422 and r.json()["code"] == "bad"


@respx.mock
async def test_binary(client):
    data = bytes(range(256)) * 4
    respx.get(f"{L}/api/v1/history/1/thumbnail").respond(
        200, content=data, headers={"content-type": "image/png"})
    r = await client.get("/labels/history/1/thumbnail")
    assert r.content == data and r.headers["content-type"] == "image/png"


@respx.mock
async def test_502(client):
    respx.get(f"{P}/api/v1/jobs").mock(side_effect=httpx.ConnectError("no"))
    r = await client.get("/papyrus/jobs")
    assert r.status_code == 502
    assert r.json() == {"error": {"code": "upstream_unreachable"}}


@respx.mock
async def test_long_timeout(client):
    route = respx.post(f"{P}/api/v1/copy").respond(200, json={})
    await client.post("/papyrus/copy", json={})
    assert route.calls[0].request.extensions["timeout"]["read"] == 600
    route = respx.post(f"{L}/api/v1/presets/1/print").respond(200, json={})
    await client.post("/labels/presets/1/print")
    assert route.calls[0].request.extensions["timeout"]["read"] == 15


@pytest.mark.parametrize("state,val", [("on", "0"), ("off", "1")])
async def test_screen(client, env, state, val):
    r = await client.post(f"/kiosk/screen/{state}")
    assert r.status_code == 204
    assert (env[1] / "dev0" / "bl_power").read_text() == val


async def test_screen_bad(client):
    assert (await client.post("/kiosk/screen/dim")).status_code == 404


async def test_config(client):
    assert (await client.get("/kiosk/config")).json()["idle_minutes"] == 7


async def test_spa(client):
    assert (await client.get("/")).text == "<html>spa</html>"
    assert (await client.get("/some/route")).text == "<html>spa</html>"
    assert (await client.get("/a.js")).text == "js"
    assert (await client.get("/../../etc/passwd")).text == "<html>spa</html>"


async def test_missing_static(tmp_path):
    app = create_app(Settings(static_dir=str(tmp_path / "nope")))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://k") as c:
        assert (await c.get("/x")).status_code == 404


@respx.mock
async def test_timeout_504(client):
    respx.get(f"{P}/api/v1/jobs").mock(side_effect=httpx.ReadTimeout("t"))
    r = await client.get("/papyrus/jobs")
    assert r.status_code == 504 and r.json() == {"error": {"code": "upstream_timeout"}}


@respx.mock
async def test_redirect_502(client):
    route = respx.get(f"{P}/api/v1/jobs").respond(302, headers={"Location": "http://evil/"})
    r = await client.get("/papyrus/jobs")
    assert r.status_code == 502 and "location" not in r.headers
    assert r.json() == {"error": {"code": "upstream_redirect"}}
    assert route.call_count == 1


@respx.mock
async def test_multi_headers_preserved(client):
    respx.get(f"{P}/api/v1/jobs").respond(
        200, headers=[("X-Multi", "a"), ("X-Multi", "b")], json={})
    r = await client.get("/papyrus/jobs")
    assert r.headers.get_list("x-multi") == ["a", "b"]


@respx.mock
async def test_hop_by_hop_stripped(client):
    respx.get(f"{P}/api/v1/jobs").respond(200, json={}, headers=[
        ("Connection", "X-Foo"), ("X-Foo", "1"), ("Keep-Alive", "t=1"), ("TE", "x"),
        ("Trailer", "x"), ("Upgrade", "h2c"), ("Proxy-Authenticate", "x"),
        ("Proxy-Authorization", "x"), ("Set-Cookie", "a=b"), ("X-Keep", "ok")])
    r = await client.get("/papyrus/jobs")
    for h in ("x-foo", "keep-alive", "te", "trailer", "upgrade", "proxy-authenticate",
              "proxy-authorization", "set-cookie"):
        assert h not in r.headers, h
    assert r.headers["x-keep"] == "ok"


async def test_config_destinations(client, locked_client, env):
    assert "destinations" not in (await locked_client.get("/kiosk/config")).json()
    d = (await client.get("/kiosk/config")).json()
    assert d["destinations"] == {"paperless": True, "smb": None, "cloud": None}
    s = env[0].model_copy(update={
        "scan_paperless": False, "scan_smb_share_id": "s1", "scan_smb_path": "/x",
        "scan_cloud_provider_id": "c1", "scan_email_to": "a@b.c"})
    app = create_app(s)
    force_unlock(app)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://k") as c:
        d = (await c.get("/kiosk/config")).json()
    assert d["destinations"] == {"paperless": False, "smb": {"share_id": "s1", "path": "/x"},
                                 "cloud": {"provider_id": "c1"}}


def test_module_exposes_factory():
    import kiosk_api.main as m
    assert callable(m.create_app) and not hasattr(m, "app")


@pytest.mark.parametrize("method,path", [
    ("POST", "/papyrus/scans"), ("POST", "/papyrus/copy"), ("GET", "/papyrus/jobs"),
    ("GET", "/papyrus/printers/default/status"), ("GET", "/papyrus/system/health"),
    ("GET", "/labels/presets"), ("POST", "/labels/presets/1/print"),
    ("GET", "/labels/printer/status"), ("POST", "/kiosk/print/remote"),
    ("POST", "/kiosk/print/scan/a1"), ("POST", "/kiosk/send")])
@respx.mock
async def test_locked_is_401(locked_client, method, path):
    r = await locked_client.request(method, path, json={})
    assert r.status_code == 401 and r.json() == {"detail": "locked"}
    assert not respx.calls


@respx.mock
async def test_unlocked_passes_with_tokens(client):
    p = respx.post(f"{P}/api/v1/copy").respond(200, json={})
    j = respx.get(f"{P}/api/v1/jobs").respond(200, json={})
    lb = respx.get(f"{L}/api/v1/presets").respond(200, json=[])
    for m, u in (("POST", "/papyrus/copy"), ("GET", "/papyrus/jobs"), ("GET", "/labels/presets")):
        assert (await client.request(m, u)).status_code == 200
    assert p.calls[0].request.headers["authorization"] == "Bearer UTOK"
    assert j.calls[0].request.headers["authorization"] == "Bearer UTOK"
    assert lb.calls[0].request.headers["authorization"] == "Bearer LTOK"


@respx.mock
async def test_locked_status_only_two_booleans(locked_client):
    pr = respx.get(f"{P}/api/v1/printers/default/status").respond(
        200, json={"state": 3, "accepting_jobs": True, "secret": "x"})
    respx.get(f"{P}/api/v1/scanners/default/status").respond(
        200, json={"available": True, "busy": False, "device": "usb:1"})
    r = await locked_client.get("/kiosk/status")
    assert r.json() == {"printer_ready": True, "scanner_ready": True}
    assert pr.calls[0].request.headers["authorization"] == "Bearer PTOK"
    assert len(pr.calls) == 1
    # served from the cache: a later upstream change shows only after a refresh
    sc = respx.get(f"{P}/api/v1/scanners/default/status").respond(
        200, json={"available": False, "busy": False})
    assert (await locked_client.get("/kiosk/status")).json()["scanner_ready"] is True
    assert len(sc.calls) == 1
    await locked_client._transport.app.state.refresh_devices()
    assert (await locked_client.get("/kiosk/status")).json() == {
        "printer_ready": True, "scanner_ready": False}


@respx.mock
async def test_devices_cached_and_stale(client, locked_client):
    assert (await locked_client.get("/kiosk/devices")).status_code == 401
    pr = respx.get(f"{P}/api/v1/printers/default/status").respond(200, json={"state": 3})
    sc = respx.get(f"{P}/api/v1/scanners/default/status").respond(
        200, json={"available": True, "busy": False})
    d = (await client.get("/kiosk/devices")).json()
    assert d["printer"] == {"state": 3} and d["printer_stale"] is False and d["printer_age_s"] == 0
    await client.get("/kiosk/devices")
    assert len(pr.calls) == 1 and len(sc.calls) == 1  # second read is cache-only
    sc.respond(500)
    await client._transport.app.state.refresh_devices()
    d = (await client.get("/kiosk/devices")).json()
    assert d["scanner_stale"] is True and d["scanner"] == {"available": True, "busy": False}
    assert d["printer_stale"] is False and d["printer"] == {"state": 3}


@pytest.mark.parametrize("method,path", [
    ("GET", "/papyrus/scans/s-1"), ("POST", "/papyrus/scans/s-1/cancel"),
    ("GET", "/papyrus/copy/c-1"), ("POST", "/papyrus/copy/c-1/cancel")])
@respx.mock
async def test_progress_cancel_allowed(client, method, path):
    r = respx.route(method=method, url=f"{P}/api/v1{path[len('/papyrus'):]}").respond(
        200, json={"progress_pct": 40})
    assert (await client.request(method, path)).status_code == 200 and r.called


async def test_admin_html_not_served_via_path_variants(env):
    s = env[0]
    (__import__("pathlib").Path(s.static_dir) / "admin.html").write_text("ADMIN")
    async for c in _mk(env, False):
        for p in ("/admin.html", "/./admin.html", "/%2e/admin.html", "/x/../admin.html",
                  "/%2e%2e/%2e%2e/etc/passwd"):
            r = await c.get(p)
            assert "ADMIN" not in r.text and "root:" not in r.text, p
        assert (await c.get("/a.js")).text == "js"


@respx.mock
async def test_post_scan_refreshes_devices(client):
    respx.post(f"{P}/api/v1/scans").respond(200, json={})
    sc = respx.get(f"{P}/api/v1/scanners/default/status").respond(200, json={"busy": False})
    respx.get(f"{P}/api/v1/printers/default/status").respond(200, json={})
    await client.post("/papyrus/scans")
    assert len(sc.calls) == 1
