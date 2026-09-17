#!/usr/bin/env bash
# Runs the smoke test with no display server at all.
#
# This is what continuous integration actually looks like, and it is the one
# condition a WSL session does not reproduce on its own - WSLg quietly supplies
# a real display and a real GPU, so everything passes locally and then fails on
# a runner with neither. Unsetting DISPLAY and asking Chromium for its headless
# Ozone backend reproduces it without installing anything.
set -uo pipefail

bash "$(dirname "$0")/linux-sync.sh"
export PATH="$HOME/.local/node/bin:$PATH"
cd "${WORK:-$HOME/domino}"

echo "==> building"
npm run build 2>&1 | tail -2

echo
echo "==> smoke test with no display"
env -u DISPLAY -u WAYLAND_DISPLAY \
  CI=1 DOMINO_SMOKE_NO_AUDIO=1 \
  npx electron --ozone-platform=headless --no-sandbox test/smoke.cjs 2>&1 | tail -45
