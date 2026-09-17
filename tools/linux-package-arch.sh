#!/usr/bin/env bash
# Builds the Arch package on Arch, and reads its metadata back.
#
# The .pacman target needs bsdtar, which Arch has and Debian does not unless
# libarchive-tools is installed - so this is the machine to build it on, and
# the reason the Debian-based CI job installs that package explicitly.
set -uo pipefail

bash "$(dirname "$0")/linux-sync.sh"
export PATH="$HOME/.local/node/bin:$PATH"
cd "${WORK:-$HOME/domino}"

echo "==> building"
npm run build 2>&1 | tail -3

echo
echo "==> packaging (pacman)"
npx electron-builder --linux pacman --publish never 2>&1 | grep -viE '^\s*$' | tail -20

PAC=$(ls release/*.pacman 2>/dev/null | head -1)
if [ -z "$PAC" ]; then
  echo "-- no .pacman produced"
  exit 1
fi

echo
echo "==> $PAC ($(du -h "$PAC" | cut -f1))"
# A .pacman is a compressed tarball carrying .PKGINFO; reading it back is the
# cheapest proof the package is well formed and the metadata landed.
bsdtar -xOf "$PAC" .PKGINFO 2>/dev/null | head -14 || echo "(could not read .PKGINFO)"

echo
echo "==> files it would install (first 10)"
bsdtar -tf "$PAC" 2>/dev/null | grep -v '^\.' | head -10
