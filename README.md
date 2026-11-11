# pi-kiosk

Touch launcher for a Raspberry Pi with a touchscreen (tested: Pi 4B, Pi OS Lite bookworm arm64, official 7" DSI 800x480) controlling Papyrus (printer/scanner) and a Brother PT-E720BT label maker.

## Architecture

```
Chromium (cage/Wayland) -> kiosk-api :8090 -> Papyrus  /api/v1  (Bearer, server-side)
                                           -> Label app /api/v1 (Bearer, server-side)
Label app (server) --mTLS :9177--> labelmaker-bridge --USB--> PT-E720BT
```

Three containers (`compose.yaml`):
- `labelmaker-bridge`: USB bridge for the printer (published label-maker image).
- `kiosk-api`: FastAPI; serves the SPA, proxies an allowlist of Papyrus/label endpoints with tokens injected server-side, and `POST /kiosk/screen/{on|off}` (backlight `bl_power`).
- `kiosk-display`: cage + Chromium kiosk, `network_mode: host`, privileged (DRM/VT/input).

## Setup on the Pi

1. `git clone` this repo on the Pi, then `sudo ./host/setup.sh` (udev rule, docker group, disables `getty@tty1`, `consoleblank=0`). Log out/in and reboot.
2. Pair the bridge (below) before the first start.
3. Create a kiosk token in Papyrus -> Settings -> Kiosks, then set `PAPYRUS_URL` and `PAPYRUS_TOKEN` in `.env` (`host/setup.sh` creates `.env` and fills `BRIDGE_BIND` and `BACKLIGHT_DEVICE`).
4. `docker compose up -d` (use `docker compose pull` to update), then configure at the admin UI (`https://<pi-host>:8443`).

## Configuration

Settings live on the Pi (`/var/lib/pi-kiosk/settings.json`, mode 0600, `kioskconfig` volume) and are edited in the admin UI below; changes apply live (presets, contacts, timeouts, name, label maker, MQTT restarts only when its settings change). Contacts are references into the Papyrus address book (`GET /api/v1/contacts`); names/emails and SMB share names are resolved with the shared token and cached in the settings file for offline use. `GET /kiosk/config` and `GET /kiosk/screen` carry `config_rev`, which changes when the settings do.

## Admin UI: https://<pi-host>:8443

A separate server (same process, own port; none of the kiosk routes are reachable on it) bound to `ADMIN_BIND` (default `BRIDGE_BIND`). Sign in with a Papyrus account that has the `admin` role: `/admin/login` shows a QR and code (Papyrus device grant); non-admins are denied and their token revoked. Sessions are server-side (HttpOnly, Secure, SameSite=Strict cookie; 15 min idle, 60 min max) and the Papyrus token is revoked on logout/expiry. Mutating requests need `X-Kiosk-Admin: 1`.

- HTTPS uses a self-signed certificate generated on first start (SANs: `ADMIN_BIND`, hostname, `ADMIN_SAN_HOSTS`) and kept in the volume. Its SHA-256 fingerprint is logged at start (`docker compose logs kiosk-api`); compare it when the browser warns.
- Behind a reverse proxy that terminates TLS, set `ADMIN_TLS=off` (plain HTTP to the proxy; the cookie stays Secure) and keep `ADMIN_BIND` private. HSTS is sent when `ADMIN_TLS` is on. A plain-HTTP LAN without a proxy needs `ADMIN_COOKIE_SECURE=false`.
- Login limits (5 starts/min and 3 pending sign-ins per client IP, 20 overall; a sign-in whose browser stops polling for 30 s is dropped) key on the client IP. Behind a reverse proxy all clients share the proxy's IP unless you set `ADMIN_TRUSTED_PROXIES` (comma-separated proxy IPs whose `X-Forwarded-For` is trusted; default none).
- Changing the label maker URL or MQTT host/port clears the stored key/password unless a new one is supplied; the Test buttons follow the same rule.
- Contacts and SMB shares are managed in Papyrus (address book at `<papyrus>/contacts`); the kiosk token is managed at `<papyrus>/settings?tab=kiosks`.

`.env` keeps only host-level settings:
- `PAPYRUS_URL`, `PAPYRUS_TOKEN` (the kiosk token).
- `ADMIN_BIND` (optional), `ADMIN_TLS`, `ADMIN_SAN_HOSTS`: see Admin UI.
- `BRIDGE_BIND`: LAN IP the label-maker bridge listens on (detected by `host/setup.sh`).
- `BACKLIGHT_DEVICE` (varies by screen/kernel, detected by `host/setup.sh`): entry in `/sys/class/backlight`; only that device is mounted into `kiosk-api`. `host/setup.sh` installs `99-backlight.rules` so `bl_power` is writable by the non-root api user.
- Legacy env overrides (`SCAN_*`, `KIOSK_PRESETS`, `MQTT_*`, ...) only seed the admin UI until the first save; see `.env.example`.

Unlock: the kiosk is locked by default (scan, copy, labels, queue). Send-to, share/cloud browsing, remote print and delete need a phone sign-in (QR, Papyrus device grant, Papyrus 1.5.0+). The per-user token stays in `kiosk-api` memory only and is revoked on lock, idle/max timeout or restart. Locked proxy calls return `401 {"detail":"locked"}`.
- Endpoints: `/kiosk/unlock/{start,state,touch}`, `/kiosk/lock`, `/kiosk/send`, `/kiosk/send/email`, `/kiosk/print/remote`, `/kiosk/print/scan/{id}`.

## Home Assistant

Optional, via MQTT discovery (no inbound port). Configure the broker (host, port, credentials, TLS, CA, discovery prefix, node id) in the admin UI (with a Test button); no MQTT config disables it. Changes restart the MQTT client automatically. Re-run `sudo ./host/setup.sh` once so the host units and `/run/pi-kiosk` exist.

Entities: screen light (on/off, brightness if supported), buttons (reload page, restart kiosk, reboot Pi), sensors (CPU temp, CPU %, memory %, disk %, load, boot time), throttled binary sensor, a `Locked` binary sensor, an `Unlocked user` sensor and a `Lock` button (force-lock), and an `update` entity for the images.

TLS: enable it and paste the CA certificate (PEM) in the admin UI's MQTT settings for a private CA; skipping the hostname check is possible but discouraged.

Security: command topics can reboot the Pi. Give the kiosk's MQTT user its own credentials and an ACL that lets only this client (and HA) publish to `<node id>` command topics.

Mosquitto ACL example (kiosk user limited to its own prefix plus discovery; node id `kiosk`):

```
user kiosk
topic readwrite pi-kiosk/kiosk/#
topic readwrite homeassistant/#
```

Updating: press Install on the HA update entity (checked hourly by `pi-kiosk-update-check.timer`), or manually: `docker compose pull && docker compose up -d`.

## Tokens

- Papyrus: Settings -> Kiosks, create a kiosk; its token (permissions `print`, `scan`, `device`) is `PAPYRUS_TOKEN`. Label maker URL/key are set in the admin UI.

## Bridge pairing

The bridge port is published only on `BRIDGE_BIND` (required in `.env`; auto-detected by `host/setup.sh`; compose refuses to start without it). It should be the Pi's LAN IP so the label app can reach `<pi-host>:9177`, or `127.0.0.1` if the app runs on the Pi. Never `0.0.0.0`.

```bash
docker compose run --rm -T labelmaker-bridge python -m labelmaker.driver.bridge show-cert
# label app: Settings -> printer mode Remote, address <pi-host>:9177, paste cert, save
# copy the app certificate it shows into app.crt on the Pi
docker compose run --rm -T labelmaker-bridge python -m labelmaker.driver.bridge pair - < app.crt
```

The bridge refuses to start unpaired.

## Adapting to other hardware

- Other screen: set `BACKLIGHT_DEVICE` to the matching `/sys/class/backlight` entry (`ls /sys/class/backlight`).
- No backlight: screen on/off is unavailable. `POST /kiosk/screen/{on|off}` returns 503 `no_backlight` when no device is mounted; the rest of the kiosk works. The compose bind mount of `/sys/class/backlight/${BACKLIGHT_DEVICE}` will fail to start the container if that path does not exist, so remove that `volumes` line from `kiosk-api` in `compose.yaml`.
- Other Brother USB printer: change `idProduct` in `host/99-brother-pte720bt.rules` (find it with `lsusb`) and re-run `sudo ./host/setup.sh`.
- Other arm64 Debian boards likely work but are untested.

## Troubleshooting

- Black screen / cage fails: check `docker compose logs kiosk-display`; ensure `getty@tty1` is masked and nothing else holds the VT.
- Screen never turns off/on: `docker compose logs kiosk-api`; verify `ls /sys/class/backlight` on the host that `BACKLIGHT_DEVICE` matches, and that `/sys/class/backlight/<dev>/bl_power` is 0666 (udev rule).
- Screen blanks by itself: `consoleblank=0` missing from `/boot/firmware/cmdline.txt` (reboot after setup).
- Label printing fails: `docker compose ps` for bridge health, replug the printer, confirm udev rule (`ls -l /dev/bus/usb/*/*`), re-pair.
- 401/403 in the UI: token missing scope/permission (check the kiosk's label maker key in Papyrus).
- 502 `upstream_unreachable`: wrong `*_URL` or the server is down.
- Touch offset/rotation: check `docker compose exec kiosk-display ls /dev/input`.
