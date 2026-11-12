"""Local kiosk settings, edited via the admin UI and persisted on the Pi.

The file holds config plus a cache of Papyrus-resolved SMB share names
(for offline use). Never a user/session token.
"""
import asyncio
import json
import logging
import os
from urllib.parse import urlsplit
from typing import Any, Awaitable, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from .config import Settings, migrate_targets

log = logging.getLogger("kiosk.config")

Icon = Literal["file-text", "receipt", "image", "book", "mail", "folder", "archive", "scan"]
ID_RE = r"^[A-Za-z0-9_-]{1,64}$"
URL_RE = r"^https?://\S+$"
KEEP = object()
# Secret fields: section -> key. Masked as {set: bool} on the way out.
SECRETS = {"labelmaker": "token", "mqtt": "password"}


class _M(BaseModel):
    model_config = ConfigDict(extra="ignore", coerce_numbers_to_str=True)  # Papyrus ids are ints


class Share(_M):
    id: str
    name: str = ""


class Unlock(_M):
    idle_s: int = Field(120, ge=5, le=86400)
    max_s: int = Field(900, ge=5, le=86400)


class Login(_M):
    qr: bool = True
    approve: bool = False
    pin: bool = False

    @model_validator(mode="after")
    def _one_on(self):
        if not (self.qr or self.approve or self.pin):
            raise ValueError("at least one login method must be enabled")
        return self


class Screen(_M):
    idle_minutes: int = Field(5, ge=0, le=1440)


class Preset(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str = Field(pattern=ID_RE)
    label: str = ""
    icon: Icon = "scan"
    scan: dict = {}
    post: dict = {}
    delete_after: bool = False
    targets: list[dict] = []

    @field_validator("targets", mode="before")
    @classmethod
    def _migrate_email(cls, v):
        """Legacy kiosk-wide contact targets become the signed-in user's own address."""
        if not isinstance(v, list):
            return v
        return migrate_targets({"targets": v})["targets"]


class Labelmaker(_M):
    url: str = Field(pattern=URL_RE)
    token: str = ""


class Mqtt(_M):
    host: str = Field(min_length=1)
    port: int = Field(1883, ge=1, le=65535)
    username: str = ""
    password: str = ""
    tls: bool = False
    ca_pem: str = ""
    tls_insecure: bool = False
    discovery_prefix: str = "homeassistant"
    node_id: str = ""


class Config(_M):
    name: str = ""
    public_url: str = ""
    unlock: Unlock = Unlock()
    login: Login = Login()
    screen: Screen = Screen()
    presets: list[Preset] = []
    labelmaker: Labelmaker | None = None
    mqtt: Mqtt | None = None


class Stored(_M):
    config: Config
    smb_shares: list[Share] = []
    updated_at: str | None = None


def parse(body) -> Stored:
    return Stored.model_validate(body)


def seed(base: Settings) -> Config:
    """Starting point for the editor when nothing is stored yet: the env values."""
    return Config(
        name=base.kiosk_name, public_url=base.papyrus_public_url,
        unlock=Unlock(idle_s=base.unlock_idle_s, max_s=base.unlock_max_s),
        screen=Screen(idle_minutes=base.idle_minutes),
        presets=[Preset.model_validate(p) for p in base.presets()
                 if isinstance(p.get("id"), str)],
        labelmaker=Labelmaker(url=base.labelmaker_url, token=base.labelmaker_token)
        if base.labelmaker_url else None,
        mqtt=Mqtt(host=base.mqtt_host, port=base.mqtt_port, username=base.mqtt_username,
                  password=base.mqtt_password, tls=base.mqtt_tls, ca_pem=base.mqtt_ca_pem,
                  tls_insecure=base.mqtt_tls_insecure,
                  discovery_prefix=base.mqtt_discovery_prefix) if base.mqtt_host else None)


def mask(cfg: Config) -> dict:
    d = cfg.model_dump()
    for sec, key in SECRETS.items():
        if d.get(sec):
            d[sec][key] = {"set": bool(d[sec][key])}
    return d


def _norm_url(u) -> tuple:
    try:
        p = urlsplit(str(u or "").strip())
        port = p.port or {"http": 80, "https": 443}.get(p.scheme.lower())
        return (p.scheme.lower(), (p.hostname or "").lower(), port, p.path.rstrip("/"))
    except ValueError:
        return ("?", str(u))


def endpoint(sec: str, d) -> tuple:
    """What a secret is bound to: labelmaker -> normalized URL; mqtt -> (host, port)."""
    g = d.get if isinstance(d, dict) else (lambda k, default=None: getattr(d, k, default))
    if sec == "labelmaker":
        return _norm_url(g("url", ""))
    port = g("port", 1883)
    return (str(g("host", "") or "").strip().lower(), 1883 if port is None else port)


def merge_secrets(old: Config | None, body: dict) -> dict:
    """Resolve secret fields in an incoming config: omitted/{set:true} keeps,
    null/""/{set:false} clears, a string sets."""
    out = json.loads(json.dumps(body))
    for sec, key in SECRETS.items():
        d = out.get(sec)
        if not isinstance(d, dict):
            continue
        v = d.get(key, KEEP)
        oldsec = getattr(old, sec, None) if old else None
        prev = getattr(oldsec, key, "") if oldsec else ""
        if v is KEEP or (isinstance(v, dict) and v.get("set") is True):
            # A kept secret stays bound to the endpoint it was stored for.
            same = oldsec is not None and endpoint(sec, d) == endpoint(sec, oldsec)
            d[key] = prev if same else ""
        elif v is None or v == "" or isinstance(v, dict):
            d[key] = ""
        elif not isinstance(v, str):
            raise ValueError(f"{sec}.{key} must be a string, null or {{set: bool}}")
    return out


def effective(base: Settings, st: Stored | None) -> Settings:
    """Stored settings when present (null labelmaker/mqtt = disabled), else the env settings."""
    if st is None:
        return base
    c = st.config
    upd = {
        "kiosk_name": c.name or base.kiosk_name,
        "idle_minutes": c.screen.idle_minutes,
        "papyrus_public_url": c.public_url,
        "unlock_idle_s": c.unlock.idle_s,
        "unlock_max_s": c.unlock.max_s,
        "login_qr": c.login.qr, "login_approve": c.login.approve, "login_pin": c.login.pin,
        "presets_override": [p.model_dump() for p in c.presets],
        "shares": [x.model_dump() for x in st.smb_shares],
        "labelmaker_url": c.labelmaker.url if c.labelmaker else "",
        "labelmaker_token": c.labelmaker.token if c.labelmaker else "",
        "mqtt_host": "", "mqtt_ca_pem": "",
    }
    if c.mqtt:
        m = c.mqtt
        upd.update(mqtt_host=m.host, mqtt_port=m.port, mqtt_username=m.username,
                   mqtt_password=m.password, mqtt_tls=m.tls, mqtt_ca_pem=m.ca_pem,
                   mqtt_ca_file="", mqtt_tls_insecure=m.tls_insecure,
                   mqtt_discovery_prefix=m.discovery_prefix,
                   kiosk_id=m.node_id or base.kiosk_id)
    return base.model_copy(update=upd)


class Subscription:
    def __init__(self, owner: "SettingsStore"):
        self.owner, self.q = owner, asyncio.Queue()

    def __aiter__(self):
        return self

    async def __anext__(self) -> Stored:
        return await self.q.get()

    def close(self):
        if self in self.owner.subs:
            self.owner.subs.remove(self)


class SettingsStore:
    def __init__(self, path: str):
        self.path = path
        self._st: Stored | None = None
        self.rev = 0
        self.subs: list[Subscription] = []
        # Hot-apply hook: awaited after every change (MQTT restart, labelmaker swap, ...).
        self.applier: Callable[[], Awaitable[None]] | None = None
        self._apply_lock = asyncio.Lock()

    def current(self) -> Stored | None:
        return self._st

    def subscribe(self) -> Subscription:
        s = Subscription(self)
        self.subs.append(s)
        return s

    def load(self) -> bool:
        try:
            with open(self.path) as f:
                self._st = parse(json.load(f))
        except (OSError, ValueError, TypeError, ValidationError) as e:
            if not isinstance(e, FileNotFoundError):
                log.warning("settings file unusable: %r", e)
            return False
        self.rev += 1
        return True

    def _save(self, st: Stored):
        """Atomic, 0600 (temp file in the same dir, fsync, rename). Raises OSError."""
        d = os.path.dirname(self.path) or "."
        tmp = f"{self.path}.{os.getpid()}.tmp"
        os.makedirs(d, exist_ok=True)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(st.model_dump(), f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    async def _commit(self, st: Stored):
        self._save(st)
        self._st = st
        self.rev += 1
        for s in list(self.subs):
            s.q.put_nowait(st)
        if self.applier:
            async with self._apply_lock:
                await self.applier()

    async def set_config(self, cfg: Config):
        cur = self._st
        await self._commit(Stored(config=cfg,
                                  smb_shares=cur.smb_shares if cur else []))

    async def set_cache(self, shares: list[Share]) -> bool:
        cur = self._st
        if cur is None or cur.smb_shares == shares:
            return False
        try:
            await self._commit(Stored(config=cur.config, smb_shares=shares))
        except OSError as e:
            log.warning("settings cache not written: %r", e)
            return False
        return True


Call = Callable[..., Awaitable[Any]]


async def refresh_cache(store: SettingsStore, call: Call) -> bool:
    """Resolve SMB share names from Papyrus (shared token) and cache
    them. Offline/any failure keeps the previous cache."""
    cur = store.current()
    if cur is None:
        return False
    try:
        rs = await call("GET", "smb/shares")
        shares = list(cur.smb_shares)
        if rs is not None and rs.status_code == 200:
            shares = [Share.model_validate({**x, "id": str(x["id"])}) for x in rs.json()]
    except Exception as e:  # transport, bad JSON, bad shape
        log.info("settings cache refresh failed: %r", e)
        return False
    return await store.set_cache(shares)
