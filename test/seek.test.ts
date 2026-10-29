import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyEvent, isQuestion } from "../src/miner/seek.js";
import { splitCommands } from "../src/miner/shell.js";
import { ev, T0 } from "./helpers.js";

// [command, expected kind or null, expected query]
const CASES: Array<[string, string | null, string?]> = [
  ["grep -rn jitless src/", "GREP", "jitless"],
  ["grep -r foo .", "GREP", "foo"],
  ["rg --type ts 'wasm-tier-up'", "GREP", "wasm-tier-up"],
  ["rg -t ts -g '*.ts' tierUp", "GREP", "tierUp"],
  ["rg -e foo -e bar", "GREP", "foo"],
  ["grep -E 'a|b' file.txt", "GREP", "a|b"],
  ["git grep -n TODO", "GREP", "TODO"],
  ["cat log.txt | grep -i error", "GREP", "error"],
  ["history | grep docker", "GREP", "docker"],
  ["ps aux | grep node", null],
  ["ls -la | grep config", null],
  ["env | grep PATH", null],
  ["git log -S'--jitless' --oneline", "GIT_ARCHAEOLOGY", "--jitless"],
  ["git log -S jitless", "GIT_ARCHAEOLOGY", "jitless"],
  ["git log --grep=flake", "GIT_ARCHAEOLOGY", "flake"],
  ["git log --grep flake --all", "GIT_ARCHAEOLOGY", "flake"],
  ["git log --oneline", null],
  ["git blame src/main.ts", "GIT_ARCHAEOLOGY", "src/main.ts"],
  ["git blame -L 10,20 src/main.ts", "GIT_ARCHAEOLOGY", "src/main.ts"],
  ["git show 9f4a21c", "GIT_ARCHAEOLOGY", "9f4a21c"],
  ["git show HEAD", null],
  ["git -C ~/neural log -G 'tier'", "GIT_ARCHAEOLOGY", "tier"],
  ["man 1 printf", "HELP_LOOKUP", "printf"],
  ["man git-rebase", "HELP_LOOKUP", "git-rebase"],
  ["tldr tar", "HELP_LOOKUP", "tar"],
  ["docker run --help", "HELP_LOOKUP", "docker run"],
  ["find . -name '*.proto'", "GREP", "*.proto"],
  ["find . -type f -delete", null],
  ["fd -e ts config", "GREP", "config"],
  ["sudo grep -r secret /etc", "GREP", "secret"],
  ["FOO=1 rg pattern", "GREP", "pattern"],
  ["cd src && rg handler", "GREP", "handler"],
  ["echo 'grep foo'", null],
  ["npm test", null],
  ["rg foo 2>/dev/null", "GREP", "foo"],
  ["find . -name x | xargs grep -l needle", "GREP", "x"],
  ["vim notes.md", null],
  ["grep", null],
  ["ag -G '\\.ts$' needle", "GREP", "needle"],
  ["grep -- -v file", "GREP", "-v"],
  ['grep "two words" file', "GREP", "two words"],
  ["time rg --max-depth 2 needle", "GREP", "needle"],
];

for (const [cmd, kind, query] of CASES) {
  test(`seek: ${cmd}`, () => {
    const s = classifyEvent(ev("zsh", T0, cmd));
    if (kind === null) assert.equal(s, null);
    else assert.deepEqual(s, { kind, query });
  });
}

test("shell: pipes carry the upstream program; redirections are dropped", () => {
  assert.deepEqual(splitCommands("ps aux | grep -v grep > out.txt; echo done"), [
    { argv: ["ps", "aux"] },
    { argv: ["grep", "-v", "grep"], pipedFrom: "ps" },
    { argv: ["echo", "done"] },
  ]);
});

test("ask-agent: questions count, requests phrased as questions do not", () => {
  assert.equal(isQuestion("how do I pass --jitless to node?"), true);
  assert.equal(isQuestion("what was the flag for wasm tier-up"), true);
  assert.equal(isQuestion("is there a way to disable JIT?"), true);
  assert.equal(isQuestion("can you fix the build?"), false);
  assert.equal(isQuestion("please add tests"), false);
  assert.equal(isQuestion("fix the failing test"), false);
});

test("classify: chrome searches and codex user questions; assistant turns never", () => {
  assert.deepEqual(classifyEvent(ev("chrome", T0, "wasm tier up flag", { kind: "search" })), {
    kind: "WEB_SEARCH",
    query: "wasm tier up flag",
  });
  assert.equal(classifyEvent(ev("chrome", T0, "v8.dev docs", { kind: "visit" })), null);
  assert.deepEqual(classifyEvent(ev("codex_session", T0, "where is the tier-up flag set?", { role: "user" })), {
    kind: "ASK_AGENT",
    query: "where is the tier-up flag set?",
  });
  assert.equal(classifyEvent(ev("codex_session", T0, "where is it set?", { role: "assistant" })), null);
  assert.equal(classifyEvent(ev("git", T0, "grep for the flag")), null);
});
