import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  CHROME_EPOCH_OFFSET_MS,
  findChromiumHistoryFiles,
  parseChromeHistory,
  searchTermFromUrl,
  snapshot,
} from "../src/miner/parsers/chrome.js";
import { parseCodexSession, stripLeadingContext } from "../src/miner/parsers/codex.js";
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

  // Without keyword_search_terms, the search-results URL itself becomes the search.
  const r2 = parseChromeHistory(files[1]!);
  assert.deepEqual(r2.counts.unknown, { "missing_table:keyword_search_terms": 1 });
  assert.equal(r2.counts.parsed, 2);
  const fromUrl = r2.events.find((e) => JSON.parse(e.metadataJson).kind === "search")!;
  assert.equal(fromUrl.contentText, "wasm tier up flag");
  assert.equal(JSON.parse(fromUrl.metadataJson).via, "url");
  assert.equal(r2.events.filter((e) => JSON.parse(e.metadataJson).kind === "visit").length, 1);
});

test("chrome: the snapshot is retried while the source keeps changing, then gives up", () => {
  const root = tmp();
  mkdirSync(join(root, "Default"));
  const path = join(root, "Default", "History");
  makeHistory(path, { withSearch: true });

  // Each try reads the fingerprint before and after copying. These differ on the first
  // two tries and match on the third.
  const seq = ["a", "b", "c", "d", "e", "e"];
  let i = 0;
  const copy = snapshot(path, tmp(), 5, () => seq[Math.min(i++, seq.length - 1)]!);
  assert.equal(i, 6);
  const db = new DatabaseSync(copy, { readOnly: true });
  assert.equal((db.prepare("SELECT count(*) AS n FROM visits").get() as { n: number }).n, 3);
  db.close();

  let n = 0;
  assert.throws(() => snapshot(path, tmp(), 3, () => String(n++)), /kept changing while being copied \(3 tries\)/);
});

test("chrome: search terms are read from known search-results URLs only", () => {
  assert.equal(searchTermFromUrl("https://www.google.com/search?q=v8+jitless&oq=v8"), "v8 jitless");
  assert.equal(searchTermFromUrl("https://www.google.co.uk/search?q=tier-up"), "tier-up");
  assert.equal(searchTermFromUrl("https://duckduckgo.com/?q=rg+glob"), "rg glob");
  assert.equal(searchTermFromUrl("https://github.com/search?q=wasm-tier-up&type=code"), "wasm-tier-up");
  assert.equal(searchTermFromUrl("https://www.google.com/maps?q=cafe"), null);
  assert.equal(searchTermFromUrl("https://notgoogle.com/search?q=x"), null);
  assert.equal(searchTermFromUrl("https://www.google.com/search"), null);
  assert.equal(searchTermFromUrl("not a url"), null);
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

test("codex: owner text after injected context blocks is kept; context-only turns are dropped; user XML tags are preserved", () => {
  assert.equal(stripLeadingContext("<environment_context>cwd=/w</environment_context>\n\nwhere is the flag?"), "where is the flag?");
  assert.equal(stripLeadingContext("<environment_context>x</environment_context><permissions>y</permissions>"), "");
  assert.equal(stripLeadingContext("<context>user notes</context>\nhow does this work?"), "<context>user notes</context>\nhow does this work?");
  assert.equal(stripLeadingContext("<request>why did the build fail?</request>"), "<request>why did the build fail?</request>");
  assert.equal(stripLeadingContext("<unclosed> keep this"), "<unclosed> keep this");
  assert.equal(stripLeadingContext("plain question?"), "plain question?");

  const line = JSON.stringify({
    timestamp: "2026-10-01T12:00:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "<environment_context>cwd=/w</environment_context>\nhow do I disable tier-up?" }],
    },
  });
  const r = parseCodexSession(line, "/c/s.jsonl");
  assert.equal(r.counts.parsed, 1);
  assert.equal(r.events[0]!.contentText, "how do I disable tier-up?");
  assert.deepEqual(JSON.parse(r.events[0]!.metadataJson), { role: "user", stripped_leading_context: true });
});
