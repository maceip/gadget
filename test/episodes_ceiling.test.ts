import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateCeiling, ftsMatch, keyTokens, normalizeQuery } from "../src/miner/ceiling.js";
import { defaultConfig } from "../src/miner/config.js";
import { buildEpisodes } from "../src/miner/episodes.js";
import { withSeeks } from "../src/miner/seek.js";
import { EventStore } from "../src/miner/store.js";
import type { EpisodicEvent } from "../src/miner/types.js";
import { makeEvent } from "../src/miner/event.js";
import { DAY, ev, MIN, stored, T0, tmp } from "./helpers.js";

const params = defaultConfig("/nonexistent");

function storeWith(events: EpisodicEvent[]): EventStore {
  const s = new EventStore(join(tmp(), "t.db"));
  s.insert(withSeeks(events));
  return s;
}

test("episodes: grouping by gap, context window, TEST_PASSED after a failing test", () => {
  const events = [
    ev("zsh_hook", T0, "npm test", { exit: 1 }),
    ev("zsh_hook", T0 + 1 * MIN, "rg tierUp", { exit: 0 }),
    ev("chrome", T0 + 2 * MIN, "wasm tier up flag", { kind: "search" }),
    ev("chrome", T0 + 3 * MIN, "v8 docs\nhttps://v8.dev", { kind: "visit" }),
    ev("zsh_hook", T0 + 4 * MIN, "npm test", { exit: 0 }),
    ev("zsh_hook", T0 + 20 * MIN, "rg other", { exit: 0 }),
    ev("zsh", T0 + 21 * MIN, "vim x.ts"),
    ev("zsh", T0 + 90 * MIN, "rg lonely"),
  ].map(stored);

  const eps = buildEpisodes(events, params);
  assert.equal(eps.length, 3);

  const [a, b, c] = eps as [(typeof eps)[0], (typeof eps)[0], (typeof eps)[0]];
  assert.deepEqual(
    a.seekActions.map((s) => [s.kind, s.query]),
    [
      ["GREP", "tierUp"],
      ["WEB_SEARCH", "wasm tier up flag"],
    ],
  );
  assert.equal(a.seekStartMs, T0 + MIN);
  assert.deepEqual(a.contextEventIds, [events[0]!.eventId]);
  assert.equal(a.resolution?.kind, "TEST_PASSED");
  assert.equal(a.costMs, 3 * MIN);

  assert.equal(b.resolution?.kind, "WORK_RESUMED");
  assert.equal(b.costMs, MIN);

  assert.equal(c.resolution, undefined);
  assert.equal(c.costMs, undefined);
});

test("episodes: an exit-code resolution is timed at command end; one ending past the window does not count", () => {
  const ok = buildEpisodes(
    [
      ev("zsh_hook", T0, "npm test", { exit: 1, end_ms: T0 + 1000 }),
      ev("zsh_hook", T0 + MIN, "rg tierUp", { exit: 0, end_ms: T0 + MIN }),
      ev("zsh_hook", T0 + 2 * MIN, "npm test", { exit: 0, end_ms: T0 + 9 * MIN }),
    ].map(stored),
    params,
  );
  assert.equal(ok[0]!.resolution?.kind, "TEST_PASSED");
  assert.equal(ok[0]!.resolution?.atMs, T0 + 9 * MIN);
  assert.equal(ok[0]!.costMs, 8 * MIN);

  const late = buildEpisodes(
    [
      ev("zsh_hook", T0, "npm test", { exit: 1, end_ms: T0 + 1000 }),
      ev("zsh_hook", T0 + MIN, "rg tierUp", { exit: 0, end_ms: T0 + MIN }),
      ev("zsh_hook", T0 + 20 * MIN, "npm test", { exit: 0, end_ms: T0 + 45 * MIN }),
    ].map(stored),
    params,
  );
  assert.equal(late[0]!.resolution, undefined);
});

test("episodes: forward-captured commands never produce the WORK_RESUMED fallback", () => {
  const eps = buildEpisodes(
    [ev("zsh_hook", T0, "rg tierUp", { exit: 0, end_ms: T0 }), ev("zsh_hook", T0 + MIN, "vim x.ts", { exit: 0, end_ms: T0 + MIN })].map(stored),
    params,
  );
  assert.equal(eps[0]!.resolution, undefined);
});

test("episodes: a success resolves only the same command in the same folder", () => {
  const hook = (t: number, cmd: string, exit: number, cwd = "/w/a") =>
    makeEvent({
      source: "zsh_hook",
      timestampMs: t,
      workspacePath: cwd,
      contentText: cmd,
      sourceUri: `hook:${t}`,
      metadataJson: JSON.stringify({ exit, end_ms: t + 1000 }),
    });
  const res = (events: ReturnType<typeof hook>[]) => buildEpisodes(events.map(stored), params)[0]!.resolution;

  assert.equal(res([hook(T0, "npm test", 1), hook(T0 + MIN, "rg tierUp", 0), hook(T0 + 2 * MIN, "npm install", 0)]), undefined);
  assert.equal(
    res([hook(T0, "npm test", 1), hook(T0 + MIN, "rg tierUp", 0), hook(T0 + 2 * MIN, "npm test", 0, "/w/other")]),
    undefined,
  );
  assert.equal(
    res([hook(T0, "npm test", 1), hook(T0 + MIN, "rg tierUp", 0), hook(T0 + 2 * MIN, "npm test -- --grep tier", 0)])?.kind,
    "TEST_PASSED",
  );
});

test("episodes: seek, then a failure, then a success resolves the episode", () => {
  const eps = buildEpisodes(
    [
      ev("zsh_hook", T0, "rg tierUp", { exit: 0, end_ms: T0 }),
      ev("zsh_hook", T0 + MIN, "make build", { exit: 2, end_ms: T0 + MIN }),
      ev("zsh_hook", T0 + 3 * MIN, "make build", { exit: 0, end_ms: T0 + 4 * MIN }),
    ].map(stored),
    params,
  );
  assert.equal(eps[0]!.resolution?.kind, "COMMAND_SUCCEEDED");
  assert.equal(eps[0]!.costMs, 4 * MIN);
});

test("episodes: a failure already fixed before seeking is not resolved again by a later success", () => {
  const eps = buildEpisodes(
    [
      ev("zsh_hook", T0, "npm test", { exit: 1, end_ms: T0 }),
      ev("zsh_hook", T0 + MIN, "npm test", { exit: 0, end_ms: T0 + MIN }),
      ev("zsh_hook", T0 + 2 * MIN, "rg tierUp", { exit: 0, end_ms: T0 + 2 * MIN }),
      ev("zsh_hook", T0 + 3 * MIN, "npm test", { exit: 0, end_ms: T0 + 3 * MIN }),
    ].map(stored),
    params,
  );
  assert.equal(eps[0]!.resolution, undefined);
});

test("episodes: a retry that starts before the search and finishes after it resolves the episode", () => {
  const eps = buildEpisodes(
    [
      ev("zsh_hook", T0, "npm test", { exit: 1, end_ms: T0 + 1000 }),
      ev("zsh_hook", T0 + MIN, "npm test", { exit: 0, end_ms: T0 + 6 * MIN }),
      ev("zsh_hook", T0 + 2 * MIN, "rg tierUp", { exit: 0, end_ms: T0 + 2 * MIN }),
    ].map(stored),
    params,
  );
  assert.equal(eps[0]!.resolution?.kind, "TEST_PASSED");
  assert.equal(eps[0]!.resolution?.atMs, T0 + 6 * MIN);
  assert.equal(eps[0]!.costMs, 4 * MIN);
});

test("ceiling: every seek action gets its own top hit", () => {
  const store = storeWith([
    ev("git", T0 - DAY, "build cache notes"),
    ev("git", T0 - DAY, "frobnicator lives in src/frob.ts"),
    ev("zsh", T0, "rg build; rg frobnicator"),
  ]);
  const c = evaluateCeiling(buildEpisodes(store.allEventsSorted(), params), store);
  const actions = c.evals[0]!.actions;
  assert.deepEqual(
    actions.map((a) => [a.query, a.hit?.snippet]),
    [
      ["build", "[build] cache notes"],
      ["frobnicator", "[frobnicator] lives in src/frob.ts"],
    ],
  );
  store.close();
});

test("store: events with the same timestamp keep insertion order, not id order", () => {
  // Find two events whose content-addressed ids sort opposite to insertion order.
  let a = ev("zsh", T0, "rg first0");
  let b = ev("zsh", T0, "vim after0");
  for (let i = 1; a.eventId < b.eventId; i++) {
    a = ev("zsh", T0, `rg first${i}`);
    b = ev("zsh", T0, `vim after${i}`);
  }
  const store = storeWith([a, b]);
  assert.deepEqual(
    store.allEventsSorted().map((e) => e.eventId),
    [a.eventId, b.eventId],
  );
  store.close();
});

test("episodes: a long command that started before the context window but failed inside it counts", () => {
  const eps = buildEpisodes(
    [
      ev("zsh_hook", T0 - 15 * MIN, "make build", { exit: 2, end_ms: T0 - 5 * MIN }),
      ev("zsh_hook", T0, "rg tierUp", { exit: 0, end_ms: T0 }),
      ev("zsh_hook", T0 + MIN, "make build", { exit: 0, end_ms: T0 + 2 * MIN }),
    ].map(stored),
    params,
  );
  assert.equal(eps[0]!.resolution?.kind, "COMMAND_SUCCEEDED");
  assert.equal(eps[0]!.resolution?.atMs, T0 + 2 * MIN);
});

test("episodes: overlapping retries resolve at whichever finishes first", () => {
  const eps = buildEpisodes(
    [
      ev("zsh_hook", T0 - 2 * MIN, "make build", { exit: 2, end_ms: T0 - 2 * MIN }),
      ev("zsh_hook", T0 - MIN, "npm test", { exit: 1, end_ms: T0 - MIN }),
      ev("zsh_hook", T0, "rg tierUp", { exit: 0, end_ms: T0 }),
      ev("zsh_hook", T0 + MIN, "make build", { exit: 0, end_ms: T0 + 10 * MIN }),
      ev("zsh_hook", T0 + 2 * MIN, "npm test", { exit: 0, end_ms: T0 + 3 * MIN }),
    ].map(stored),
    params,
  );
  assert.equal(eps[0]!.resolution?.kind, "TEST_PASSED");
  assert.equal(eps[0]!.resolution?.atMs, T0 + 3 * MIN);
});

test("episodes: a command in the same second just before the seek is still context", () => {
  const events = [ev("zsh", T0, "vim build.ts"), ev("zsh", T0, "rg tierUp")].map(stored);
  const eps = buildEpisodes(events, params);
  assert.deepEqual(eps[0]!.contextEventIds, [events[0]!.eventId]);
});

test("store: two records alike except for metadata (e.g. two Chrome profiles) are both kept", () => {
  const a = ev("chrome", T0, "Lite mode\nhttps://v8.dev", { kind: "visit", history: "/p1/History", visit_id: 1 });
  const b = ev("chrome", T0, "Lite mode\nhttps://v8.dev", { kind: "visit", history: "/p2/History", visit_id: 1 });
  assert.notEqual(a.eventId, b.eventId);
  const store = storeWith([a, b]);
  assert.equal(store.allEventsSorted().length, 2);
  store.close();
});

test("episodes: git commits are not evidence that the owner resumed work", () => {
  const eps = buildEpisodes([ev("zsh", T0, "rg tierUp"), ev("git", T0 + MIN, "Upstream: bump deps")].map(stored), params);
  assert.equal(eps[0]!.resolution, undefined);
});

test("episodes: every seek in a compound shell entry becomes a seek action", () => {
  const eps = buildEpisodes([stored(ev("zsh", T0, "rg foo; rg bar || git log -S baz"))], params);
  assert.deepEqual(
    eps[0]!.seekActions.map((a) => [a.kind, a.query]),
    [
      ["GREP", "foo"],
      ["GREP", "bar"],
      ["GIT_ARCHAEOLOGY", "baz"],
    ],
  );
});

test("episodes: seek actions less than the gap apart chain into one episode", () => {
  const events = [0, 4, 8, 12].map((m) => stored(ev("zsh", T0 + m * MIN, `rg q${m}`)));
  const eps = buildEpisodes(events, params);
  assert.equal(eps.length, 1);
  assert.equal(eps[0]!.seekActions.length, 4);
});

test("ceiling: query normalization and key tokens", () => {
  assert.equal(normalizeQuery("  'Wasm   Tier-Up' "), "wasm tier-up");
  assert.deepEqual(keyTokens("--jitless", "GREP"), ["jitless"]);
  assert.deepEqual(keyTokens("wasm-tier-up", "GREP"), ["wasm-tier-up"]);
  assert.deepEqual(keyTokens("foo.*bar", "GREP"), ["foo", "bar"]);
  assert.deepEqual(keyTokens("how do I turn off wasm_tier_up in the build?", "ASK_AGENT"), ["wasm_tier_up"]);
  assert.equal(ftsMatch(['say"hi', "x"]), '"say""hi" AND "x"');
});

test("ceiling: compound identifiers match as adjacent words, not anywhere", () => {
  const store = storeWith([
    ev("git", T0 - DAY, "set wasm-tier-up=false in the build"),
    ev("git", T0 - DAY, "tier list: up next, wasm"),
    ev("zsh", T0, "rg -- --wasm-tier-up"),
  ]);
  const c = evaluateCeiling(buildEpisodes(store.allEventsSorted(), params), store);
  assert.equal(c.evals[0]!.hit!.snippet, "set [wasm-tier-up]=false in the build");
  store.close();
});

test("ceiling: an episode hits if any one of its seek actions hits", () => {
  const store = storeWith([
    ev("git", T0 - DAY, "Drop --jitless"),
    ev("zsh", T0, "rg -- --jitless"),
    ev("chrome", T0 + MIN, "v8 lite mode explained", { kind: "search" }),
  ]);
  const eps = buildEpisodes(store.allEventsSorted(), params);
  assert.equal(eps.length, 1);
  const c = evaluateCeiling(eps, store);
  assert.equal(c.evals[0]!.hit?.source, "git");
  store.close();
});

test("ceiling: local hit from older data; repeat seek; seeks are not answers", () => {
  const store = storeWith([
    ev("git", T0 - 30 * DAY, "Drop --jitless\nUse --wasm-tier-up=false instead."),
    ev("zsh", T0 - 10 * DAY, "rg -- --jitless"),
    ev("zsh", T0, "rg -- --jitless"),
    ev("zsh", T0 + 2 * DAY, "rg -- neverseenbefore"),
  ]);
  const events = store.allEventsSorted();
  const eps = buildEpisodes(events, params);
  assert.equal(eps.length, 3);
  const c = evaluateCeiling(eps, store);

  // First --jitless search: the commit 20 days earlier is a hit; nothing to repeat yet.
  assert.equal(c.evals[0]!.repeatSeek, false);
  assert.equal(c.evals[0]!.hit?.source, "git");
  // Second: repeat of the first; the hit is still the commit, never the earlier search command.
  assert.equal(c.evals[1]!.repeatSeek, true);
  assert.equal(c.evals[1]!.hit?.source, "git");
  assert.equal(c.evals[1]!.hitOlderThanDay?.source, "git");
  // Third: nothing earlier contains the token.
  assert.equal(c.evals[2]!.hit, null);

  assert.deepEqual(c.repeatSeek, { num: 1, den: 3 });
  assert.deepEqual(c.localHit, { num: 2, den: 3 });
  store.close();
});

test("ceiling LEAKAGE: data at or after the moment you started looking never counts", () => {
  const store = storeWith([
    ev("zsh", T0, "rg frobnicator"),
    ev("codex_session", T0, "frobnicator lives in src/frob.ts", { role: "assistant" }), // same millisecond
    ev("git", T0 + MIN, "Add frobnicator"), // one minute later
    ev("git", T0 + 30 * DAY, "Rename frobnicator"), // far future
  ]);
  const eps = buildEpisodes(store.allEventsSorted(), params);
  assert.equal(eps.length, 1);
  const c = evaluateCeiling(eps, store);
  assert.equal(c.evals[0]!.hit, null, "an answer from the same millisecond or later leaked into the ceiling");
  assert.equal(c.evals[0]!.hitOlderThanDay, null);
  assert.deepEqual(c.localHit, { num: 0, den: 1 });
  store.close();
});

test("ceiling: one-day cutoff separates recent from old hits", () => {
  const store = storeWith([ev("git", T0 - 60 * MIN, "Add quuxifier"), ev("zsh", T0, "rg quuxifier")]);
  const c = evaluateCeiling(buildEpisodes(store.allEventsSorted(), params), store);
  assert.equal(c.evals[0]!.hit?.source, "git");
  assert.equal(c.evals[0]!.hitOlderThanDay, null);
  store.close();
});
