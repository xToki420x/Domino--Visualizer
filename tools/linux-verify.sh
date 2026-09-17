#!/usr/bin/env bash
# Runs the same checks the Linux CI job does, on a real Linux machine.
#
# The point is to stop guessing: GitHub Actions logs are not readable without
# repository admin rights, so a failing Linux job is otherwise a black box.
set -uo pipefail

bash "$(dirname "$0")/linux-sync.sh"
export PATH="$HOME/.local/node/bin:$PATH"
cd "${WORK:-$HOME/domino}"

step() {
  echo
  echo "==================== $1 ===================="
}

fail=0
run() {
  local label="$1"; shift
  step "$label"
  if "$@"; then
    echo "-- OK: $label"
  else
    echo "-- FAILED: $label"
    fail=1
  fi
}

echo "node $(node -v) on $(. /etc/os-release; echo "$PRETTY_NAME")"

run "build:native (should skip)" npm run build:native
run "typecheck" npm run typecheck
run "unit tests" npm test
run "build" npm run build

step "smoke test"
# WSLg supplies a display, so no xvfb is needed here. Keep the audio assertions
# off: there is no loopback device to capture in this environment.
if DOMINO_SMOKE_NO_AUDIO=1 npm run test:smoke 2>&1 | tail -40; then
  echo "-- OK: smoke test"
else
  echo "-- FAILED: smoke test"
  fail=1
fi

echo
echo "==================== result ===================="
[ "$fail" = 0 ] && echo "ALL LINUX CHECKS PASSED" || echo "SOME LINUX CHECKS FAILED"
exit "$fail"
