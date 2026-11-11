import pytest


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    # Per-test (hence per-xdist-worker) settings file and cert dir.
    monkeypatch.setenv("SETTINGS_PATH", str(tmp_path / "cfg" / "settings.json"))
    monkeypatch.setenv("ADMIN_CERT_DIR", str(tmp_path / "cfg"))
