#!/usr/bin/env bash
# Runs the smoke test on the software renderer, with a display present.
#
# A CI runner has a display (xvfb supplies one) but no GPU, so what matters is
# whether Chromium falls back to SwiftShader cleanly. WSLg provides a real GPU,
# which is exactly why the local run passes and the runner does not - forcing
# ANGLE onto SwiftShader here reproduces the runner's graphics stack without
# taking the display away.
set -uo pipefail

bash "$(dirname "$0")/linux-sync.sh"
export PATH="$HOME/.local/node/bin:$PATH"
cd "${WORK:-$HOME/domino}"

npm run build 2>&1 | tail -2

echo
echo "==> smoke test forced onto SwiftShader"
CI=1 DOMINO_SMOKE_NO_AUDIO=1 \
  npx electron \
    --no-sandbox \
    --use-gl=angle \
    --use-angle=swiftshader \
    --enable-unsafe-swiftshader \
    test/smoke.cjs 2>&1 | tail -30
