#!/usr/bin/env bash
# Checks every dependency the .deb declares is actually installable here.
#
# A package naming a dependency the distribution does not have is worse than
# one naming none: apt refuses to install it outright. Ubuntu 24.04 renamed a
# set of libraries for the 64-bit time_t transition - libasound2 became
# libasound2t64, and so on - which is why the control file lists alternatives,
# and why this has to understand them.
set -u

DEB=$(ls "${WORK:-$HOME/domino}"/release/*.deb 2>/dev/null | head -1)
[ -z "$DEB" ] && { echo "no .deb built"; exit 1; }

. /etc/os-release 2>/dev/null || true
echo "checking $(basename "$DEB") against ${PRETTY_NAME:-this system}"

installable() {
  apt-cache policy "$1" 2>/dev/null | grep -q 'Candidate: [^(]'
}

missing=0
IFS=','
for clause in $(dpkg-deb -f "$DEB" Depends); do
  clause="$(echo "$clause" | sed 's/^ *//; s/ *$//')"
  [ -z "$clause" ] && continue

  satisfied_by=""
  old_ifs="$IFS"; IFS='|'
  for alt in $clause; do
    name="$(echo "$alt" | sed 's/^ *//; s/ .*//')"
    [ -n "$name" ] && installable "$name" && { satisfied_by="$name"; break; }
  done
  IFS="$old_ifs"

  if [ -n "$satisfied_by" ]; then
    echo "  ok       $clause  -> $satisfied_by"
  else
    echo "  MISSING  $clause"
    missing=1
  fi
done
unset IFS

[ "$missing" = 0 ] && echo "every dependency resolves" || echo "some dependencies do not resolve"
exit "$missing"
