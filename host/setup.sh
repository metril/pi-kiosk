#!/usr/bin/env bash
# Idempotent host setup for the Pi (Pi OS Lite bookworm). Run: sudo ./host/setup.sh
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"

for RULE in 99-brother-pte720bt.rules 99-backlight.rules; do
  install -m 0644 "$HERE/$RULE" "/etc/udev/rules.d/$RULE"
done
udevadm control --reload-rules
udevadm trigger

# Trigger dir for kiosk-api (reboot/restart/update) and the host units that act on it.
install -m 0644 "$HERE/pi-kiosk.tmpfiles.conf" /etc/tmpfiles.d/pi-kiosk.conf
systemd-tmpfiles --create /etc/tmpfiles.d/pi-kiosk.conf
chmod +x "$HERE/update-check.sh"
for U in "$HERE"/pi-kiosk-*.path "$HERE"/pi-kiosk-*.service "$HERE"/pi-kiosk-*.timer; do
  sed "s|@ROOT@|$ROOT|g" "$U" > "/etc/systemd/system/$(basename "$U")"
done
systemctl daemon-reload
systemctl enable --now pi-kiosk-reboot.path pi-kiosk-restart.path pi-kiosk-update.path pi-kiosk-update-check.timer

if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
  id -nG "$SUDO_USER" | tr ' ' '\n' | grep -qx docker || usermod -aG docker "$SUDO_USER"
fi

systemctl disable --now getty@tty1.service 2>/dev/null || true
systemctl mask getty@tty1.service

CMDLINE=/boot/firmware/cmdline.txt
if [ -f "$CMDLINE" ] && ! grep -qw 'consoleblank=0' "$CMDLINE"; then
  sed -i '1s/[[:space:]]*$/ consoleblank=0/' "$CMDLINE"
  echo "added consoleblank=0 to $CMDLINE (reboot required)"
fi

ENVF="$ROOT/.env"
[ -f "$ENVF" ] || { [ -f "$ROOT/.env.example" ] && cp "$ROOT/.env.example" "$ENVF" && echo "created $ENVF"; }
# Set KEY=VALUE in .env only when missing or empty.
set_missing() {
  local k="$1" v="$2"
  [ -f "$ENVF" ] || return 0
  if grep -q "^$k=." "$ENVF"; then return 0; fi
  if grep -q "^$k=" "$ENVF"; then sed -i "s|^$k=.*|$k=$v|" "$ENVF"; else echo "$k=$v" >> "$ENVF"; fi
  echo "set $k=$v in $ENVF"
}

BL=""
for d in /sys/class/backlight/*; do
  [ -e "$d" ] && { BL="$(basename "$d")"; break; }
done
if [ -n "$BL" ]; then set_missing BACKLIGHT_DEVICE "$BL"
else echo "no /sys/class/backlight device found (screen on/off unavailable)"; fi

IP="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1)"
if [ -n "$IP" ]; then set_missing BRIDGE_BIND "$IP"
else echo "could not detect the LAN IP: set BRIDGE_BIND in $ENVF"; fi

TZN="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
if [ -n "$TZN" ]; then set_missing TZ "$TZN"
else echo "could not detect the timezone: set TZ in $ENVF (e.g. America/New_York)"; fi

cat <<'MSG'

Host ready. Log out/in (docker group) and reboot once. Then pair the bridge
BEFORE the first `docker compose up -d` (run from the repo dir):

  1. Unplug/replug the PT-E720BT.
  2. Show the bridge cert:
       docker compose run --rm -T labelmaker-bridge python -m labelmaker.driver.bridge show-cert
  3. In the label app: Settings -> set printer mode to Remote, enter
     <pi-host>:9177, paste the cert, save. Copy the app certificate shown to app.crt here.
  4. Pair:
       docker compose run --rm -T labelmaker-bridge python -m labelmaker.driver.bridge pair - < app.crt
  5. Set PAPYRUS_URL and PAPYRUS_TOKEN (Papyrus -> Settings -> Kiosks) in .env, then: docker compose up -d
  6. Configure presets, contacts, label maker, MQTT at https://<pi-host>:8443 (Papyrus admin sign-in)
MSG
