#!/usr/bin/env bash
# Runs the zsh hook tests in throwaway HOMEs. Requires zsh and node.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)

# 1. Functions driven directly: escaping, exit codes, skips, file modes.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp" "${tmp2:-}"' EXIT
(cd "$tmp" && HOME="$tmp" zsh -f "$repo/test/zsh/driver.zsh" "$repo/capture/zsh/gadget.zsh")
node "$repo/test/zsh/check.mjs" "$tmp/.gadget/capture/zsh.jsonl"

# 2. An existing log with a permissive mode is made private when the hook is sourced.
tmp3=$(mktemp -d)
mkdir -p "$tmp3/logs" && : > "$tmp3/logs/zsh.jsonl" && chmod 644 "$tmp3/logs/zsh.jsonl"
(cd "$tmp3" && HOME="$tmp3" GADGET_ZSH_LOG="$tmp3/logs/zsh.jsonl" zsh -f -c "source '$repo/capture/zsh/gadget.zsh'; _gadget_preexec 'echo x'; true; _gadget_precmd")
mode=$(node -e 'console.log((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$tmp3/logs/zsh.jsonl")
lines=$(wc -l < "$tmp3/logs/zsh.jsonl")
if [ "$mode" != "600" ] || [ "$lines" -ne 1 ]; then echo "existing log: mode $mode, $lines lines; want 600, 1"; exit 1; fi
echo "zsh hook existing log: OK (mode 600)"
rm -rf "$tmp3"

# 3. Real interactive shell sourcing the hook from .zshrc: hooks must fire on their own.
# +Z disables ZLE (which would otherwise open /dev/tty when a controlling terminal is present)
# and -d skips /etc/z* global files while keeping -i interactive hook execution.
tmp2=$(mktemp -d)
echo "source $repo/capture/zsh/gadget.zsh" > "$tmp2/.zshrc"
printf 'echo one\nfalse\n echo hidden\necho two\nexit\n' \
  | (cd "$tmp2" && HOME="$tmp2" ZDOTDIR="$tmp2" zsh +Z -d -i >/dev/null 2>&1)
node -e '
  const fs = require("fs");
  const recs = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const got = JSON.stringify(recs.map((r) => [r.cmd, r.exit]));
  const want = JSON.stringify([["echo one", 0], ["false", 1], ["echo two", 0]]);
  if (got !== want) { console.error("interactive: got " + got + ", want " + want); process.exit(1); }
  console.log("zsh hook interactive: OK (" + recs.length + " records)");
' "$tmp2/.gadget/capture/zsh.jsonl"
