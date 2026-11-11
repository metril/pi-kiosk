import pytest


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    # Per-test (hence per-xdist-worker) settings file and cert dir.
    monkeypatch.setenv("SETTINGS_PATH", str(tmp_path / "cfg" / "settings.json"))
    monkeypatch.setenv("ADMIN_CERT_DIR", str(tmp_path / "cfg"))


def force_unlock(app, token="UTOK"):
    """Inject an active unlock session (no Papyrus grant flow)."""
    import time
    from kiosk_api.session import UnlockSession
    now = time.monotonic()
    app.state.unlock.session = UnlockSession("u", token, "t1", now, now)
