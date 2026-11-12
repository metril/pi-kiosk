import json

import httpx
import pytest
import respx

from kiosk_api.config import Settings
from kiosk_api.main import create_app
from kiosk_api.settings_store import Config
from test_unlock import A, P, TOKEN, Clock, settle  # noqa: F401  (same patterns)

CFG = {"approve": True, "pin": True, "pin_length": 6}
USERS = [{"id": 1, "display_name": "Ann", "has_pin": True}, {"id": 2, "display_name": "Bob", "has_pin": False}]
APPROVE = {"device_code": "dc2", "match_code": "42", "expires_in": 300, "interval": 0}


def make(tmp_path, clock, **kw):
    s = Settings(papyrus_url=P, papyrus_token="PTOK", backlight_path=str(tmp_path), static_dir=str(tmp_path),
                 unlock_idle_s=60, unlock_max_s=300, **kw)
    app = create_app(s)
    app.state.unlock.clock = clock
    return app


@pytest.fixture
def clock():
    return Clock()




@pytest.fixture
async def on(tmp_path, clock):
    """Approve and PIN enabled locally."""
    app = make(tmp_path, clock, login_approve=True, login_pin=True)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://k") as c:
            yield c, app


@pytest.fixture
async def off(tmp_path, clock):
    app = make(tmp_path, clock)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://k") as c:
            yield c, app


@respx.mock
async def test_methods_effective_is_toggle_and_papyrus(on):
    c, _ = on
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json={"approve": True, "pin": False, "pin_length": 8})
    assert (await c.get("/kiosk/unlock/methods")).json() == {"qr": True, "approve": True, "pin": False, "pin_length": 8}


@respx.mock
async def test_methods_kiosk_toggle_off_wins(off):
    c, _ = off
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
    m = (await c.get("/kiosk/unlock/methods")).json()
    assert m["qr"] and not m["approve"] and not m["pin"]


@respx.mock
@pytest.mark.parametrize("resp", [httpx.Response(404), httpx.Response(500), httpx.Response(200, text="x"),
                                  httpx.ConnectError("x")])
async def test_methods_old_papyrus_fallback(on, resp):
    c, _ = on
    respx.get(f"{A}/auth/kiosk-login/config").mock(side_effect=lambda r: (_ for _ in ()).throw(resp)
                                                   if isinstance(resp, Exception) else resp)
    m = (await c.get("/kiosk/unlock/methods")).json()
    assert m == {"qr": True, "approve": False, "pin": False, "pin_length": 6}


@respx.mock
async def test_disabled_gating(off):
    c, _ = off
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
    assert (await c.post("/kiosk/unlock/approve", json={"user_id": 1})).status_code == 403
    assert (await c.post("/kiosk/unlock/pin", json={"user_id": 1, "pin": "123456"})).status_code == 403
    assert (await c.get("/kiosk/unlock/users")).status_code == 403


@respx.mock
async def test_users_proxy_hides_nothing_secret(on):
    c, _ = on
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
    u = respx.get(f"{A}/auth/kiosk-login/users").respond(200, json=USERS)
    r = await c.get("/kiosk/unlock/users")
    assert r.json() == [{"id": "1", "display_name": "Ann", "has_pin": True},
                        {"id": "2", "display_name": "Bob", "has_pin": False}]
    assert u.calls[0].request.headers["authorization"] == "Bearer PTOK"


@respx.mock
async def test_approve_ok(on):
    c, _ = on
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
    req = respx.post(f"{A}/auth/device/approve-request").respond(200, json=APPROVE)
    seq = iter([httpx.Response(400, json={"code": "authorization_pending"}), httpx.Response(200, json=TOKEN)])
    tok = respx.post(f"{A}/auth/device/token").mock(side_effect=lambda r: next(seq))
    j = (await c.post("/kiosk/unlock/approve", json={"user_id": 1})).json()
    assert j["state"] == "pending" and j["match_code"] == "42" and "qr_uri" not in j
    assert json.loads(req.calls[0].request.content) == {"user_id": "1", "client_name": "kiosk"} \
        or json.loads(req.calls[0].request.content)["user_id"] == "1"
    st = await settle(c, "unlocked")
    assert st["user"] == "Ann" and "UTOK" not in json.dumps(st)
    assert json.loads(tok.calls[0].request.content) == {"device_code": "dc2"}


@respx.mock
@pytest.mark.parametrize("code,state", [("access_denied", "denied"), ("expired_token", "expired")])
async def test_approve_denied_expired(on, code, state):
    c, _ = on
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
    respx.post(f"{A}/auth/device/approve-request").respond(200, json=APPROVE)
    respx.post(f"{A}/auth/device/token").respond(400, json={"code": code})
    await c.post("/kiosk/unlock/approve", json={"user_id": 1})
    await settle(c, state)


@respx.mock
async def test_approve_cancel_and_unknown_user(on):
    c, _ = on
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
    respx.post(f"{A}/auth/device/approve-request").respond(200, json=APPROVE)
    respx.post(f"{A}/auth/device/token").respond(400, json={"code": "authorization_pending"})
    await c.post("/kiosk/unlock/approve", json={"user_id": 1})
    assert (await c.post("/kiosk/lock")).json()["state"] == "locked"
    respx.post(f"{A}/auth/device/approve-request").respond(404, json={"detail": "no"})
    r = await c.post("/kiosk/unlock/approve", json={"user_id": 99})
    assert r.status_code == 404 and r.json()["error"]["code"] == "unknown_user"
    assert (await c.post("/kiosk/unlock/approve", json={"user_id": True})).status_code == 400


@respx.mock
async def test_pin_ok(on):
    c, _ = on
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
    p = respx.post(f"{A}/auth/device/pin").respond(200, json=TOKEN)
    st = (await c.post("/kiosk/unlock/pin", json={"user_id": 1, "pin": "123456"})).json()
    assert st["state"] == "unlocked" and st["user"] == "Ann" and "UTOK" not in json.dumps(st)
    assert json.loads(p.calls[0].request.content)["pin"] == "123456"


@respx.mock
async def test_pin_ok_fetches_me_when_no_user(on):
    c, _ = on
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
    respx.post(f"{A}/auth/device/pin").respond(200, json={"access_token": "UTOK", "token_id": "t1"})
    me = respx.get(f"{A}/auth/me").respond(200, json={"display_name": "Ann"})
    st = (await c.post("/kiosk/unlock/pin", json={"user_id": 1, "pin": "123456"})).json()
    assert st["user"] == "Ann" and me.calls[0].request.headers["authorization"] == "Bearer UTOK"


@respx.mock
async def test_pin_wrong_locked_unavailable(on):
    c, _ = on
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
    route = respx.post(f"{A}/auth/device/pin")
    body = {"user_id": 1, "pin": "000000"}
    route.respond(401, json={"remaining": 3})
    r = await c.post("/kiosk/unlock/pin", json=body)
    assert r.status_code == 401 and r.json()["error"] == {"code": "wrong_pin", "remaining": 3}
    route.respond(423, json={"retry_after": 900})
    r = await c.post("/kiosk/unlock/pin", json=body)
    assert r.status_code == 423 and r.json()["error"]["retry_after"] == 900 and r.headers["retry-after"] == "900"
    route.respond(403, json={"detail": "PIN login not available"})
    r = await c.post("/kiosk/unlock/pin", json=body)
    assert r.status_code == 403 and r.json()["error"]["code"] == "pin_unavailable"
    assert (await c.get("/kiosk/unlock/state")).json()["state"] == "locked"


@respx.mock
async def test_pin_local_rate_limit_and_window(on, clock):
    c, _ = on
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
    respx.post(f"{A}/auth/device/pin").respond(401, json={"remaining": 1})
    body = {"user_id": 1, "pin": "000000"}
    for _ in range(10):
        assert (await c.post("/kiosk/unlock/pin", json=body)).status_code == 401
    assert (await c.post("/kiosk/unlock/pin", json=body)).status_code == 429
    clock.t += 61
    assert (await c.post("/kiosk/unlock/pin", json=body)).status_code == 401


def test_settings_validation():
    assert Config.model_validate({}).login.qr is True
    assert Config.model_validate({"login": {"qr": False, "pin": True}}).login.pin
    with pytest.raises(ValueError):
        Config.model_validate({"login": {"qr": False, "approve": False, "pin": False}})


@respx.mock
async def test_pin_login_stales_pending_approve_poll(on):
    """A late approve for another user must not replace a PIN session."""
    import asyncio
    c, _ = on
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
    respx.post(f"{A}/auth/device/approve-request").respond(200, json=APPROVE)
    bob = {**TOKEN, "access_token": "BTOK", "token_id": "t2", "user": {"id": "u2", "display_name": "Bob"}}
    approved = {"v": False}
    respx.post(f"{A}/auth/device/token").mock(side_effect=lambda r: httpx.Response(200, json=bob)
                                              if approved["v"] else httpx.Response(400, json={"code": "authorization_pending"}))
    respx.post(f"{A}/auth/device/pin").respond(200, json=TOKEN)
    revoke = respx.route(method="DELETE").respond(204)
    assert (await c.post("/kiosk/unlock/approve", json={"user_id": 2})).json()["state"] == "pending"
    assert (await c.post("/kiosk/unlock/pin", json={"user_id": 1, "pin": "123456"})).json()["user"] == "Ann"
    approved["v"] = True
    await asyncio.sleep(0.1)
    assert (await c.get("/kiosk/unlock/state")).json()["user"] == "Ann"
    assert not any("t1" in str(x.request.url) for x in revoke.calls)
