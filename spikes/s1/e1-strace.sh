#!/usr/bin/env bash
# E1, Linux only: records every file the satellite's process tree touches during one
# turn, then fails if any of it is under the fake owner home or the real ~/.dsh.
set -euo pipefail

fake_home="$(mktemp -d)"
mkdir -p "$fake_home/.dsh"
echo sentinel > "$fake_home/.dsh/.credentials.yaml"
trace="$(mktemp)"

strace -f -qq -e trace=file -o "$trace" node --no-warnings spikes/s1/src/e1-one-turn.ts "$fake_home"

# execve lines carry argv, which legitimately names the fake home once.
hits="$(grep -v 'execve(' "$trace" | grep -F -e "$fake_home" -e "$HOME/.dsh" || true)"
if [ -n "$hits" ]; then
  echo "E1 FAILED: the satellite touched an owner path:" >&2
  echo "$hits" | head -20 >&2
  exit 1
fi
echo "E1 strace passed: $(wc -l < "$trace") file operations, none under an owner path"
