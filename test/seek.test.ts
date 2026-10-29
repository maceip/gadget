import assert from "node:assert/strict";
import { test } from "node:test";
import { askedQuestion, classifyEvent, classifyEventAll, isQuestion } from "../src/miner/seek.js";
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
  ["cat <<'EOF' > notes.md\ngrep needle in a heredoc body\nEOF", null],
  ["cat <<EOF > a.txt\nrg body\nEOF\nrg real", "GREP", "real"],
  ["cat <<-END\n\tgrep tabbed\n\tEND", null],
  ["grep <<< 'input text' pattern", "GREP", "pattern"],
  ["echo setup # note\nrg needle", "GREP", "needle"],
  ["sudo -u root rg needle", "GREP", "needle"],
  ["env -u FOO rg needle", "GREP", "needle"],
  ["nice -n 10 rg needle", "GREP", "needle"],
  ["docker logs api | grep timeout", "GREP", "timeout"],
  ["kubectl logs pod-1 | rg crash", "GREP", "crash"],
  ["docker ps | grep api", null],
  ["kubectl get pods | grep api", null],
  ["brew list | grep node", null],
  ["rg \\\n  needle", "GREP", "needle"],
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
    { argv: ["grep", "-v", "grep"], pipedFrom: ["ps", "aux"] },
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
  assert.equal(isQuestion("Do not address my recent prompt until you've successfully ran all tests across Node and Python."), false);
  assert.equal(isQuestion("My Gemini credits are almost depleted. Can you delegate the rest of the task, please?"), false);
  assert.equal(isQuestion("Delete everything. Stop. Delete all the stuff you've done. Can you explain to me why you thought it was a good idea to add the fake stuff in there?"), false);
  assert.equal(isQuestion("<send_user_message_question_reply> [{\"question\":\"Is this the full article?\"}]"), false);
});

test("classify: chrome searches, codex/antigravity tool_command shell searches, and user questions; assistant turns never", () => {
  assert.deepEqual(classifyEvent(ev("chrome", T0, "wasm tier up flag", { kind: "search" })), {
    kind: "WEB_SEARCH",
    query: "wasm tier up flag",
  });
  assert.equal(classifyEvent(ev("chrome", T0, "v8.dev docs", { kind: "visit" })), null);
  assert.deepEqual(classifyEvent(ev("codex_session", T0, "where is the tier-up flag set?", { role: "user" })), {
    kind: "ASK_AGENT",
    query: "where is the tier-up flag set?",
  });
  assert.deepEqual(
    classifyEvent(
      ev("codex_session", T0, "rg -n -i 'acuityblue|cortex|snowflake' /Users/mac/.codex/memories/MEMORY.md", {
        role: "tool",
        kind: "tool_command",
        exit: 1,
      }),
    ),
    {
      kind: "GREP",
      query: "acuityblue|cortex|snowflake",
    },
  );
  assert.deepEqual(
    classifyEvent(
      ev("antigravity_session", T0, 'git grep -n -C 15 "ensureKotlinStdlib" app/ide-core/', {
        role: "tool",
        kind: "tool_command",
        exit: 0,
      }),
    ),
    {
      kind: "GREP",
      query: "ensureKotlinStdlib",
    },
  );
  assert.equal(classifyEvent(ev("codex_session", T0, "where is it set?", { role: "assistant" })), null);
  assert.equal(classifyEvent(ev("git", T0, "grep for the flag")), null);
});

test("ASK_AGENT: a question after a long pasted log is found, and it is the query", () => {
  const log = Array.from({ length: 40 }, (_, i) => `[build] step ${i} ok: wrote out/chunk-${i}.js (12kb)`).join("\n");
  const turn = `${log}\nerror: unknown flag --jitless\n\nwhy does the wasm build reject --jitless now?`;
  assert.ok(turn.indexOf("why does") > 500);
  assert.deepEqual(classifyEventAll(ev("codex_session", T0, turn, { role: "user" })), [
    { kind: "ASK_AGENT", query: "why does the wasm build reject --jitless now?" },
  ]);
});

test("ASK_AGENT: question marks in code, URLs, and ternaries are not questions; requests are not seeking", () => {
  assert.equal(isQuestion("fetch https://example.com/search?q=tierup and save it"), false);
  assert.equal(isQuestion("change it to user?.name ?? 'anon'"), false);
  assert.equal(isQuestion("set x = ok ? 1 : 0 in build.ts"), false);
  assert.equal(isQuestion("update this:\n```\nconst a = b?.c;\nwhy?\n```\nthanks"), false);
  assert.equal(isQuestion("here is the log:\nE1 failed\ncan you fix this?"), false);
  assert.equal(isQuestion("Do not change the public API."), false);
  assert.equal(askedQuestion("Fix the test. Also, which file sets the flag?"), "Also, which file sets the flag?");
  assert.equal(askedQuestion("huh??"), "huh??");
  assert.equal(askedQuestion("where did we set the tier-up flag"), "where did we set the tier-up flag");
});

test("ASK_AGENT: list and quote markers do not hide a request or a question", () => {
  assert.equal(isQuestion("E1 failed\nE2 failed\n- can you fix the build?"), false);
  assert.equal(isQuestion("notes:\n1. please add a test?"), false);
  assert.equal(askedQuestion("> why does the wasm build reject --jitless?"), "why does the wasm build reject --jitless?");
  assert.equal(askedQuestion("- what sets the tier-up flag"), "what sets the tier-up flag");
});

test("ASK_AGENT: requests after an opener are still requests; questions after one are still questions", () => {
  assert.equal(isQuestion("E1 failed\nAlso, can you fix this?"), false);
  assert.equal(isQuestion("Then could you update the build?"), false);
  assert.equal(isQuestion("ok so please rerun it?"), false);
  assert.equal(askedQuestion("So what sets the tier-up flag"), "So what sets the tier-up flag");
  assert.equal(askedQuestion("Also, which file sets the flag?"), "Also, which file sets the flag?");
});

test("ASK_AGENT: tilde fences are code too; formatting around a question does not hide it", () => {
  assert.equal(isQuestion("~~~\nwhy?\n~~~\ncan you fix this?"), false);
  assert.equal(askedQuestion("**Why does the wasm build fail?**"), "**Why does the wasm build fail?**");
  assert.equal(askedQuestion('"Why?"'), '"Why?"');
  assert.equal(askedQuestion("_what sets the tier-up flag_"), "_what sets the tier-up flag_");
  assert.equal(isQuestion("**can you fix the build?**"), false);
  // Mid-turn, where only the closing "?" can mark it.
  assert.equal(
    askedQuestion("Build log is below. **Why does the wasm build fail?** Thanks for looking."),
    "**Why does the wasm build fail?**",
  );
});

test("ASK_AGENT: a fence inside a block quote is code too", () => {
  assert.equal(isQuestion("> ```\n> why?\n> ```\ncan you fix this?"), false);
  assert.equal(askedQuestion("> ```\n> x = a ? b : c\n> ```\n> why does this fail?"), "why does this fail?");
});

test("ASK_AGENT: a fence under a list item is code; a URL ending in ? is not a question", () => {
  assert.equal(isQuestion("- ```\n  why?\n  ```\ncan you fix this?"), false);
  assert.equal(askedQuestion("- ```\n  x\n  ```\nwhy does the build fail?"), "why does the build fail?");
  assert.equal(isQuestion("GET https://example.test/search?\nplease rerun it"), false);
  assert.equal(askedQuestion("is https://example.test/search? the right endpoint?"), "is https://example.test/search? the right endpoint?");
});

test("ASK_AGENT: inline code, mismatched fences, and request clauses after context", () => {
  const log = "x".repeat(600);
  assert.equal(isQuestion(`${log}\nObserved output: \`why?\``), false);
  assert.equal(askedQuestion("why does `--jitless` break the wasm build?"), "why does `--jitless` break the wasm build?");
  // A ~~~ line inside a ``` block is content, not a closing fence.
  assert.equal(isQuestion("```\n~~~\nwhy?\n```\nplease rerun it"), false);
  assert.equal(askedQuestion("````\n```\nnot closed yet?\n````\nwhere is the flag set?"), "where is the flag set?");
  assert.equal(isQuestion(`${log}\nGiven that output, can you fix it?`), false);
  assert.equal(isQuestion("If it fails again; could you rerun it?"), false);
  assert.equal(askedQuestion("what would you recommend for the tier-up flag?"), "what would you recommend for the tier-up flag?");
  assert.equal(askedQuestion("where is the flag set, please?"), "where is the flag set, please?");
});

test("ASK_AGENT: indented code blocks are code; one sentence never discards the turn's other questions", () => {
  assert.equal(isQuestion("Output:\n\n    why?\n    still code?\n\nCan you fix this?"), false);
  assert.equal(askedQuestion("Output:\n\n    x = 1\n\nwhy is x one?"), "why is x one?");
  // Indented lines that continue a paragraph are not a code block.
  assert.equal(askedQuestion("Two questions:\n    where is the tier-up flag set?"), "where is the tier-up flag set?");
  const context = "The cache keeps one entry per module. ".repeat(20);
  assert.equal(
    askedQuestion(`How does the cache work? ${context}Why would you choose a WeakMap here?`),
    "How does the cache work? Why would you choose a WeakMap here?",
  );
});

test("ASK_AGENT: a line opening with an inline ``` span is prose, not a fence", () => {
  assert.equal(askedQuestion("```--jitless``` why does this fail?"), "```--jitless``` why does this fail?");
  assert.equal(askedQuestion("```--jitless``` breaks it.\nwhere is the flag set?"), "where is the flag set?");
  assert.equal(isQuestion("```ts\nwhy?\n```\nplease rerun it"), false);
});
