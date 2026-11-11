#!/bin/bash
set -euo pipefail

# cage refuses to run as root, so seatd (root) brokers DRM/input devices and
# cage + chromium run as the unprivileged kiosk user.
KIOSK_UID="$(id -u kiosk)"
export HOME=/home/kiosk
export XDG_RUNTIME_DIR="/run/user/$KIOSK_UID"
export LIBSEAT_BACKEND=seatd
export SEATD_SOCK=/run/seatd.sock
mkdir -p "$XDG_RUNTIME_DIR"
chown kiosk:kiosk "$XDG_RUNTIME_DIR"
chmod 0700 "$XDG_RUNTIME_DIR"

# Chromium opens the GPU render node directly: join the host's device groups.
GROUPS_CSV="$(stat -c %g /dev/dri/* 2>/dev/null | sort -u | paste -sd, -)"

SEATD_PID=""
CAGE_PID=""
cleanup() {
  [ -n "$CAGE_PID" ] && kill -TERM "$CAGE_PID" 2>/dev/null || true
  [ -n "$SEATD_PID" ] && kill -TERM "$SEATD_PID" 2>/dev/null || true
}
trap 'cleanup; exit 0' TERM INT

rm -f /run/seatd.sock
seatd -g kiosk &
SEATD_PID=$!

for _ in $(seq 1 50); do
  [ -S /run/seatd.sock ] && break
  sleep 0.1
done
[ -S /run/seatd.sock ] || { echo "seatd socket missing" >&2; cleanup; exit 1; }

until curl -fsS -o /dev/null http://127.0.0.1:8090/kiosk/config; do
  echo "waiting for kiosk-api..."
  sleep 1
done

# cage must not be exec'd so the TERM trap can stop seatd too; wait is interruptible.
setpriv --reuid=kiosk --regid=kiosk --groups="${GROUPS_CSV:-$(id -g kiosk)}" \
  cage -s -- chromium --kiosk --ozone-platform=wayland --noerrdialogs \
  --overscroll-history-navigation=0 --disable-session-crashed-bubble \
  --disable-dev-tools --disable-extensions --disable-translate \
  --disable-features=Translate --no-first-run \
  --user-data-dir=/tmp/chromium --password-store=basic \
  --check-for-update-interval=31536000 --no-sandbox \
  http://127.0.0.1:8090 &
CAGE_PID=$!
rc=0
wait "$CAGE_PID" || rc=$?
cleanup
exit "$rc"
