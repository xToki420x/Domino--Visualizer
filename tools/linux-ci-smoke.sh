#!/usr/bin/env bash
# Runs exactly the smoke-test command CI runs.
#
# Same script, same flags, same environment variables - so that "it passes
# locally" means the same thing as "it will pass on the runner", which is the
# whole point of having it.
set -uo pipefail

bash "$(dirname "$0")/linux-sync.sh"
export PATH="$HOME/.local/node/bin:$PATH"
cd "${WORK:-$HOME/domino}"

npm run build 2>&1 | tail -2
echo
echo "==> npm run test:smoke:ci"
CI=1 DOMINO_SMOKE_NO_AUDIO=1 npm run test:smoke:ci 2>&1 | tail -22
