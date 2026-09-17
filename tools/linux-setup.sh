#!/usr/bin/env bash
# Prepares a Linux checkout of Domino and installs a private Node toolchain.
#
# Deliberately needs no root: it unpacks the official Node tarball under
# ~/.local, which means the Linux port can be developed and tested on any
# machine the developer can log into, including a WSL distribution where sudo
# would prompt for a password nobody is there to type.
#
# Source is copied out of the Windows filesystem rather than built in place:
# npm on a /mnt/... drvfs path is slow enough to change how the work feels.
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.17.0}"
NODE_HOME="$HOME/.local/node"
WORK="${WORK:-$HOME/domino}"
SRC="${SRC:-/mnt/e/milkytoy}"

if [ ! -x "$NODE_HOME/bin/node" ]; then
  echo "==> installing node $NODE_VERSION into $NODE_HOME"
  mkdir -p "$NODE_HOME"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C "$NODE_HOME" --strip-components=1
fi
export PATH="$NODE_HOME/bin:$PATH"
echo "node $(node -v), npm $(npm -v)"

echo "==> syncing source into $WORK"
mkdir -p "$WORK"
# Everything except build outputs and the Windows dependency tree, which is
# full of win32 binaries that would be useless here.
tar -C "$SRC" \
  --exclude=node_modules \
  --exclude=release \
  --exclude=out \
  --exclude=native/build \
  --exclude=.git \
  -cf - . | tar -C "$WORK" -xf -

cd "$WORK"
echo "==> npm ci"
npm ci --no-audit --no-fund

echo "==> ready in $WORK"
