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
3. `cp .env.example .env`, fill in URLs and tokens.
4. `docker compose up -d` (use `docker compose pull` to update).

## Configuration

Set in `.env` (see `.env.example`):
- `BACKLIGHT_DEVICE` (varies by screen/kernel, e.g. `10-0045`, `rpi_backlight`; `host/setup.sh` detects it): entry in `/sys/class/backlight`; only that device is mounted into `kiosk-api` (Docker does not follow the sysfs symlinks). `host/setup.sh` installs `99-backlight.rules` so `bl_power` is writable by the non-root api user.
- Scan destinations, exposed via `GET /kiosk/config`: `SCAN_PAPERLESS` (default `true`), `SCAN_SMB_SHARE_ID` + `SCAN_SMB_PATH`, `SCAN_CLOUD_PROVIDER_ID`, `SCAN_EMAIL_TO`. Empty values disable that destination.

## Home Assistant

Optional, via MQTT discovery (no inbound port). Set `MQTT_HOST` (plus `MQTT_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_TLS`, `MQTT_DISCOVERY_PREFIX`, `KIOSK_ID`, `KIOSK_NAME`, `STATS_INTERVAL`; see `.env.example`) and `docker compose up -d`. Empty `MQTT_HOST` disables it. Re-run `sudo ./host/setup.sh` once so the host units and `/run/pi-kiosk` exist.

Entities: screen light (on/off, brightness if supported), buttons (reload page, restart kiosk, reboot Pi), sensors (CPU temp, CPU %, memory %, disk %, load, boot time), throttled binary sensor, and an `update` entity for the images.

Security: command topics can reboot the Pi. Give the kiosk's MQTT user its own credentials and an ACL that lets only this client (and HA) publish to `<KIOSK_ID>` command topics.

Updating: press Install on the HA update entity (checked hourly by `pi-kiosk-update-check.timer`), or manually: `docker compose pull && docker compose up -d`.

## Tokens

- Label maker: Settings -> API keys, create a key with scope `write` (`lm_...`) -> `LABELMAKER_TOKEN`. Only needed when the label app runs with `AUTH_MODE=oidc`; leave empty with `AUTH_MODE=none` (no auth).
- Papyrus: Settings -> API Tokens, permissions `print` + `scan` (plus `email`/`files` for scan send-to) -> `PAPYRUS_TOKEN`.

## Bridge pairing

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
- 401/403 in the UI: token missing scope/permission (label app with `AUTH_MODE=oidc` needs `LABELMAKER_TOKEN`; with `AUTH_MODE=none` leave it empty).
- 502 `upstream_unreachable`: wrong `*_URL` or the server is down.
- Touch offset/rotation: check `docker compose exec kiosk-display ls /dev/input`.
