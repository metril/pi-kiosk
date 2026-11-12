"""Kiosk-local list of recently signed-in Papyrus user ids (ids + timestamps only)."""
import json
import logging
import os
import time

log = logging.getLogger("kiosk.recent")
MAX = 6


class RecentStore:
    def __init__(self, path: str):
        self.path = path
        self._items: list[dict] | None = None

    def _load(self) -> list[dict]:
        if self._items is None:
            try:
                with open(self.path) as f:
                    d = json.load(f)
                self._items = [{"id": str(x["id"]), "ts": float(x.get("ts", 0))} for x in d
                               if isinstance(x, dict) and x.get("id") is not None][:MAX]
            except (OSError, ValueError, TypeError):
                self._items = []
        return self._items

    def ids(self) -> list[str]:
        return [x["id"] for x in self._load()]

    def _save(self, items: list[dict]) -> bool:
        d = os.path.dirname(self.path) or "."
        tmp = f"{self.path}.{os.getpid()}.tmp"
        try:
            os.makedirs(d, exist_ok=True)
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(items, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
            return True
        except OSError as e:
            log.warning("recent users not written: %r", e)
            try:
                os.unlink(tmp)
            except OSError:
                pass
            return False

    def record(self, uid) -> None:
        uid = str(uid)
        items = [x for x in self._load() if x["id"] != uid]
        new = [{"id": uid, "ts": time.time()}, *items][:MAX]
        self._save(new)
        self._items = new  # in-memory list still serves this session if the disk write failed

    def clear(self) -> bool:
        """Empties the list only if the write succeeded."""
        if not self._save([]):
            return False
        self._items = []
        return True
