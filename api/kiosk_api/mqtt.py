import asyncio
import contextlib
import json
import logging
from pathlib import Path

import aiomqtt

from .config import Settings
from .screen import NoBacklight, NoBrightness, Screen
from .stats import Stats

log = logging.getLogger("kiosk.mqtt")
BUTTONS = {  # object -> (name, device_class, entity_category)
    "reload": ("Reload", None, None),
    "restart": ("Restart", "restart", None),
    "reboot": ("Reboot", "restart", "config"),
    "lock": ("Lock", None, None),
}
SENSORS = [  # object, name, device_class, unit, category
    ("cpu_temp", "CPU temperature", "temperature", "°C", "diagnostic"),
    ("cpu_pct", "CPU usage", None, "%", "diagnostic"),
    ("mem_pct", "Memory usage", None, "%", "diagnostic"),
    ("disk_pct", "Disk usage", None, "%", "diagnostic"),
    ("load1", "Load (1m)", None, None, "diagnostic"),
    ("boot_time", "Last boot", "timestamp", None, "diagnostic"),
]


def topics(s: Settings) -> dict[str, str]:
    b = f"pi-kiosk/{s.kiosk_id}"
    return {"avail": f"{b}/availability", "screen": f"{b}/screen/state", "screen_set": f"{b}/screen/set",
            "stats": f"{b}/stats", "update": f"{b}/update/state", "update_install": f"{b}/update/install", "unlock": f"{b}/unlock/state",
            **{k: f"{b}/{k}/press" for k in BUTTONS}}


def discovery(s: Settings, brightness_max: int | None) -> dict[str, dict]:
    """Return {config_topic: payload}."""
    t = topics(s)
    dev = {"identifiers": [f"pi-kiosk-{s.kiosk_id}"], "name": s.kiosk_name, "manufacturer": "pi-kiosk"}

    def ent(comp, obj, name, **kw):
        cfg = {"name": name, "unique_id": f"pi-kiosk-{s.kiosk_id}-{obj}", "device": dev,
               "availability_topic": t["avail"], **{k: v for k, v in kw.items() if v is not None}}
        return f"{s.mqtt_discovery_prefix}/{comp}/{s.kiosk_id}/{obj}/config", cfg

    out = [ent("light", "screen", "Screen", schema="json", state_topic=t["screen"],
               command_topic=t["screen_set"], supported_color_modes=["brightness" if brightness_max else "onoff"],
               brightness=True if brightness_max else None,
               brightness_scale=brightness_max or None)]
    out += [ent("button", k, n, command_topic=t[k], device_class=dc, entity_category=ec)
            for k, (n, dc, ec) in BUTTONS.items()]
    out += [ent("sensor", k, n, state_topic=t["stats"], value_template=f"{{{{ value_json.{k} }}}}",
                device_class=dc, unit_of_measurement=u, entity_category=ec,
                state_class="measurement" if dc != "timestamp" else None)
            for k, n, dc, u, ec in SENSORS]
    out.append(ent("binary_sensor", "throttled", "Throttled", state_topic=t["stats"],
                   value_template="{{ 'ON' if value_json.throttled else 'OFF' }}",
                   device_class="problem", entity_category="diagnostic"))
    out.append(ent("binary_sensor", "locked", "Locked", state_topic=t["unlock"],
                   value_template="{{ 'ON' if value_json.locked else 'OFF' }}"))
    out.append(ent("sensor", "unlocked_user", "Unlocked user", state_topic=t["unlock"],
                   value_template="{{ value_json.user }}"))
    out.append(ent("update", "update", "Software", state_topic=t["update"],
                   command_topic=t["update_install"], payload_install="INSTALL",
                   entity_category="diagnostic"))
    return dict(out)


def screen_payload(screen: Screen) -> str:
    st = screen.state()
    p = {"state": "ON" if st["on"] else "OFF"}
    if st["brightness"] is not None:
        p["brightness"] = st["brightness"]
    return json.dumps(p)


def update_payload(run_dir: str) -> str:
    try:
        d = json.loads((Path(run_dir) / "update.json").read_text())
        return json.dumps({"installed_version": d.get("installed"), "latest_version": d.get("latest")})
    except (OSError, ValueError, AttributeError):
        return json.dumps({"installed_version": None, "latest_version": None})


def unlock_payload(unlock) -> str:
    st = unlock.snapshot() if unlock else {"state": "locked"}
    return json.dumps({"locked": st["state"] != "unlocked", "user": st.get("user", "")})


def handle_command(s: Settings, screen: Screen, topic: str, payload: str, unlock=None) -> None:
    t = topics(s)
    try:
        if topic == t["screen_set"]:
            d = json.loads(payload)
            if not isinstance(d, dict):
                log.warning("command %s ignored: payload is not an object", topic)
                return
            if "brightness" in d:
                screen.set_brightness(int(d["brightness"]))
            if d.get("state") in ("ON", "OFF"):
                screen.set_on(d["state"] == "ON")
        elif topic == t["lock"]:
            if unlock:
                unlock.request_lock()
        elif topic == t["reload"]:
            screen.reload()
        elif topic in (t["restart"], t["reboot"]):
            (Path(s.run_dir) / ("restart" if topic == t["restart"] else "reboot")).touch()
        elif topic == t["update_install"] and payload == "INSTALL":
            (Path(s.run_dir) / "update").touch()
    except (ValueError, TypeError, OSError, NoBacklight, NoBrightness) as e:
        log.warning("command %s failed: %r", topic, e)


async def publish_discovery(client, s: Settings, screen: Screen):
    for topic, cfg in discovery(s, screen.brightness()[1]).items():
        await client.publish(topic, json.dumps(cfg), retain=True)


async def publish_stats(client, s: Settings, stats: Stats):
    t = topics(s)
    await client.publish(t["stats"], json.dumps(stats.snapshot()))
    await client.publish(t["update"], update_payload(s.run_dir))


async def session(client, s: Settings, screen: Screen, stats: Stats, unlock=None):
    t = topics(s)
    changed = asyncio.Event()
    screen.listeners.append(changed.set)
    unlock_changed = asyncio.Event()
    if unlock:
        unlock.listeners.append(unlock_changed.set)

    async def push_unlock():
        while True:
            await unlock_changed.wait()
            unlock_changed.clear()
            await client.publish(t["unlock"], unlock_payload(unlock), retain=True)

    async def push():
        while True:
            await changed.wait()
            changed.clear()
            await client.publish(t["screen"], screen_payload(screen), retain=True)

    async def loop_stats():
        while True:
            await publish_stats(client, s, stats)
            await asyncio.sleep(s.stats_interval)

    try:
        await client.subscribe(f"{s.mqtt_discovery_prefix}/status")
        for k in ("screen_set", "update_install", *BUTTONS):
            await client.subscribe(t[k])
        await publish_discovery(client, s, screen)
        await client.publish(t["avail"], "online", retain=True)
        await client.publish(t["screen"], screen_payload(screen), retain=True)
        await client.publish(t["unlock"], unlock_payload(unlock), retain=True)
        try:
            async with asyncio.TaskGroup() as tg:
                tg.create_task(push())
                tg.create_task(loop_stats())
                tg.create_task(push_unlock())
                async for m in client.messages:
                    payload = m.payload.decode() if isinstance(m.payload, (bytes, bytearray)) else str(m.payload)
                    if str(m.topic) == f"{s.mqtt_discovery_prefix}/status":
                        if payload == "online":
                            await publish_discovery(client, s, screen)
                    else:
                        handle_command(s, screen, str(m.topic), payload, unlock)
        finally:
            with contextlib.suppress(Exception, asyncio.CancelledError):
                await asyncio.shield(client.publish(t["avail"], "offline", retain=True))
    finally:
        screen.listeners.remove(changed.set)
        if unlock:
            unlock.listeners.remove(unlock_changed.set)


def tls_params(s: Settings) -> aiomqtt.TLSParameters | None:
    if not s.mqtt_tls:
        return None
    return aiomqtt.TLSParameters(ca_certs=s.mqtt_ca_file or None)


async def run(s: Settings, screen: Screen, stats: Stats, unlock=None):
    delay = 1
    while True:
        try:
            async with aiomqtt.Client(
                s.mqtt_host, s.mqtt_port, username=s.mqtt_username or None,
                password=s.mqtt_password or None,
                tls_params=tls_params(s), tls_insecure=s.mqtt_tls and s.mqtt_tls_insecure,
                will=aiomqtt.Will(topics(s)["avail"], "offline", retain=True),
            ) as client:
                delay = 1
                await session(client, s, screen, stats, unlock)
        except asyncio.CancelledError:
            raise
        except (aiomqtt.MqttError, ExceptionGroup, OSError) as e:
            log.warning("mqtt: %r; retry in %ss", e, delay)
        except Exception:
            log.exception("mqtt: unexpected error; retry in %ss", delay)
        await asyncio.sleep(delay)
        delay = min(delay * 2, 60)
