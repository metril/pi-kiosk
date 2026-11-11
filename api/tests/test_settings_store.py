import asyncio
import json
import os
import stat

import httpx
import pytest
import respx

from conftest import force_unlock

from kiosk_api import mqtt
from kiosk_api.config import Settings
from kiosk_api.main import create_app
from kiosk_api.settings_store import (Config, SettingsStore, effective, merge_secrets, mask,
                                      parse, refresh_cache)

P, L = "http://pap.test", "http://lm.test"


def stored(**cfg):
    c = {"name": "Hall", "public_url": "https://pub", "unlock": {"idle_s": 60, "max_s": 300},
         "screen": {"idle_minutes": 9},
         "presets": [{"id": "p", "label": "P", "icon": "folder",
                      "targets": [{"type": "paperless"}]}],
         "labelmaker": {"url": L, "token": "T"}, "mqtt": None, **cfg}
    return {"config": c,
            "smb_shares": [{"id": "1", "name": "Share"}]}


@pytest.fixture
def path(tmp_path):
    return str(tmp_path / "c" / "settings.json")


async def test_persist_atomic_0600_and_reload(path):
    st = SettingsStore(path)
    await st.set_config(Config.model_validate(stored()["config"]))
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert os.listdir(os.path.dirname(path)) == ["settings.json"]  # no temp left behind
    st2 = SettingsStore(path)
    assert st2.load() and st2.current().config.screen.idle_minutes == 9
    # an invalid file is ignored
    open(path, "w").write("{nope")
    assert not SettingsStore(path).load()


async def test_subscribe_and_applier(path):
    st = SettingsStore(path)
    calls = []

    async def ap():
        calls.append(st.rev)
    st.applier = ap
    sub = st.subscribe()
    await st.set_config(Config(name="x"))
    assert (await sub.__anext__()).config.name == "x" and calls == [1]
    sub.close()
    assert not st.subs


def test_env_fallback_and_null_disables():
    env = Settings(labelmaker_url=L, mqtt_host="b")
    assert effective(env, None) is env
    s = effective(env, parse(stored()))
    assert s.mqtt_host == "" and s.labelmaker_url == L and s.kiosk_name == "Hall"
    assert s.presets()[0]["needs_unlock"]
    assert s.idle_minutes == 9 and s.unlock_idle_s == 60 and s.papyrus_public_url == "https://pub"
    assert s.shares == [{"id": "1", "name": "Share"}]
    assert effective(env, parse(stored(labelmaker=None))).labelmaker_url == ""


def test_secret_semantics():
    old = Config.model_validate(stored(mqtt={"host": "b", "password": "pw"})["config"])
    m = mask(old)
    assert m["labelmaker"]["token"] == {"set": True} and m["mqtt"]["password"] == {"set": True}
    assert "T" not in json.dumps(m) and "pw" not in json.dumps(m)
    f = lambda **k: merge_secrets(old, {"labelmaker": {"url": L, **k}})["labelmaker"]["token"]
    assert f() == "T" and f(token={"set": True}) == "T"
    assert f(token=None) == "" and f(token="") == "" and f(token="N") == "N"


@respx.mock
async def test_refresh_cache_offline_keeps(path):
    st = SettingsStore(path)
    await st.set_config(Config())
    async with httpx.AsyncClient() as c:
        async def call(m, p, token=None, **kw):
            try:
                return await c.request(m, f"{P}/api/v1/{p}", headers={"Authorization": "Bearer S"})
            except httpx.HTTPError:
                return None
        respx.get(f"{P}/api/v1/smb/shares").respond(200, json=[{"id": 1, "name": "S"}])
        assert await refresh_cache(st, call)
        assert st.current().smb_shares[0].name == "S"
        respx.get(f"{P}/api/v1/smb/shares").mock(side_effect=httpx.ConnectError("down"))
        assert not await refresh_cache(st, call)
    assert SettingsStore(path).load()


async def test_hot_apply_and_labelmaker_swap(path, tmp_path):
    s = Settings(settings_path=path, papyrus_url=P, papyrus_token="TOK",
                 backlight_path=str(tmp_path), static_dir=str(tmp_path))
    app = create_app(s)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://k") as c:
            force_unlock(app)
            with respx.mock:
                respx.get(f"{P}/api/v1/smb/shares").respond(200, json=[])
                await app.state.store.set_config(Config.model_validate(stored()["config"]))
                await app.state.store.set_cache(parse(stored()).smb_shares)
                old = app.state.labels
                d = (await c.get("/kiosk/config")).json()
                assert d["name"] == "Hall"
                assert d["presets"][0]["id"] == "p" and d["smb_shares"][0]["name"] == "Share"
                rev = d["config_rev"]
                assert (await c.get("/kiosk/screen")).json()["config_rev"] == rev
                lm = respx.get(f"{L}/api/v1/health").respond(200, json={})
                await c.get("/labels/health")
                assert lm.calls[0].request.headers["authorization"] == "Bearer T"
                await app.state.store.set_config(Config.model_validate(stored(
                    labelmaker={"url": "http://lm2.test", "token": "U"},
                    presets=[{"id": "q", "icon": "mail", "targets": []}])["config"]))
                d = (await c.get("/kiosk/config")).json()
                assert d["config_rev"] == rev + 1
                assert [p["id"] for p in d["presets"]] == ["q"]
                assert app.state.labels is not old and old.is_closed
                lm2 = respx.get("http://lm2.test/api/v1/health").respond(200, json={})
                await c.get("/labels/health")
                assert lm2.calls[0].request.headers["authorization"] == "Bearer U"
                await app.state.store.set_config(Config.model_validate(stored(labelmaker=None)["config"]))
                assert (await c.get("/labels/health")).status_code == 503


async def test_mqtt_restart_only_on_mqtt_change():
    started = []

    async def fake(s, *a):
        started.append(s)
        await asyncio.Event().wait()

    m = mqtt.Manager(None, None, runner=fake)
    base = Settings()
    s1 = effective(base, parse(stored(mqtt={"host": "b", "ca_pem": "PEM"})))
    await m.apply(s1)
    await asyncio.sleep(0)
    assert m.starts == 1 and open(started[0].mqtt_ca_file).read() == "PEM"
    ca = started[0].mqtt_ca_file
    await m.apply(effective(base, parse(stored(mqtt={"host": "b", "ca_pem": "PEM"},
                                               screen={"idle_minutes": 1}))))
    assert m.starts == 1
    await m.apply(effective(base, parse(stored(mqtt={"host": "b2"}))))
    await asyncio.sleep(0)
    assert m.starts == 2 and not os.path.exists(ca)
    await m.apply(effective(base, parse(stored(mqtt=None))))
    assert m.task is None
    await m.stop()


def test_legacy_migration(path):
    body = stored(contacts=["a", "b"], presets=[{"id": "p", "targets": [
        {"type": "email", "contact_id": "a"}, {"type": "paperless"}, {"type": "email", "to": "me"}]}],
        legacy_key=1)
    body["contacts"] = [{"id": "a", "name": "Al", "email": "a@x"}]
    body["weird"] = {"x": 1}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(body, f)
    st = SettingsStore(path)
    assert st.load()
    t = st.current().config.presets[0].targets
    assert t == [{"type": "email", "to": "me"}, {"type": "paperless"}, {"type": "email", "to": "me"}]
    dumped = st.current().model_dump()
    assert "contacts" not in dumped and "contacts" not in dumped["config"]


def test_env_presets_email_migrated_without_settings_file():
    tg = [{"type": "email", "contact_id": "5"}, {"type": "email", "to": "x@y.z"},
          {"type": "email", "to": "me"}, {"type": "paperless"}]
    out = Settings(kiosk_presets=json.dumps([{"id": "p", "targets": tg}])).presets()
    out = [x for x in out if x["id"] == "p"]
    assert out[0]["targets"] == [{"type": "email", "to": "me"}] * 3 + [{"type": "paperless"}]
    out = Settings(presets_override=[{"id": "p", "targets": tg}]).presets()
    assert out[0]["targets"][1] == {"type": "email", "to": "me"}


def test_free_form_email_target_migrated_in_store_model():
    c = Config.model_validate({"presets": [{"id": "p", "targets": [
        {"type": "email", "to": "evil@x.z"}]}]})
    assert c.presets[0].targets == [{"type": "email", "to": "me"}]
