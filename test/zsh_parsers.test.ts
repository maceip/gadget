import assert from "node:assert/strict";
import { test } from "node:test";
import { parseZshHistory, unmetafy } from "../src/miner/parsers/zsh_history.js";
import { dedupeHistoryAgainstHook, parseZshHook } from "../src/miner/parsers/zsh_hook.js";

test("zsh history: extended entries, multi-line commands, lines without timestamps", () => {
  const text = [
    ": 1790000000:0;rg --jitless",
    ": 1790000060:2;for f in *.ts; do\\",
    "  echo $f\\",
    "done",
    "plain line with no timestamp",
    ": 1790000120:0;",
    ": 1790000180:0;git log -S tierUp",
    "",
  ].join("\n");
  const r = parseZshHistory(Buffer.from(text), "/h/.zsh_history");
  assert.equal(r.counts.read, 5);
  assert.equal(r.counts.parsed, 3);
  assert.deepEqual(r.counts.skipped, { no_timestamp: 1, empty_command: 1 });
  assert.deepEqual(
    r.events.map((e) => [e.timestampMs, e.contentText, e.sourceUri]),
    [
      [1790000000000, "rg --jitless", "/h/.zsh_history:1"],
      [1790000060000, "for f in *.ts; do\n  echo $f\ndone", "/h/.zsh_history:2"],
      [1790000180000, "git log -S tierUp", "/h/.zsh_history:7"],
    ],
  );
  assert.equal(JSON.parse(r.events[1]!.metadataJson).duration_s, 2);
});

test("zsh history: metafied non-ASCII bytes are decoded", () => {
  // zsh writes bytes in its meta range (0x83..0xa2) as 0x83, byte^32.
  // "日本" is e6 97 a5 e6 9c ac: 0x97 and 0x9c are in that range.
  const raw = Buffer.from("echo héllo 日本", "utf8");
  const metafied: number[] = [];
  for (const b of raw) {
    if (b >= 0x83 && b <= 0xa2) metafied.push(0x83, b ^ 32);
    else metafied.push(b);
  }
  assert.notEqual(metafied.length, raw.length, "fixture must contain metafied bytes");
  assert.deepEqual(unmetafy(Buffer.from(metafied)), raw);
  const line = Buffer.concat([Buffer.from(": 1790000000:0;"), Buffer.from(metafied), Buffer.from("\n")]);
  const r = parseZshHistory(line, "h");
  assert.equal(r.events[0]!.contentText, "echo héllo 日本");
});

test("zsh hook: valid lines parse, bad lines are counted", () => {
  const lines = [
    JSON.stringify({ v: 1, start_ms: 1790000000123, end_ms: 1790000000456, cwd: "/w", cmd: "npm test", exit: 1 }),
    "{not json",
    JSON.stringify({ v: 2, start_ms: 1, end_ms: 1, cwd: "/", cmd: "x", exit: 0 }),
    JSON.stringify({ v: 1, start_ms: 1, cmd: "x" }),
    "",
  ].join("\n");
  const r = parseZshHook(lines, "/h/zsh.jsonl");
  assert.equal(r.counts.read, 4);
  assert.equal(r.counts.parsed, 1);
  assert.deepEqual(r.counts.skipped, { bad_json: 1, missing_field: 1 });
  assert.deepEqual(r.counts.unknown, { "version:2": 1 });
  const e = r.events[0]!;
  assert.equal(e.source, "zsh_hook");
  assert.equal(e.timestampMs, 1790000000123);
  assert.equal(e.workspacePath, "/w");
  assert.deepEqual(JSON.parse(e.metadataJson), { exit: 1, end_ms: 1790000000456 });
});

test("zsh hook: history entries also recorded by the hook are dropped", () => {
  const hook = parseZshHook(
    JSON.stringify({ v: 1, start_ms: 1790000000400, end_ms: 1790000001000, cwd: "/w", cmd: "rg foo", exit: 0 }),
    "hook",
  ).events;
  const hist = parseZshHistory(Buffer.from(": 1790000000:0;rg foo\n: 1790000000:0;rg bar\n: 1790000900:0;rg foo\n"), "h").events;
  const { kept, dropped } = dedupeHistoryAgainstHook(hist, hook);
  assert.equal(dropped, 1);
  assert.deepEqual(
    kept.map((e) => [e.contentText, e.timestampMs]),
    [
      ["rg bar", 1790000000000],
      ["rg foo", 1790000900000],
    ],
  );
});
