import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CHROME_EPOCH_OFFSET_MS, findChromiumHistoryFiles, parseChromeHistory } from "../src/miner/parsers/chrome.js";
import { parseCodexSession } from "../src/miner/parsers/codex.js";
import { T0, tmp } from "./helpers.js";

// Realistic Chrome timestamps (~1.3e16 microseconds) are above 2^53, so insert them as BigInt.
const chromeTime = (ms: number) => (BigInt(ms) + BigInt(CHROME_EPOCH_OFFSET_MS)) * 1000n + 123n;

function makeHistory(path: string, opts: { withSearch: boolean }) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
    CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER);
  `);
  if (opts.withSearch) db.exec("CREATE TABLE keyword_search_terms (keyword_id INTEGER, url_id INTEGER, term TEXT, normalized_term TEXT)");
  const url = db.prepare("INSERT INTO urls (id, url, title) VALUES (?, ?, ?)");
  const visit = db.prepare("INSERT INTO visits (id, url, visit_time) VALUES (?, ?, ?)");
  url.run(1, "https://www.google.com/search?q=wasm+tier+up+flag", "wasm tier up flag - Google Search");
  url.run(2, "https://v8.dev/docs/wasm-compilation-pipeline", "WebAssembly compilation pipeline");
  visit.run(10, 1, chromeTime(T0));
  visit.run(11, 2, chromeTime(T0 + 60_000));
  visit.run(12, 2, 0);
  if (opts.withSearch) db.prepare("INSERT INTO keyword_search_terms VALUES (?, ?, ?, ?)").run(2, 1, "wasm tier up flag", "wasm tier up flag");
  db.close();
}

test("chrome: search terms, visits, exact times, search pages not double counted", () => {
  const root = tmp();
  mkdirSync(join(root, "Default"));
  mkdirSync(join(root, "Profile 1"));
  mkdirSync(join(root, "Crashpad"));
  makeHistory(join(root, "Default", "History"), { withSearch: true });
  makeHistory(join(root, "Profile 1", "History"), { withSearch: false });

  const files = findChromiumHistoryFiles([root, join(root, "missing")]);
  assert.deepEqual(files, [join(root, "Default", "History"), join(root, "Profile 1", "History")]);

  const r = parseChromeHistory(files[0]!);
  assert.equal(r.counts.parsed, 2);
  assert.deepEqual(r.counts.skipped, { search_results_page: 1, no_timestamp: 1 });
  const search = r.events.find((e) => JSON.parse(e.metadataJson).kind === "search")!;
  assert.equal(search.contentText, "wasm tier up flag");
  assert.equal(search.timestampMs, T0);
  const visit = r.events.find((e) => JSON.parse(e.metadataJson).kind === "visit")!;
  assert.equal(visit.timestampMs, T0 + 60_000);
  assert.equal(visit.contentText, "WebAssembly compilation pipeline\nhttps://v8.dev/docs/wasm-compilation-pipeline");

  const r2 = parseChromeHistory(files[1]!);
  assert.deepEqual(r2.counts.unknown, { "missing_table:keyword_search_terms": 1 });
  assert.equal(r2.counts.parsed, 2); // both pages are plain visits without the search table
});

test("chrome: the source file is opened through a copy and left unchanged", () => {
  const root = tmp();
  mkdirSync(join(root, "Default"));
  const path = join(root, "Default", "History");
  makeHistory(path, { withSearch: true });
  const before = new DatabaseSync(path, { readOnly: true }).prepare("SELECT count(*) AS n FROM visits").get() as { n: number };
  parseChromeHistory(path);
  const after = new DatabaseSync(path, { readOnly: true }).prepare("SELECT count(*) AS n FROM visits").get() as { n: number };
  assert.equal(after.n, before.n);
});

test("codex: messages, workspace from session_meta, injected context, unknown shapes", () => {
  const lines = [
    { timestamp: "2026-10-01T12:00:00.000Z", type: "session_meta", payload: { id: "s1", cwd: "/Users/me/vitre" } },
    {
      timestamp: "2026-10-01T12:00:01.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] },
    },
    {
      timestamp: "2026-10-01T12:00:02.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "how do I turn off wasm tier-up?" }] },
    },
    {
      timestamp: "2026-10-01T12:00:03.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Pass --wasm-tier-up=false." }] },
    },
    { timestamp: "2026-10-01T12:00:04.000Z", type: "response_item", payload: { type: "function_call", name: "shell" } },
    { timestamp: "2026-10-01T12:00:05.000Z", type: "event_msg", payload: { type: "token_count" } },
    { type: "message", role: "user", content: [{ type: "input_text", text: "old format, no timestamp" }] },
    { timestamp: "2026-10-01T12:00:06.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [] } },
  ]
    .map((o) => JSON.stringify(o))
    .concat(["not json"])
    .join("\n");

  const r = parseCodexSession(lines, "/c/rollout.jsonl");
  assert.equal(r.counts.read, 9);
  assert.equal(r.counts.parsed, 2);
  assert.deepEqual(r.counts.skipped, {
    session_meta: 1,
    injected_context: 1,
    no_timestamp: 1,
    "role:developer": 1,
    bad_json: 1,
  });
  assert.deepEqual(r.counts.unknown, { "response_item/function_call": 1, "event_msg/token_count": 1 });
  assert.deepEqual(
    r.events.map((e) => [e.contentText, JSON.parse(e.metadataJson).role, e.workspacePath, e.sourceUri]),
    [
      ["how do I turn off wasm tier-up?", "user", "/Users/me/vitre", "/c/rollout.jsonl#3"],
      ["Pass --wasm-tier-up=false.", "assistant", "/Users/me/vitre", "/c/rollout.jsonl#4"],
    ],
  );
});
