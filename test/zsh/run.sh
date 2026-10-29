#!/usr/bin/env bash
# Runs the zsh hook tests in throwaway HOMEs. Requires zsh and node.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)

# 1. Functions driven directly: escaping, exit codes, skips, file modes.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp" "${tmp2:-}"' EXIT
(cd "$tmp" && HOME="$tmp" zsh -f "$repo/test/zsh/driver.zsh" "$repo/capture/zsh/gadget.zsh")
node "$repo/test/zsh/check.mjs" "$tmp/.gadget/capture/zsh.jsonl"

# 2. Real interactive shell sourcing the hook from .zshrc: hooks must fire on their own.
tmp2=$(mktemp -d)
echo "source $repo/capture/zsh/gadget.zsh" > "$tmp2/.zshrc"
printf 'echo one\nfalse\n echo hidden\necho two\nexit\n' \
  | (cd "$tmp2" && HOME="$tmp2" ZDOTDIR="$tmp2" zsh -i >/dev/null 2>&1)
node -e '
  const fs = require("fs");
  const recs = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const got = JSON.stringify(recs.map((r) => [r.cmd, r.exit]));
  const want = JSON.stringify([["echo one", 0], ["false", 1], ["echo two", 0]]);
  if (got !== want) { console.error("interactive: got " + got + ", want " + want); process.exit(1); }
  console.log("zsh hook interactive: OK (" + recs.length + " records)");
' "$tmp2/.gadget/capture/zsh.jsonl"
