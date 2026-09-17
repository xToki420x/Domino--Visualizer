#!/usr/bin/env bash
# Builds the Linux packages and checks the shipped binary actually runs.
#
# Same reasoning as the Windows side: packaging changes where the bundled
# preset library is found, so the packaged artefact is verified rather than the
# development build.
set -uo pipefail

bash "$(dirname "$0")/linux-sync.sh"
export PATH="$HOME/.local/node/bin:$PATH"
cd "${WORK:-$HOME/domino}"

echo "==> packaging"
npx electron-builder --linux --publish never 2>&1 | tail -25

echo
bash "$(dirname "$0")/linux-deps-check.sh" || exit 1
echo
echo "==> artefacts"
ls -la release/*.AppImage release/*.deb release/*.pacman 2>/dev/null

APPIMAGE=$(ls release/*.AppImage 2>/dev/null | head -1)
if [ -z "$APPIMAGE" ]; then
  echo "no AppImage produced"
  exit 1
fi

echo
echo "==> running the packaged AppImage with --selftest"
chmod +x "$APPIMAGE"
# --appimage-extract-and-run avoids needing FUSE, which a container or a WSL
# distribution generally does not have.
out=$("$APPIMAGE" --appimage-extract-and-run --selftest 2>&1 || true)
echo "$out"
echo "$out" | grep -q 'SELFTEST PASSED' && echo "-- packaged AppImage OK" || {
  echo "-- packaged AppImage FAILED"
  exit 1
}
