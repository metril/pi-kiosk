#!/usr/bin/env bash
# Pull images, compare running containers to the pulled ones, write /run/pi-kiosk/update.json.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT=/run/pi-kiosk/update.json
dc() { docker compose --project-directory "$ROOT" "$@"; }

dc pull -q || true

short() { # image id/ref -> first 7 chars of OCI revision label, else short image ID
  local rev id
  rev="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1" 2>/dev/null || true)"
  if [ -n "$rev" ] && [ "$rev" != "<no value>" ]; then echo "${rev:0:7}"; return; fi
  id="$(docker image inspect -f '{{.Id}}' "$1")"; id="${id#sha256:}"; echo "${id:0:7}"
}

id7() { local id; id="$(docker image inspect -f '{{.Id}}' "$1")"; id="${id#sha256:}"; echo "${id:0:7}"; }

available=false
installed=""; latest=""
# "service image" pairs from the resolved compose config
while read -r svc ref; do
  cid="$(dc ps -q "$svc" | head -n1)"
  [ -n "$cid" ] || continue
  cur="$(docker inspect -f '{{.Image}}' "$cid")"
  new="$(docker image inspect -f '{{.Id}}' "$ref")"
  if [ "$cur" != "$new" ]; then
    # report the first outdated service
    if [ "$available" = false ]; then installed="$(short "$cur")"; latest="$(short "$new")"; fi
    available=true
  elif [ "$available" = false ] && [ -z "$installed" ]; then
    installed="$(short "$cur")"; latest="$installed"
  fi
  if [ "$cur" != "$new" ] && [ "$installed" = "$latest" ]; then
    installed="$(id7 "$cur")"; latest="$(id7 "$new")"
  fi
done < <(dc config --format json | python3 -c 'import json,sys
for k, v in json.load(sys.stdin)["services"].items(): print(k, v["image"])')

[ -n "$installed" ] || { installed=unknown; latest=unknown; }
mkdir -p "$(dirname "$OUT")"
tmp="$(mktemp "$OUT.XXXXXX")"
printf '{"installed":"%s","latest":"%s","available":%s,"checked":"%s"}\n' \
  "$installed" "$latest" "$available" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
chmod 0644 "$tmp"
mv "$tmp" "$OUT"
