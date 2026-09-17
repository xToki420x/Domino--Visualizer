#!/usr/bin/env bash
# Copies the working tree into the Linux checkout, leaving node_modules alone.
#
# Sourced by the verify and package scripts so a change made on the Windows
# side is picked up without a reinstall: `npm ci` removes node_modules and
# rebuilds it from scratch, which is minutes, and none of that is needed to
# test an edit to a source file.
set -euo pipefail

WORK="${WORK:-$HOME/domino}"
SRC="${SRC:-/mnt/e/milkytoy}"

mkdir -p "$WORK"
tar -C "$SRC" \
  --exclude=node_modules \
  --exclude=release \
  --exclude=out \
  --exclude=native/build \
  --exclude=.git \
  -cf - . | tar -C "$WORK" -xf -
