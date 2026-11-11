from pathlib import Path


class NoBacklight(Exception):
    pass


class NoBrightness(Exception):
    pass


class Screen:
    """Backlight IO plus in-memory state; listeners are called on every change."""

    def __init__(self, path: str):
        self.path = Path(path)
        self.reload_seq = 0
        self.listeners: list = []
        self.on = True
        try:
            self.on = self._read("bl_power") == "0"
        except (NoBacklight, OSError, ValueError):
            pass

    def _dev(self) -> Path:
        devs = sorted(p for p in self.path.glob("*") if p.is_dir()) if self.path.is_dir() else []
        if not devs:
            raise NoBacklight
        return devs[0]

    def _read(self, name: str) -> str:
        return (self._dev() / name).read_text().strip()

    def _notify(self):
        for cb in self.listeners:
            cb()

    def set_on(self, on: bool):
        (self._dev() / "bl_power").write_text("0" if on else "1")
        self.on = on
        self._notify()

    def brightness(self) -> tuple[int | None, int | None]:
        try:
            return int(self._read("brightness")), int(self._read("max_brightness"))
        except (NoBacklight, OSError, ValueError):
            return None, None

    def set_brightness(self, n: int) -> int:
        _, mx = self.brightness()
        if mx is None:
            raise NoBrightness
        n = max(0, min(n, mx))
        try:
            (self._dev() / "brightness").write_text(str(n))
        except OSError as e:
            raise NoBrightness from e
        self._notify()
        return n

    def reload(self):
        self.reload_seq += 1
        self._notify()

    def state(self) -> dict:
        b, mx = self.brightness()
        return {"on": self.on, "brightness": b, "max": mx, "reload_seq": self.reload_seq}
