import asyncio
import json

import httpx
import pytest
import respx

from kiosk_api.config import Settings
from kiosk_api.main import create_app

P = "http://pap.test"
A = f"{P}/api/v1"
MINE = [{"id": 7, "name": "Bob", "email": "bob@x.test"}]
ME = {"id": 1, "email": "a@x.test", "display_name": "Ann", "role": "user"}
CODE = {"device_code": "dc", "user_code": "ABCD-EFGH", "interval": 0, "expires_in": 300,
        "verification_uri": "http://pap.test/device",
        "verification_uri_complete": "http://pap.test/device?code=ABCD-EFGH"}
TOKEN = {"access_token": "UTOK", "token_id": "t1", "expires_at": "x", "scopes": [],
         "user": {"id": "u1", "display_name": "Ann", "email": "a@x.test"}}


class Clock:
    t = 1000.0

    def __call__(self):
        return self.t


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
async def ak(tmp_path, clock):
    """(client, app) with a mocked clock."""
    s = Settings(papyrus_url=P, papyrus_token="PTOK", backlight_path=str(tmp_path),
                 static_dir=str(tmp_path), unlock_idle_s=60,
                 unlock_max_s=300, papyrus_public_url="https://pub.test")
    app = create_app(s)
    app.state.unlock.clock = clock
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://k") as c:
            yield c, app


async def settle(c, want, tries=50):
    for _ in range(tries):
        st = (await c.get("/kiosk/unlock/state")).json()
        if st["state"] == want:
            return st
        await asyncio.sleep(0.01)
    raise AssertionError(st)


async def do_unlock(c):
    respx.post(f"{A}/auth/device/code").respond(200, json=CODE)
    respx.post(f"{A}/auth/device/token").respond(200, json=TOKEN)
    await c.post("/kiosk/unlock/start")
    return await settle(c, "unlocked")


@respx.mock
async def test_flow_approved_and_lock_revokes(ak):
    c, _ = ak
    code = respx.post(f"{A}/auth/device/code").respond(200, json=CODE)
    seq = iter([httpx.Response(400, json={"code": "authorization_pending"}),
                httpx.Response(200, json=TOKEN)])
    tok = respx.post(f"{A}/auth/device/token").mock(side_effect=lambda r: next(seq))
    r = await c.post("/kiosk/unlock/start")
    j = r.json()
    assert j["state"] == "pending" and j["user_code"] == "ABCD-EFGH"
    assert j["qr_uri"] == "https://pub.test/device?code=ABCD-EFGH"
    assert code.calls[0].request.headers["authorization"] == "Bearer PTOK"
    st = await settle(c, "unlocked")
    assert st["user"] == "Ann" and "UTOK" not in json.dumps(st)
    assert tok.call_count == 2 and json.loads(tok.calls[0].request.content) == {"device_code": "dc"}
    rev = respx.delete(f"{A}/auth/tokens/t1").respond(204)
    st = (await c.post("/kiosk/lock")).json()
    assert st["state"] == "locked" and rev.calls[0].request.headers["authorization"] == "Bearer UTOK"


@pytest.mark.parametrize("code,state", [("access_denied", "denied"), ("expired_token", "expired"),
                                        ("invalid_grant", "locked")])
@respx.mock
async def test_flow_terminal(ak, code, state):
    c, _ = ak
    respx.post(f"{A}/auth/device/code").respond(200, json=CODE)
    respx.post(f"{A}/auth/device/token").respond(400, json={"detail": "x", "code": code})
    await c.post("/kiosk/unlock/start")
    await settle(c, state)


@respx.mock
async def test_flow_deadline_expires(ak, clock):
    c, _ = ak
    respx.post(f"{A}/auth/device/code").respond(200, json=CODE)
    respx.post(f"{A}/auth/device/token").respond(400, json={"code": "authorization_pending"})
    await c.post("/kiosk/unlock/start")
    clock.t += 301
    await settle(c, "expired")


@respx.mock
async def test_start_rate_limited(ak):
    c, _ = ak
    respx.post(f"{A}/auth/device/code").respond(429, headers={"Retry-After": "7"})
    r = await c.post("/kiosk/unlock/start")
    assert r.status_code == 429 and r.headers["retry-after"] == "7"


@respx.mock
async def test_idle_and_max_expiry_revoke(ak, clock):
    c, app = ak
    await do_unlock(c)
    rev = respx.delete(f"{A}/auth/tokens/t1").respond(204)
    clock.t += 30
    await c.post("/kiosk/unlock/touch")
    clock.t += 45  # 75s since start but only 45 idle
    await app.state.unlock.reap()
    assert (await c.get("/kiosk/unlock/state")).json()["state"] == "unlocked" and not rev.called
    clock.t += 61
    await app.state.unlock.reap()
    assert (await c.get("/kiosk/unlock/state")).json()["state"] == "locked" and rev.call_count == 1


@respx.mock
async def test_max_ttl(ak, clock):
    c, app = ak
    await do_unlock(c)
    respx.delete(f"{A}/auth/tokens/t1").respond(204)
    for _ in range(6):  # keep touching; max TTL 300s still ends it
        clock.t += 55
        await c.post("/kiosk/unlock/touch")
    assert (await c.get("/kiosk/unlock/state")).json()["state"] == "locked"


@respx.mock
async def test_revoke_falls_back_to_shared(ak):
    c, _ = ak
    await do_unlock(c)
    rev = respx.delete(f"{A}/auth/tokens/t1").mock(side_effect=[httpx.Response(401), httpx.Response(204)])
    await c.post("/kiosk/lock")
    assert [x.request.headers["authorization"] for x in rev.calls] == ["Bearer UTOK", "Bearer PTOK"]


@pytest.mark.parametrize("m,p", [("GET", "smb/shares"), ("GET", "cloud/providers"),
                                 ("POST", "scans/a1/smb"), ("POST", "jobs/upload"),
                                 ("DELETE", "scans/a1"), ("GET", "smb/browse/s1")])
@respx.mock
async def test_locked_proxy_401(ak, m, p):
    c, _ = ak
    r = await c.request(m, f"/papyrus/{p}")
    assert r.status_code == 401 and r.json() == {"detail": "locked"}
    assert not respx.calls


@respx.mock
async def test_unlocked_proxy_uses_user_token_email_blocked(ak):
    c, _ = ak
    await do_unlock(c)
    g = respx.get(f"{A}/smb/shares").respond(200, json=[])
    d = respx.delete(f"{A}/scans/a1").respond(204)
    assert (await c.get("/papyrus/smb/shares", headers={"Authorization": "Bearer evil"})).status_code == 200
    assert g.calls[0].request.headers["authorization"] == "Bearer UTOK"
    assert (await c.delete("/papyrus/scans/a1")).status_code == 204 and d.called
    r = await c.post("/papyrus/scans/a1/email", json={"to": "x@evil.test"})
    assert r.status_code == 404


@respx.mock
async def test_scans_list_mine(ak):
    c, _ = ak
    g = respx.get(f"{A}/scans").respond(200, json=[])
    await do_unlock(c)
    await c.get("/papyrus/scans?mine=false&x=1")
    q = g.calls[0].request.url.params
    assert q["mine"] == "true" and q["x"] == "1"
    assert g.calls[0].request.headers["authorization"] == "Bearer UTOK"


@respx.mock
async def test_email_contacts_only(ak):
    c, _ = ak
    assert (await c.post("/kiosk/send/email", json={"scan_id": "a1", "contact_id": 7})).status_code == 401
    assert (await c.get("/kiosk/contacts")).status_code == 401
    await do_unlock(c)
    e = respx.post(f"{A}/scans/a1/email").respond(200, json={})
    respx.get(f"{A}/contacts").respond(200, json=MINE)
    me = respx.get(f"{A}/auth/me").respond(200, json=ME)
    for body in ({"contact_id": 99}, {"contact_id": "evil@x.test"}, {"to": "evil@x.test"},
                 {"to": "evil@x.test", "contact_id": 7}):
        r = await c.post("/kiosk/send/email", json={"scan_id": "a1", **body})
        assert r.status_code == 400 and not e.called
    r = await c.post("/kiosk/send", json={"scan_id": "a1", "targets": [{"type": "email", "to": "evil@x.test"}]})
    assert r.status_code == 400 and not e.called
    r = await c.post("/kiosk/send/email", json={"scan_id": "a1", "to": "me"})
    assert r.status_code == 200 and json.loads(e.calls[0].request.content)["to"] == "a@x.test"
    assert me.calls[0].request.headers["authorization"] == "Bearer UTOK"
    r = await c.post("/kiosk/send/email", json={"scan_id": "a1", "contact_id": 7})
    assert r.status_code == 200 and json.loads(e.calls[1].request.content)["to"] == "bob@x.test"
    assert e.calls[1].request.headers["authorization"] == "Bearer UTOK"
    r = await c.post("/kiosk/send", json={"scan_id": "a1", "targets": [{"type": "email", "to": "me"}]})
    assert r.json()["all_ok"] and json.loads(e.calls[2].request.content)["to"] == "a@x.test"
    r = await c.get("/kiosk/contacts")
    assert r.json() == [{"id": "me", "name": "Me (a@x.test)"}, {"id": "7", "name": "Bob"}]
    assert "bob@x.test" not in r.text


@respx.mock
async def test_multisend_partial_failure_blocks_delete(ak):
    c, _ = ak
    await do_unlock(c)
    ocr = respx.post(f"{A}/scans/a1/ocr").respond(200)
    respx.post(f"{A}/scans/a1/paperless").respond(200)
    smb = respx.post(f"{A}/scans/a1/smb").respond(500)
    cl = respx.post(f"{A}/scans/a1/cloud").respond(200)
    dele = respx.delete(f"{A}/scans/a1").respond(204)
    body = {"scan_id": "a1", "post": {"ocr": True}, "delete_after": True, "targets": [
        {"type": "paperless"}, {"type": "smb", "share_id": "s1", "path": "/in"},
        {"type": "cloud", "provider_id": "p1", "folder_id": "f9"}]}
    j = (await c.post("/kiosk/send", json=body)).json()
    assert ocr.called and [x["ok"] for x in j["results"]] == [True, False, True]
    assert not j["all_ok"] and not j["deleted"] and not dele.called
    q = smb.calls[0].request.url.params
    assert q["share_id"] == "s1" and q["remote_path"] == "/in"
    assert cl.calls[0].request.url.params["folder_id"] == "f9"
    smb.respond(200)
    j = (await c.post("/kiosk/send", json=body)).json()
    assert j["all_ok"] and j["deleted"] and dele.called


@respx.mock
async def test_multisend_post_failure_skips_targets(ak):
    c, _ = ak
    await do_unlock(c)
    respx.post(f"{A}/scans/a1/enhance").respond(500)
    pl = respx.post(f"{A}/scans/a1/paperless").respond(200)
    j = (await c.post("/kiosk/send", json={"scan_id": "a1", "post": {"enhance": True},
                                           "targets": [{"type": "paperless"}]})).json()
    assert not pl.called and j["results"] == [] and not j["all_ok"]


@respx.mock
async def test_remote_print_streams_and_uploads(ak):
    c, _ = ak
    r = await c.post("/kiosk/print/remote", json={"source": "smb", "ref": "s1", "path": "/a/b.pdf"})
    assert r.status_code == 401
    await do_unlock(c)
    dl = respx.get(f"{A}/smb/download/s1").respond(200, content=b"%PDF-data",
                                                   headers={"content-type": "application/pdf"})
    up = respx.post(f"{A}/jobs/upload").respond(201, json={"id": "j1"})
    r = await c.post("/kiosk/print/remote", json={"source": "smb", "ref": "s1", "path": "/a/b.pdf",
                                                  "copies": 2, "duplex": True})
    assert r.status_code == 201 and r.json() == {"id": "j1"}
    assert dl.calls[0].request.url.params["path"] == "/a/b.pdf"
    req = up.calls[0].request
    assert req.headers["authorization"] == "Bearer UTOK"
    assert b'filename="b.pdf"' in req.content and b"%PDF-data" in req.content
    assert b'name="copies"' in req.content and b"\r\n2\r\n" in req.content
    assert b"\r\ntrue\r\n" in req.content
    respx.get(f"{A}/scans/a1/download").respond(200, content=b"SCAN")
    r = await c.post("/kiosk/print/scan/a1", json={})
    assert r.status_code == 201 and b"SCAN" in up.calls[1].request.content
    respx.get(f"{A}/smb/download/s2").respond(404)
    r = await c.post("/kiosk/print/remote", json={"source": "smb", "ref": "s2", "path": "/x"})
    assert r.status_code == 502 and up.call_count == 2
    r = await c.post("/kiosk/print/remote", json={"source": "smb", "ref": "../x", "path": "/x"})
    assert r.status_code == 400


@respx.mock
async def test_config_exposes_presets(ak):
    c, _ = ak
    d = (await c.get("/kiosk/config")).json()
    assert "contacts" not in d and "presets" not in d and "smb_shares" not in d
    await do_unlock(c)
    d = (await c.get("/kiosk/config")).json()
    assert "contacts" not in d
    assert d["presets"][0]["id"] == "default" and d["presets"][0]["targets"] == [{"type": "paperless"}]
    assert d["unlock"] == {"idle_s": 60, "max_s": 300} and d["public_url"] == "https://pub.test"


def test_presets_env_and_bad_json():
    s = Settings(kiosk_presets='[{"id":"x","label":"X","targets":[{"type":"paperless"}]}]',
                 scan_paperless=False)
    ids = [p["id"] for p in s.presets()]
    assert ids == ["default", "x"] and s.presets()[1]["needs_unlock"]
    assert Settings(kiosk_presets="{bad")._json_list("{bad") == []


async def test_mqtt_lock_and_payload(ak):
    from kiosk_api import mqtt
    c, app = ak
    u = app.state.unlock
    assert json.loads(mqtt.unlock_payload(u)) == {"locked": True, "user": ""}
    s = Settings()
    d = mqtt.discovery(s, None)
    assert f"homeassistant/binary_sensor/{s.kiosk_id}/locked/config" in d
    assert f"homeassistant/button/{s.kiosk_id}/lock/config" in d
    called = []
    u.request_lock = lambda: called.append(1)
    mqtt.handle_command(s, None, mqtt.topics(s)["lock"], "PRESS", u)
    assert called


@respx.mock
async def test_session_token_for_all_papyrus_proxy_calls(ak):
    c, _ = ak
    routes = {
        ("GET", "printers/default/status"): respx.get(f"{A}/printers/default/status").respond(200, json={}),
        ("POST", "scans"): respx.post(f"{A}/scans").respond(200, json={}),
        ("POST", "copy"): respx.post(f"{A}/copy").respond(200, json={}),
        ("POST", "jobs/j1/release"): respx.post(f"{A}/jobs/j1/release").respond(200, json={}),
        ("GET", "scans/a1/thumbnail"): respx.get(f"{A}/scans/a1/thumbnail").respond(200),
        ("GET", "scans/a1/download"): respx.get(f"{A}/scans/a1/download").respond(200),
    }
    for (m, p) in routes:
        assert (await c.request(m, f"/papyrus/{p}")).status_code == 401
    await do_unlock(c)
    for (m, p), r in routes.items():
        assert (await c.request(m, f"/papyrus/{p}")).status_code == 200
        assert r.calls[0].request.headers["authorization"] == "Bearer UTOK", p


@respx.mock
async def test_stale_grant_revoked_not_used(ak):
    c, app = ak
    u = app.state.unlock
    respx.post(f"{A}/auth/device/code").respond(200, json=CODE)

    def grant(_):
        u.gen += 1  # lock happened while the poll request was in flight
        return httpx.Response(200, json=TOKEN)
    respx.post(f"{A}/auth/device/token").mock(side_effect=grant)
    rev = respx.delete(f"{A}/auth/tokens/t1").respond(204)
    await c.post("/kiosk/unlock/start")
    for _ in range(100):
        if rev.called:
            break
        await asyncio.sleep(0.01)
    assert rev.calls[0].request.headers["authorization"] == "Bearer UTOK"
    assert (await c.get("/kiosk/unlock/state")).json()["state"] != "unlocked"


@respx.mock
async def test_unlock_start_drops_result_if_locked_meanwhile(ak):
    c, app = ak
    u = app.state.unlock

    def code(_):
        u.gen += 1
        return httpx.Response(200, json=CODE)
    respx.post(f"{A}/auth/device/code").mock(side_effect=code)
    tok = respx.post(f"{A}/auth/device/token").respond(200, json=TOKEN)
    r = await c.post("/kiosk/unlock/start")
    assert r.json()["state"] == "locked"
    await asyncio.sleep(0.05)
    assert not tok.called


@respx.mock
async def test_start_revokes_previous_session(ak):
    c, app = ak
    await do_unlock(c)
    rev = respx.delete(f"{A}/auth/tokens/t1").respond(204)
    await app.state.unlock.start({"id": "u2"}, "T2", "t2")
    assert rev.calls[0].request.headers["authorization"] == "Bearer UTOK"
    assert app.state.unlock.session.token == "T2"


@respx.mock
async def test_missing_token_id_rejected_nothing_revoked(ak):
    c, _ = ak
    respx.post(f"{A}/auth/device/code").respond(200, json=CODE)
    respx.post(f"{A}/auth/device/token").respond(200, json={"access_token": "UTOK", "user": {}})
    rev = respx.delete(url__regex=rf"{A}/auth/tokens/.*").respond(204)
    await c.post("/kiosk/unlock/start")
    await asyncio.sleep(0.1)
    assert (await c.get("/kiosk/unlock/state")).json()["state"] == "locked" and not rev.called


@pytest.mark.parametrize("status,fallback", [(500, True), (404, False)])
@respx.mock
async def test_revoke_fallback_on_non_2xx_except_404(ak, status, fallback):
    c, _ = ak
    await do_unlock(c)
    rev = respx.delete(f"{A}/auth/tokens/t1").respond(status)
    await c.post("/kiosk/lock")
    assert rev.call_count == (2 if fallback else 1)


@respx.mock
async def test_shutdown_revokes_token(tmp_path):
    s = Settings(papyrus_url=P, papyrus_token="PTOK", backlight_path=str(tmp_path),
                 static_dir=str(tmp_path))
    app = create_app(s)
    rev = respx.delete(f"{A}/auth/tokens/t1").respond(204)
    async with app.router.lifespan_context(app):
        await app.state.unlock.start({}, "UTOK", "t1")
    assert rev.called and rev.calls[0].request.headers["authorization"] == "Bearer UTOK"


@respx.mock
async def test_send_rejects_bad_post_and_targets(ak):
    c, _ = ak
    await do_unlock(c)
    for b in ({"post": "ocr", "targets": [{"type": "paperless"}]},
              {"post": [1], "targets": [{"type": "paperless"}]},
              {"targets": [{"type": "smb", "share_id": "s1", "path": 5}]},
              {"targets": [{"type": ["x"]}]}):
        r = await c.post("/kiosk/send", json={"scan_id": "a1", **b})
        assert r.status_code == 400, b


@respx.mock
async def test_remote_print_size_cap_and_spool_default(tmp_path):
    assert Settings().print_max_bytes == 100 * 1024 * 1024 and Settings().spool_dir == "/var/tmp"
    s = Settings(papyrus_url=P, papyrus_token="PTOK", backlight_path=str(tmp_path),
                 static_dir=str(tmp_path), print_max_bytes=10, spool_dir=str(tmp_path / "sp"))
    app = create_app(s)
    async with app.router.lifespan_context(app):
        await app.state.unlock.start({}, "UTOK", "t1")
        up = respx.post(f"{A}/jobs/upload").respond(201, json={})
        respx.get(f"{A}/smb/download/s1").respond(200, content=b"x" * 50)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://k") as c:
            r = await c.post("/kiosk/print/remote", json={"source": "smb", "ref": "s1", "path": "/a"})
        assert r.status_code == 413 and not up.called
        respx.delete(f"{A}/auth/tokens/t1").respond(204)


async def _inject(app, clock):
    from kiosk_api.session import UnlockSession
    app.state.unlock.session = UnlockSession("u", "UTOK", "t1", clock.t, clock.t)


@respx.mock
async def test_get_polls_do_not_keep_session_alive(ak, clock):
    c, app = ak
    await _inject(app, clock)
    respx.get(f"{A}/jobs").respond(200, json=[])
    for _ in range(4):
        clock.t += 20
        await c.get("/papyrus/jobs")
    assert app.state.unlock.expired()
    clock.t += 1
    assert (await c.get("/papyrus/jobs")).status_code in (401, 403, 423)


@respx.mock
async def test_mutating_proxy_touches(ak, clock):
    c, app = ak
    await _inject(app, clock)
    respx.delete(f"{A}/scans/j1").respond(204)
    clock.t += 50
    await c.delete("/papyrus/scans/j1")
    clock.t += 50
    assert not app.state.unlock.expired()


@respx.mock
async def test_busy_send_survives_idle_but_not_max(ak, clock):
    c, app = ak
    u = app.state.unlock
    await _inject(app, clock)

    def slow(request):
        clock.t += 100  # > idle_s (60)
        return httpx.Response(200, json={})
    respx.post(f"{A}/scans/s1/ocr").mock(side_effect=slow)
    respx.post(f"{A}/scans/s1/paperless").respond(200, json={})
    r = await c.post("/kiosk/send", json={"scan_id": "s1", "targets": [{"type": "paperless"}],
                                          "post": {"ocr": True}})
    assert r.status_code == 200
    assert u.busy_n == 0 and not u.expired()
    async with u.busy():
        clock.t += 100
        await u.reap()
        assert u.session is not None
        clock.t += 300  # past max_s
        assert u.expired()
    await u.reap()
    assert u.session is None
