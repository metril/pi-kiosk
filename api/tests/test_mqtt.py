import json

import pytest

from kiosk_api import mqtt
from kiosk_api.config import Settings
from kiosk_api.screen import Screen


@pytest.fixture
def env(tmp_path):
    d = tmp_path / "bl" / "d0"
    d.mkdir(parents=True)
    (d / "bl_power").write_text("0")
    (d / "brightness").write_text("10")
    (d / "max_brightness").write_text("100")
    run = tmp_path / "run"
    run.mkdir()
    s = Settings(backlight_path=str(tmp_path / "bl"), run_dir=str(run), kiosk_id="k1")
    return s, Screen(s.backlight_path), run


def test_discovery(env):
    s, _, _ = env
    d = mqtt.discovery(s, 100)
    light = d["homeassistant/light/k1/screen/config"]
    assert light["brightness_scale"] == 100 and light["schema"] == "json"
    assert light["device"]["identifiers"] == ["pi-kiosk-k1"]
    assert d["homeassistant/button/k1/reboot/config"]["entity_category"] == "config"
    assert d["homeassistant/sensor/k1/boot_time/config"]["device_class"] == "timestamp"
    assert d["homeassistant/update/k1/update/config"]["payload_install"]
    assert len(d) == 1 + 4 + 6 + 1 + 2 + 1
    assert "brightness_scale" not in mqtt.discovery(s, None)["homeassistant/light/k1/screen/config"]


def test_commands(env):
    s, scr, run = env
    t = mqtt.topics(s)
    mqtt.handle_command(s, scr, t["screen_set"], json.dumps({"state": "OFF", "brightness": 40}))
    assert not scr.on and scr.brightness()[0] == 40
    mqtt.handle_command(s, scr, t["screen_set"], "garbage")
    mqtt.handle_command(s, scr, t["reload"], "PRESS")
    assert scr.reload_seq == 1
    for k, f in (("restart", "restart"), ("reboot", "reboot")):
        mqtt.handle_command(s, scr, t[k], "PRESS")
        assert (run / f).exists()
    mqtt.handle_command(s, scr, t["update_install"], "INSTALL")
    assert (run / "update").exists()


def test_payloads(env):
    s, scr, run = env
    assert json.loads(mqtt.screen_payload(scr)) == {"state": "ON", "brightness": 10}
    assert json.loads(mqtt.update_payload(str(run)))["installed_version"] is None
    (run / "update.json").write_text('{"installed":"a","latest":"b","available":true}')
    assert json.loads(mqtt.update_payload(str(run))) == {"installed_version": "a", "latest_version": "b"}


class Fake:
    def __init__(self):
        self.pub = []

    async def publish(self, topic, payload, retain=False):
        self.pub.append((topic, payload, retain))


async def test_publish_discovery(env):
    s, scr, _ = env
    c = Fake()
    await mqtt.publish_discovery(c, s, scr)
    assert len(c.pub) == 15 and all(r for _, _, r in c.pub)


def test_non_dict_payload(env):
    s, scr, _ = env
    t = mqtt.topics(s)
    for bad in ("[1]", "5", "null", '"x"'):
        mqtt.handle_command(s, scr, t["screen_set"], bad)
    assert scr.on


async def test_session_publishes_offline_on_cancel(env):
    import asyncio

    class Msgs:
        def __aiter__(self):
            return self

        async def __anext__(self):
            await asyncio.sleep(3600)

    class C(Fake):
        messages = Msgs()

        async def subscribe(self, *_):
            pass

    s, scr, _ = env
    c = C()
    task = asyncio.create_task(mqtt.session(c, s, scr, mqtt.Stats("/nonexistent", "/nonexistent", "/nonexistent")))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert c.pub[-1] == (mqtt.topics(s)["avail"], "offline", True)


def test_tls_params():
    s = Settings()
    assert mqtt.tls_params(s) is None
    s = Settings(mqtt_tls=True)
    assert mqtt.tls_params(s).ca_certs is None
    s = Settings(mqtt_tls=True, mqtt_ca_file="/certs/ca.pem")
    assert mqtt.tls_params(s).ca_certs == "/certs/ca.pem"
    assert s.mqtt_tls_insecure is False
