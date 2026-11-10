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

BL=""
for d in /sys/class/backlight/*; do
  [ -e "$d" ] && { BL="$(basename "$d")"; break; }
done
if [ -n "$BL" ]; then
  echo "BACKLIGHT_DEVICE=$BL"
  if [ -f "$ROOT/.env" ]; then
    if grep -q '^BACKLIGHT_DEVICE=' "$ROOT/.env"; then
      sed -i "s|^BACKLIGHT_DEVICE=.*|BACKLIGHT_DEVICE=$BL|" "$ROOT/.env"
    else
      echo "BACKLIGHT_DEVICE=$BL" >> "$ROOT/.env"
    fi
    echo "set BACKLIGHT_DEVICE in $ROOT/.env"
  else
    echo "no .env yet: set BACKLIGHT_DEVICE=$BL after cp .env.example .env"
  fi
else
  echo "no /sys/class/backlight device found (screen on/off unavailable)"
fi

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
  5. cp .env.example .env, fill in tokens, then: docker compose up -d
MSG
