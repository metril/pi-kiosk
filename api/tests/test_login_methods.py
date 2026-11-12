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
async def test_users_no_q_returns_only_recent_never_full_list(on):
    c, _ = on
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
    u = respx.get(f"{A}/auth/kiosk-login/users").respond(200, json=USERS)
    r = await c.get("/kiosk/unlock/users")
    assert r.json() == []
    assert (await c.get("/kiosk/unlock/users", params={"q": "a"})).json() == []
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


BIG = [{"id": i, "display_name": f"Sam User{i}", "has_pin": i % 2 == 0} for i in range(1, 31)] + [
    {"id": 100, "display_name": "Élodie van Der Berg", "has_pin": True},
    {"id": 101, "display_name": "Bob Samson", "has_pin": False}]


@respx.mock
async def test_search_rules(on):
    c, _ = on
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
    respx.get(f"{A}/auth/kiosk-login/users").respond(200, json=BIG)
    g = lambda **p: c.get("/kiosk/unlock/users", params=p)  # noqa: E731
    assert (await g(q="s")).json() == []  # min length
    r = (await g(q="sa")).json()
    assert len(r) == 8 and all("Sam" in x["display_name"] for x in r)  # cap 8
    assert [x["id"] for x in (await g(q="sam", mode="pin")).json()] == ["2", "4", "6", "8", "10", "12", "14", "16"]
    assert [x["id"] for x in (await g(q="SAMS")).json()] == ["101"]  # prefix on any word, case-insens
    assert [x["id"] for x in (await g(q="der")).json()] == ["100"]
    assert [x["id"] for x in (await g(q="elo")).json()] == ["100"]  # accent-insensitive
    assert (await g(q="ams")).json() == []  # not a substring match


@respx.mock
async def test_list_cached(on):
    c, _ = on
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
    u = respx.get(f"{A}/auth/kiosk-login/users").respond(200, json=USERS)
    for _ in range(3):
        await c.get("/kiosk/unlock/users", params={"q": "an"})
    assert u.call_count == 1


@respx.mock
async def test_recent_recorded_order_cap_and_dropout(on, clock):
    c, app = on
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
    users = respx.get(f"{A}/auth/kiosk-login/users").respond(200, json=BIG)
    pin_ok = respx.post(f"{A}/auth/device/pin").respond(200, json=TOKEN)
    for uid in [1, 2, 3, 4, 5, 6, 7, 2]:
        r = await c.post("/kiosk/unlock/pin", json={"user_id": uid, "pin": "123456"})
        assert r.json()["state"] == "unlocked", pin_ok.calls.last.request.url
        await c.post("/kiosk/lock")
    assert app.state.recent.ids() == ["2", "7", "6", "5", "4", "3"]
    r = (await c.get("/kiosk/unlock/users")).json()
    assert [x["id"] for x in r] == ["2", "7", "6", "5", "4", "3"]
    assert [x["id"] for x in (await c.get("/kiosk/unlock/users", params={"mode": "pin"})).json()] == ["2", "6", "4"]
    # deleted/renamed in Papyrus: drops out / updates (new cache)
    app.state.recent.record(999)
    users.respond(200, json=[{"id": 7, "display_name": "Renamed", "has_pin": True}, {"id": 3, "display_name": "Cy", "has_pin": True}])
    # expire the server-side cache
    app.state.expire_users()
    r = (await c.get("/kiosk/unlock/users")).json()
    assert [(x["id"], x["display_name"]) for x in r] == [("7", "Renamed")]


@respx.mock
async def test_recent_persisted_atomically(tmp_path):
    from kiosk_api.recent_store import RecentStore
    p = tmp_path / "d" / "recent_users.json"
    s = RecentStore(str(p))
    for i in range(9):
        s.record(i)
    d = json.loads(p.read_text())
    assert [x["id"] for x in d] == ["8", "7", "6", "5", "4", "3"] and all("ts" in x for x in d)
    assert RecentStore(str(p)).ids() == s.ids()
    assert not list(p.parent.glob("*.tmp"))
    s.clear()
    assert RecentStore(str(p)).ids() == []


@respx.mock
async def test_approve_records_recent(on):
    c, app = on
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
    respx.get(f"{A}/auth/kiosk-login/users").respond(200, json=USERS)
    respx.post(f"{A}/auth/device/approve-request").respond(200, json=APPROVE)
    respx.post(f"{A}/auth/device/token").respond(200, json=TOKEN)
    await c.post("/kiosk/unlock/approve", json={"user_id": 2})
    await settle(c, "unlocked")
    assert app.state.recent.ids() == ["2"]
    await c.post("/kiosk/lock")
    assert [x["id"] for x in (await c.get("/kiosk/unlock/users")).json()] == ["2"]


@respx.mock
async def test_toggle_off_hides_and_stops_recording(tmp_path, clock):
    app = make(tmp_path, clock, login_approve=True, login_pin=True)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://k") as c:
            respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
            respx.get(f"{A}/auth/kiosk-login/users").respond(200, json=USERS)
            app.state.recent.record(1)
            assert len((await c.get("/kiosk/unlock/users")).json()) == 1
            cfg = Config(login={"qr": True, "approve": True, "pin": True, "show_recent": False})
            await app.state.store.set_config(cfg)
            assert (await c.get("/kiosk/unlock/users")).json() == []


@respx.mock
async def test_search_rate_limited_recent_not(on):
    c, _ = on
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
    respx.get(f"{A}/auth/kiosk-login/users").respond(200, json=USERS)
    for _ in range(30):
        assert (await c.get("/kiosk/unlock/users", params={"q": "an"})).status_code == 200
    r = await c.get("/kiosk/unlock/users", params={"q": "an"})
    assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited"
    assert (await c.get("/kiosk/unlock/users")).status_code == 200


@respx.mock
async def test_stale_user_expires_cache(on):
    c, app = on
    respx.get(f"{A}/auth/kiosk-login/config").respond(200, json=CFG)
    users = respx.get(f"{A}/auth/kiosk-login/users").respond(200, json=USERS)
    respx.post(f"{A}/auth/device/approve-request").respond(404)
    await c.get("/kiosk/unlock/users", params={"q": "an"})
    assert users.call_count == 1
    assert (await c.post("/kiosk/unlock/approve", json={"user_id": 1})).json()["error"]["code"] == "unknown_user"
    await c.get("/kiosk/unlock/users", params={"q": "an"})
    assert users.call_count == 2
    respx.post(f"{A}/auth/device/pin").respond(403)
    await c.post("/kiosk/unlock/pin", json={"user_id": 1, "pin": "123456"})
    await c.get("/kiosk/unlock/users", params={"q": "an"})
    assert users.call_count == 3


def test_clear_failure_keeps_list(tmp_path, monkeypatch):
    from kiosk_api.recent_store import RecentStore
    s = RecentStore(str(tmp_path / "r.json"))
    s.record(1)
    monkeypatch.setattr("os.replace", lambda *a: (_ for _ in ()).throw(OSError("ro")))
    assert s.clear() is False and s.ids() == ["1"]
