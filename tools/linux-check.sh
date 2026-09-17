#!/usr/bin/env bash
# Probes a Linux environment for what Domino needs to build, package and run.
#
# Used to develop and verify the Linux port from a Windows workstation via WSL,
# where the alternative is guessing at CI logs nobody can read.
set -u

. /etc/os-release 2>/dev/null || true
echo "distro:   ${PRETTY_NAME:-unknown}"
echo "arch:     $(uname -m)"
echo "display:  DISPLAY='${DISPLAY:-}' WAYLAND_DISPLAY='${WAYLAND_DISPLAY:-}'"
echo "user:     $(id -un) (uid $(id -u))"

for tool in node npm bsdtar fakeroot dpkg-deb makepkg pacman tar curl xz; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "have:     $tool"
  else
    echo "MISSING:  $tool"
  fi
done

# Electron's runtime dependencies. A missing one shows up as a process that
# exits immediately with nothing useful on stderr.
for lib in libgtk-3.so.0 libnss3.so libatk-1.0.so.0 libgbm.so.1 libasound.so.2; do
  ldconfig -p 2>/dev/null | grep -q "$lib" && echo "have:     $lib" || echo "MISSING:  $lib"
done

NODE_HOME="$HOME/.local/node"
[ -x "$NODE_HOME/bin/node" ] && echo "node:     $("$NODE_HOME/bin/node" -v) under $NODE_HOME" \
  || echo "node:     not installed under $NODE_HOME"
