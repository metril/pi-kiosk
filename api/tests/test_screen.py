import httpx
import pytest

from kiosk_api.config import Settings
from kiosk_api.main import create_app
from kiosk_api.screen import NoBrightness, Screen


@pytest.fixture
def bl(tmp_path):
    d = tmp_path / "bl" / "d0"
    d.mkdir(parents=True)
    (d / "bl_power").write_text("1")
    (d / "brightness").write_text("50")
    (d / "max_brightness").write_text("255")
    return tmp_path / "bl", d


def test_init_and_state(bl):
    s = Screen(str(bl[0]))
    assert s.state() == {"on": False, "brightness": 50, "max": 255, "reload_seq": 0}


def test_set_clamps_and_notifies(bl):
    s, calls = Screen(str(bl[0])), []
    s.listeners.append(lambda: calls.append(1))
    assert s.set_brightness(999) == 255 and (bl[1] / "brightness").read_text() == "255"
    assert s.set_brightness(-5) == 0
    s.set_on(True)
    s.reload()
    assert s.on and s.reload_seq == 1 and len(calls) == 4


def test_unsupported(tmp_path):
    s = Screen(str(tmp_path / "none"))
    assert s.state() == {"on": True, "brightness": None, "max": None, "reload_seq": 0}
    with pytest.raises(NoBrightness):
        s.set_brightness(1)


async def test_endpoints(bl, tmp_path):
    app = create_app(Settings(backlight_path=str(bl[0]), static_dir=str(tmp_path)))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://k") as c:
        assert (await c.post("/kiosk/screen/brightness/300")).status_code == 204
        assert (bl[1] / "brightness").read_text() == "255"
        assert (await c.get("/kiosk/screen")).json()["brightness"] == 255
    app = create_app(Settings(backlight_path=str(tmp_path / "x"), static_dir=str(tmp_path)))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://k") as c:
        r = await c.post("/kiosk/screen/brightness/5")
        assert r.status_code == 503 and r.json() == {"error": {"code": "no_brightness"}}
        assert (await c.get("/kiosk/screen")).json()["max"] is None
