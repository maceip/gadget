import assert from "node:assert/strict";
import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateCeiling } from "../src/miner/ceiling.js";
import { defaultConfig } from "../src/miner/config.js";
import { buildEpisodes } from "../src/miner/episodes.js";
import { ingest } from "../src/miner/ingest.js";
import { probe } from "../src/miner/probe.js";
import { renderReport, writeReport } from "../src/miner/report.js";
import { withSeeks } from "../src/miner/seek.js";
import { computeSensitivity, sensitivityGrid } from "../src/miner/sensitivity.js";
import { EventStore } from "../src/miner/store.js";
import { DAY, ev, MIN, REPO, T0, tmp } from "./helpers.js";

function userTurn(text: string): string {
  return JSON.stringify({
    timestamp: "2026-10-01T12:00:00.000Z",
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
}

test("probe: tool-injected tags common across files are named; rare ones are withheld", () => {
  const home = tmp();
  const dir = join(home, "sessions");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 6; i++) {
    const lines = [userTurn("<environment_context>cwd</environment_context>"), userTurn("plain question?")];
    if (i === 0) lines.push(userTurn("<acme_secret_project>notes</acme_secret_project>"));
    writeFileSync(join(dir, `rollout-${i}.jsonl`), lines.join("\n") + "\n");
  }
  const out = probe({ ...defaultConfig(home), codexDir: dir, antigravityDir: join(home, "none") });
  assert.match(out, /6 files, 13 lines/);
  assert.match(out, /<environment_context>/);
  assert.match(out, /\(no leading tag\)/);
  assert.doesNotMatch(out, /acme_secret_project/);
  assert.match(out, /1 +\(leading tags in fewer than 3 files, names withheld\)/);
  assert.doesNotMatch(out, /plain question|cwd|notes/);
});

test("sensitivity: one parameter varies at a time; the seek gap moves episode counts", () => {
  const base = defaultConfig("/nonexistent");
  const grid = sensitivityGrid(base).map((p) => [p.seekGapMs / MIN, p.contextWindowMs / MIN]);
  assert.deepEqual(grid, [
    [2, 10],
    [5, 5],
    [5, 10],
    [5, 20],
    [10, 10],
  ]);

  const store = new EventStore(join(tmp(), "s.db"));
  const events = [ev("git", T0 - DAY, "Add quuxifier"), ...[0, 3, 6, 9].map((m) => ev("zsh", T0 + m * MIN, `rg quuxifier${m}`))];
  store.insert(withSeeks(events));
  const rows = computeSensitivity(store.allEventsSorted(), store, base);
  const byGap = (g: number) => rows.find((r) => r.seekGapMs === g * MIN && r.contextWindowMs === 10 * MIN)!;
  assert.equal(byGap(2).episodes, 4);
  assert.equal(byGap(5).episodes, 1);
  assert.equal(byGap(5).isDefault, true);
  assert.equal(byGap(10).episodes, 1);

  const all = store.allEventsSorted();
  const episodes = buildEpisodes(all, base);
  const { markdown } = renderReport({
    cfg: base,
    counts: [],
    events: all,
    episodes,
    ceiling: evaluateCeiling(episodes, store),
    sensitivity: rows,
    generatedAt: new Date(T0),
  });
  assert.match(markdown, /## Sensitivity to the episode parameters/);
  assert.match(markdown, /\| 5 min \(default\) \| 10 min \| 1 \|/);
  assert.match(markdown, /\| 2 min \| 10 min \| 4 \|/);
  store.close();
});

test("report: an --out path that reaches the repo through a symlink is refused", () => {
  const link = join(tmp(), "looks-outside");
  symlinkSync(REPO, link);
  const cfg = defaultConfig("/nonexistent");
  const input = {
    cfg,
    counts: [],
    events: [],
    episodes: [],
    ceiling: evaluateCeiling([], new EventStore(join(tmp(), "e.db"))),
    generatedAt: new Date(T0),
  };
  assert.throws(() => writeReport(input, join(link, "reports", "new")), /refusing to write a report inside the repo/);
});

test("ingest: the store is owner-only even in a permissive directory", () => {
  const home = tmp();
  const dir = join(home, "shared");
  mkdirSync(dir);
  chmodSync(dir, 0o755);
  const cfg = { ...defaultConfig(home), dbPath: join(dir, "miner.db"), gitRoots: [join(home, "none")] };
  const before = process.umask(0o022);
  try {
    ingest(cfg);
  } finally {
    process.umask(before);
  }
  assert.equal(statSync(cfg.dbPath).mode & 0o777, 0o600);
});
