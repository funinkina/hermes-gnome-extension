#!/usr/bin/env bash
# Render the popup with a fixture conversation in a headless GNOME Shell and save a screenshot.
# Usage: [HERMES_SCROLL=end] [HERMES_FIXTURE=readme] dev/shot.sh [out.png]
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-/tmp/hermes-shot.png}
ext=~/.local/share/gnome-shell/extensions
log=$(mktemp)
# Isolated copy of dconf: the fixture presses "New chat", which must never touch the real session-id.
cfg=$(mktemp -d)
mkdir -p "$cfg/dconf" && cp ~/.config/dconf/user "$cfg/dconf/user"
ln -sfn "$root/dev/selftest" "$ext/hermes-selftest@dev"
trap 'rm -f "$ext/hermes-selftest@dev"; rm -rf "$cfg"' EXIT
rm -f "$out"
XDG_CONFIG_HOME=$cfg HERMES_SHOT=$out HERMES_SCROLL=${HERMES_SCROLL:-} HERMES_FIXTURE=${HERMES_FIXTURE:-} timeout 60 dbus-run-session -- bash -c '
  gnome-shell --headless --virtual-monitor 1600x900 --wayland >"$0" 2>&1 &
  sleep 8
  gnome-extensions enable hermes@funinkina.com
  gnome-extensions enable hermes-selftest@dev
  for _ in $(seq 40); do grep -q "HSELF shot\|HSELF ERR" "$0" && break; sleep 1; done
  kill %1' "$log" >/dev/null 2>&1 || true
grep -E "HSELF|JS ERROR|JS WARNING|CRITICAL" "$log" | grep -v libmutter || true
[[ -s $out ]] && echo "screenshot: $out"
