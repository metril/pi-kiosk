"""In-memory unlock session (never persisted, never sent to the browser)."""
import asyncio
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field


@dataclass
class UnlockSession:
    user: object
    token: str
    token_id: str
    started: float
    last_activity: float

    @property
    def user_name(self) -> str:
        u = self.user
        if isinstance(u, dict):
            return str(u.get("display_name") or u.get("name") or u.get("username") or u.get("email") or "user")
        return str(u or "user")


@dataclass
class Unlock:
    idle_s: int
    max_s: int
    revoke: object = None  # async callable(UnlockSession)
    clock: object = time.monotonic
    session: UnlockSession | None = None
    flow: str = "locked"  # locked | pending | denied | expired | error
    flow_info: dict = field(default_factory=dict)
    listeners: list = field(default_factory=list)
    busy_n: int = 0  # in-flight long operations; suspend idle expiry
    gen: int = 0  # bumped by lock()/unlock_start(); stales in-flight polls

    def _notify(self):
        for cb in list(self.listeners):
            cb()

    def expired(self) -> bool:
        s = self.session
        if not s:
            return False
        now = self.clock()
        return (self.busy_n <= 0 and now - s.last_activity >= self.idle_s) \
            or now - s.started >= self.max_s

    def active(self) -> UnlockSession | None:
        return self.session if self.session and not self.expired() else None

    @asynccontextmanager
    async def busy(self):
        self.busy_n += 1
        try:
            yield
        finally:
            self.touch()
            self.busy_n -= 1

    def touch(self):
        if self.active():
            self.session.last_activity = self.clock()

    def set_flow(self, flow: str, **info):
        self.flow, self.flow_info = flow, info
        self._notify()

    async def _revoke(self, s: UnlockSession):
        if self.revoke:
            try:
                await self.revoke(s)
            except Exception:  # best effort; token is short-lived anyway
                pass

    async def start(self, user, token: str, token_id: str, gen: int | None = None) -> bool:
        """Begin a session. A grant for a stale generation is revoked, not used."""
        if gen is not None and gen != self.gen:
            await self._revoke(UnlockSession(user, token, token_id, 0, 0))
            return False
        old, now = self.session, self.clock()
        self.session = UnlockSession(user, token, token_id, now, now)
        self.set_flow("locked")
        if old:
            await self._revoke(old)
        return True

    async def lock(self):
        self.gen += 1
        s, self.session = self.session, None
        self.flow, self.flow_info = "locked", {}
        if s:
            await self._revoke(s)
        self._notify()

    async def reap(self):
        if self.expired():
            await self.lock()

    def request_lock(self):
        asyncio.get_running_loop().create_task(self.lock())

    def snapshot(self) -> dict:
        s = self.active()
        if s:
            now = self.clock()
            idle = max(0, int(self.idle_s - (now - s.last_activity)))
            left = max(0, int(self.max_s - (now - s.started)))
            return {"state": "unlocked", "user": s.user_name,
                    "remaining_s": min(idle, left), "idle_remaining_s": idle}
        out = {"state": self.flow if self.flow != "locked" else "locked"}
        out.update(self.flow_info)
        return out

    async def reaper(self, every: float = 1.0):
        while True:
            await asyncio.sleep(every)
            await self.reap()
