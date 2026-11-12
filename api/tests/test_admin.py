import asyncio
import os
import stat

import httpx
import pytest
import respx

from kiosk_api import admin_tls, mqtt
from kiosk_api.admin import create_admin_app
from kiosk_api.config import Settings
from kiosk_api.main import create_app

P, L = "http://pap.test", "http://lm.test"
H = {"X-Kiosk-Admin": "1"}
API = f"{P}/api/v1"


class Clock:
    t = 1000.0

    def __call__(self):
        return self.t


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def started(monkeypatch):
    out = []

    async def fake(s, *a):
        out.append(s)
        await asyncio.Event().wait()
    monkeypatch.setattr(mqtt, "run", fake)
    return out


@pytest.fixture
async def env(tmp_path, clock, started):
    (tmp_path / "static" / "assets").mkdir(parents=True)
    (tmp_path / "static" / "index.html").write_text("kiosk spa")
    (tmp_path / "static" / "admin.html").write_text("admin spa")
    s = Settings(papyrus_url=P, papyrus_token="SHARED", labelmaker_url=L, labelmaker_token="LT",
                 backlight_path=str(tmp_path), static_dir=str(tmp_path / "static"),
                 settings_path=str(tmp_path / "cfg" / "settings.json"))
    kiosk = create_app(s)
    adm = create_admin_app(kiosk, tls=False, cookie_secure=False, clock=clock)
    async with kiosk.router.lifespan_context(kiosk), adm.router.lifespan_context(adm):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=adm),
                                     base_url="http://admin.test") as c:
            with respx.mock:
                respx.get(f"{API}/contacts").respond(200, json=[{"id": "a", "name": "Al", "email": "a@x"}])
                respx.get(f"{API}/smb/shares").respond(200, json=[{"id": "1", "name": "S"}])
                yield c, kiosk, adm, s


def grant(role="admin", interval=0):
    respx.post(f"{API}/auth/device/code").respond(200, json={
        "device_code": "d", "user_code": "AB-12", "verification_uri": f"{P}/v",
        "verification_uri_complete": f"{P}/v?c=AB-12", "expires_in": 300, "interval": interval})
    respx.post(f"{API}/auth/device/token").respond(200, json={
        "access_token": "AT", "token_id": "7"})
    respx.get(f"{API}/auth/me").respond(200, json={"id": 1, "email": "u@x", "role": role})
    return respx.delete(f"{API}/auth/tokens/7").respond(204)


async def login(c, role="admin"):
    rev = grant(role)
    r = await c.post("/admin/api/login/start", headers=H)
    assert r.status_code == 200 and r.json()["user_code"] == "AB-12"
    lid = r.json()["login_id"]
    for _ in range(100):
        st = (await c.get(f"/admin/api/login/{lid}")).json()["state"]
        if st != "pending":
            return st, rev
        await asyncio.sleep(0.01)
    raise AssertionError("login stuck")


async def test_non_admin_denied_and_revoked(env):
    c, *_ = env
    st, revoke = await login(c, "user")
    assert st == "forbidden" and revoke.call_count == 1
    assert revoke.calls[0].request.headers["authorization"] == "Bearer AT"
    assert (await c.get("/admin/api/settings")).status_code == 401


async def test_admin_login_cookie_flags_and_headers(env):
    _, kiosk, _, _ = env
    adm = create_admin_app(kiosk, tls=True)
    async with adm.router.lifespan_context(adm):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=adm),
                                     base_url="https://admin.test") as c:
            grant()
            lid = (await c.post("/admin/api/login/start", headers=H)).json()["login_id"]
            for _ in range(100):
                r = await c.get(f"/admin/api/login/{lid}")
                if r.json()["state"] != "pending":
                    break
                await asyncio.sleep(0.01)
            ck = r.headers["set-cookie"]
            assert r.json()["state"] == "ok"
            assert "HttpOnly" in ck and "Secure" in ck and "SameSite=strict" in ck
            r = await c.get("/admin/api/settings")
            assert r.status_code == 200
            assert r.headers["cache-control"] == "no-store"
            assert "frame-ancestors 'none'" in r.headers["content-security-policy"]
            assert "default-src 'self'" in r.headers["content-security-policy"]
            assert r.headers["x-frame-options"] == "DENY"


async def test_session_idle_and_max_expiry(env, clock):
    c, *_ = env
    st, revoke = await login(c)
    assert st == "ok" and (await c.get("/admin/api/settings")).status_code == 200
    clock.t += 899
    assert (await c.get("/admin/api/settings")).status_code == 200  # touch resets idle
    clock.t += 901
    assert (await c.get("/admin/api/settings")).status_code == 401
    assert revoke.call_count == 1  # token revoked on expiry
    # max lifetime: activity every 10 min still ends at 60 min
    await login(c)
    for _ in range(5):
        clock.t += 600
        assert (await c.get("/admin/api/settings")).status_code == 200
    clock.t += 700
    assert (await c.get("/admin/api/session")).status_code == 401
    assert revoke.call_count == 2


async def test_logout_revokes(env):
    c, *_ = env
    _, revoke = await login(c)
    assert (await c.post("/admin/api/logout", headers=H)).status_code == 200
    assert revoke.call_count == 1
    assert (await c.get("/admin/api/session")).status_code == 401


async def test_csrf_header_required(env):
    c, *_ = env
    await login(c)
    for m, p in [("PUT", "/admin/api/settings"), ("POST", "/admin/api/screen/reload"),
                 ("POST", "/admin/api/logout"), ("POST", "/admin/api/login/start"),
                 ("POST", "/admin/api/mqtt/test")]:
        r = await c.request(m, p, json={"config": {}})
        assert r.status_code == 403, p
    assert (await c.post("/admin/api/screen/reload", headers=H)).status_code == 200
    assert (await c.get("/admin/api/settings")).status_code == 200  # reads need no header


async def test_secret_masking_keep_clear_set(env):
    c, kiosk, *_ = env
    await login(c)
    d = (await c.get("/admin/api/settings")).json()
    assert d["persisted"] is False and d["config"]["labelmaker"]["token"] == {"set": True}
    cfg = d["config"]
    cfg["mqtt"] = {"host": "b", "password": "pw"}

    async def put(**lm):
        body = {**cfg, "labelmaker": {"url": L, **lm}}
        r = await c.put("/admin/api/settings", headers=H, json={"config": body})
        assert r.status_code == 200, r.text
        return r.json()["config"], kiosk.state.store.current().config.labelmaker.token

    out, tok = await put(token={"set": True})  # {set:true} keeps the env-seeded key
    assert tok == "LT" and out["labelmaker"]["token"] == {"set": True}
    assert "LT" not in str(out) and "pw" not in str(out)
    assert (await put())[1] == "LT"  # omitted keeps
    assert (await put(token="NEW"))[1] == "NEW"
    assert (await put(token=""))[1] == ""
    out, tok = await put(token="X")
    assert (await put(token=None))[1] == "" and (await put(token=None))[0]["labelmaker"]["token"] == {"set": False}
    assert kiosk.state.store.current().config.mqtt.password == "pw"  # untouched mqtt secret kept
    bad = await c.put("/admin/api/settings", headers=H, json={"config": {"unlock": {"idle_s": "x"}}})
    assert bad.status_code == 422


async def test_kiosk_routes_absent(env):
    c, *_ = env
    for p in ["/papyrus/system/health", "/kiosk/config", "/labels/health", "/kiosk/unlock/state",
              "/index.html", "/assets/../index.html"]:
        assert (await c.get(p)).status_code == 404, p
    assert (await c.post("/kiosk/lock", headers=H)).status_code in (404, 405)
    r = await c.get("/admin")
    assert r.status_code == 200 and r.text == "admin spa"
    assert (await c.get("/admin/login")).text == "admin spa"
    assert (await c.get("/admin/api/nope")).status_code == 404


async def test_put_hot_applies_and_mqtt_only_on_change(env, started):
    c, kiosk, _, _ = env
    await login(c)
    mgr = kiosk.state.mgr
    cfg = (await c.get("/admin/api/settings")).json()["config"]

    async def put(**kw):
        r = await c.put("/admin/api/settings", headers=H, json={"config": {**cfg, **kw}})
        assert r.status_code == 200, r.text
        await asyncio.sleep(0)

    await put(mqtt={"host": "broker", "password": "p"})
    assert mgr.starts == 1
    await put(mqtt={"host": "broker", "password": {"set": True}}, screen={"idle_minutes": 3})
    assert mgr.starts == 1  # not an mqtt change
    assert kiosk.state.effective().idle_minutes == 3
    await put(mqtt={"host": "broker2"})
    assert mgr.starts == 2
    await put(mqtt=None)
    assert mgr.task is None


async def test_store_persisted_0600(env):
    c, kiosk, _, s = env
    await login(c)
    cfg = (await c.get("/admin/api/settings")).json()["config"]
    assert (await c.put("/admin/api/settings", headers=H, json={"config": cfg})).status_code == 200
    assert stat.S_IMODE(os.stat(s.settings_path).st_mode) == 0o600
    assert "AT" not in open(s.settings_path).read().replace("LT", "")  # no user token stored


async def test_login_rate_limit(env):
    c, _, _adm, _ = env
    grant()
    codes = []
    for _ in range(6):
        codes.append((await c.post("/admin/api/login/start", headers=H)).status_code)
        for lid in list(_adm.state.logins):
            await c.get(f"/admin/api/login/{lid}")  # resolve so the per-IP pending cap stays clear
        await asyncio.sleep(0.02)
    assert codes == [200] * 5 + [429]


async def test_pickers_use_admin_token(env):
    c, *_ = env
    await login(c)
    r1 = respx.get(f"{API}/smb/browse/3").respond(200, json=[{"name": "d"}])
    r = await c.get("/admin/api/papyrus/smb/browse/3", params={"path": "/x"})
    assert r.json() == [{"name": "d"}]
    assert r1.calls[0].request.headers["authorization"] == "Bearer AT"
    assert r1.calls[0].request.url.params["path"] == "/x"
    assert (await c.get("/admin/api/papyrus/smb/browse/a%2Fb")).status_code in (400, 404)
    respx.get(f"{API}/contacts").respond(200, json=[{"id": "a", "name": "A", "email": "e"}])
    assert (await c.get("/admin/api/papyrus/contacts")).json()[0]["id"] == "a"
    st = (await c.get("/admin/api/status")).json()
    assert st["links"]["contacts"].endswith("/contacts") and "mqtt" in st


async def test_mqtt_and_labelmaker_test(env, monkeypatch):
    c, *_ = env
    await login(c)
    seen = []

    async def probe(s, timeout=8):
        seen.append(s)
    monkeypatch.setattr(mqtt, "probe", probe)
    r = await c.post("/admin/api/mqtt/test", headers=H, json={"host": "b", "password": "x"})
    assert r.json() == {"ok": True} and seen[0].mqtt_password == "x"
    respx.get(f"{L}/api/v1/health").respond(200, json={})
    assert (await c.get("/admin/api/labelmaker/test")).json() == {"ok": True, "status": 200}


def test_tls_cert_generated_and_reused(tmp_path):
    cert, key, fp = admin_tls.ensure_cert(str(tmp_path), "192.168.1.5", ["pi.lan"])
    assert stat.S_IMODE(os.stat(key).st_mode) == 0o600 and len(fp.split(":")) == 32
    assert admin_tls.ensure_cert(str(tmp_path), "192.168.1.5", ["pi.lan"])[2] == fp
    assert admin_tls.ensure_cert(str(tmp_path), "192.168.1.9", [])[2] != fp  # SAN changed


# ---- review-fix regressions ----
async def _put_cfg(c, **cfg):
    return await c.put("/admin/api/settings", headers=H, json={"config": cfg})


async def test_labelmaker_test_secret_only_for_same_endpoint(env):
    c, *_ = env
    await login(c)
    ok = respx.get(f"{L}/api/v1/health").respond(200, json={})
    other = respx.get("http://evil.test/api/v1/health").respond(200, json={})
    await c.post("/admin/api/labelmaker/test", headers=H, json={"url": L + "/", "token": {"set": True}})
    assert ok.calls[0].request.headers["authorization"] == "Bearer LT"
    await c.post("/admin/api/labelmaker/test", headers=H, json={"url": "http://evil.test", "token": {"set": True}})
    assert "authorization" not in other.calls[0].request.headers
    await c.post("/admin/api/labelmaker/test", headers=H, json={"url": "http://evil.test", "token": "mine"})
    assert other.calls[1].request.headers["authorization"] == "Bearer mine"


async def test_mqtt_test_secret_only_for_same_host_port(env, monkeypatch):
    c, *_ = env
    await login(c)
    await _put_cfg(c, mqtt={"host": "broker", "port": 1883, "password": "pw"})
    seen = []

    async def probe(s, timeout=8):
        seen.append(s.mqtt_password)
    monkeypatch.setattr(mqtt, "probe", probe)
    for body in ({"host": "broker", "password": {"set": True}},
                 {"host": "other", "password": {"set": True}},
                 {"host": "broker", "port": 1884, "password": {"set": True}}):
        await c.post("/admin/api/mqtt/test", headers=H, json=body)
    assert seen == ["pw", "", ""]


async def test_put_clears_secret_when_endpoint_changes(env):
    c, kiosk, *_ = env
    await login(c)
    await _put_cfg(c, mqtt={"host": "broker", "password": "pw"},
                   labelmaker={"url": L, "token": "LT"})
    r = await _put_cfg(c, mqtt={"host": "broker2", "password": {"set": True}},
                       labelmaker={"url": "http://elsewhere.test", "token": {"set": True}})
    assert r.status_code == 200
    e = kiosk.state.effective()
    assert e.mqtt_password == "" and e.labelmaker_token == ""
    await _put_cfg(c, mqtt={"host": "broker2", "password": "n"}, labelmaker={"url": L, "token": "n"})
    await _put_cfg(c, mqtt={"host": "BROKER2", "password": {"set": True}},
                   labelmaker={"url": L + "/", "token": {"set": True}})
    e = kiosk.state.effective()
    assert e.mqtt_password == "n" and e.labelmaker_token == "n"


async def test_validation_errors_do_not_echo_input(env, monkeypatch):
    c, *_ = env
    await login(c)
    r = await _put_cfg(c, labelmaker={"url": "SECRETURL notaurl", "token": "x"})
    assert r.status_code == 422 and "SECRETURL" not in r.text
    assert set(r.json()["error"]["detail"][0]) == {"loc", "msg"}
    r = await c.post("/admin/api/mqtt/test", headers=H, json={"host": "", "port": "SECRETPORT"})
    assert "SECRETPORT" not in r.text and r.json()["ok"] is False


async def test_manager_serializes_applies_and_cleans_ca(monkeypatch):
    live, peak, paths = 0, 0, []

    async def runner(s, *a):
        nonlocal live, peak
        live += 1
        peak = max(peak, live)
        paths.append(s.mqtt_ca_file)
        try:
            await asyncio.Event().wait()
        finally:
            live -= 1
    m = mqtt.Manager(None, None, runner=runner)
    base = Settings(mqtt_tls=True)
    await asyncio.gather(*(m.apply(base.model_copy(update=dict(
        mqtt_host=f"h{i}", mqtt_ca_pem="PEM"))) for i in range(5)))
    await asyncio.sleep(0)
    assert live == 1 and peak == 1
    assert [os.path.exists(p) for p in paths].count(True) == 1
    await m.stop()
    await asyncio.sleep(0)
    assert live == 0 and not any(os.path.exists(p) for p in paths)


async def test_status_and_session_do_not_refresh_idle(env, clock):
    c, *_ = env
    await login(c)
    clock.t += 14 * 60
    assert (await c.get("/admin/api/status")).status_code == 200
    assert (await c.get("/admin/api/session")).status_code == 200
    clock.t += 2 * 60
    assert (await c.get("/admin/api/session")).status_code == 401


async def test_cookie_secure_flag_configurable(env):
    _, kiosk, _, _ = env
    for secure in (True, False):
        adm = create_admin_app(kiosk, tls=False, cookie_secure=secure)
        async with adm.router.lifespan_context(adm):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=adm),
                                         base_url="http://admin.test") as c:
                grant()
                lid = (await c.post("/admin/api/login/start", headers=H)).json()["login_id"]
                for _ in range(100):
                    r = await c.get(f"/admin/api/login/{lid}")
                    if r.json()["state"] != "pending":
                        break
                    await asyncio.sleep(0.01)
                assert ("Secure" in r.headers["set-cookie"]) is secure
                assert "strict-transport-security" not in r.headers
    adm = create_admin_app(kiosk, tls=True)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=adm),
                                 base_url="https://admin.test") as c:
        assert "strict-transport-security" in (await c.get("/admin/api/session")).headers


async def test_pending_login_caps_per_ip_and_expires_when_unpolled(env, clock):
    c, _, adm, _ = env
    respx.post(f"{API}/auth/device/code").respond(200, json={
        "device_code": "d", "user_code": "AB-12", "verification_uri": f"{P}/v",
        "verification_uri_complete": f"{P}/v?c=AB-12", "expires_in": 300, "interval": 3600})
    codes = []
    for i in range(4):
        adm.state.limiter.hits.clear()
        codes.append((await c.post("/admin/api/login/start", headers=H)).status_code)
    assert codes == [200, 200, 200, 429]
    clock.t += 31
    await asyncio.sleep(5.2)  # reaper tick
    assert not adm.state.logins


async def test_admin_clear_recent_and_toggle(env):
    c, kiosk, adm, s = env
    grant()
    r = await c.post("/admin/api/login/start", headers=H)
    lid = r.json()["login_id"]
    for _ in range(50):
        if (await c.get(f"/admin/api/login/{lid}")).json()["state"] == "ok":
            break
        await asyncio.sleep(0.01)
    rec = kiosk.state.recent
    rec.record(1); rec.record(2)
    assert (await c.post("/admin/api/recent/clear")).status_code == 403  # CSRF header required
    assert (await c.post("/admin/api/recent/clear", headers=H)).status_code == 200
    assert rec.ids() == []
    rec.record(3)
    cfg = (await c.get("/admin/api/settings")).json()["config"]
    assert cfg["login"]["show_recent"] is True
    cfg["login"]["show_recent"] = False
    assert (await c.put("/admin/api/settings", json={"config": cfg}, headers=H)).status_code == 200
    assert rec.ids() == []
    assert kiosk.state.effective().login_show_recent is False


async def test_admin_clear_recent_write_failure(env, monkeypatch):
    c, kiosk, adm, s = env
    grant()
    lid = (await c.post("/admin/api/login/start", headers=H)).json()["login_id"]
    for _ in range(50):
        if (await c.get(f"/admin/api/login/{lid}")).json()["state"] == "ok":
            break
        await asyncio.sleep(0.01)
    kiosk.state.recent.record(1)
    monkeypatch.setattr(kiosk.state.recent, "_save", lambda items: False)
    r = await c.post("/admin/api/recent/clear", headers=H)
    assert r.status_code == 500 and r.json()["error"]["code"] == "write_failed"
    assert kiosk.state.recent.ids() == ["1"]
