import assert from "node:assert/strict";
import { readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateCeiling } from "../src/miner/ceiling.js";
import { defaultConfig } from "../src/miner/config.js";
import { buildEpisodes } from "../src/miner/episodes.js";
import { isInside, renderReport, sampleIndices, writeReport } from "../src/miner/report.js";
import { withSeeks } from "../src/miner/seek.js";
import { EventStore } from "../src/miner/store.js";
import { emptyCounts } from "../src/miner/types.js";
import { DAY, ev, MIN, REPO, T0, tmp } from "./helpers.js";

function input(sampleSize: number) {
  const cfg = { ...defaultConfig("/nonexistent"), sampleSize };
  const store = new EventStore(join(tmp(), "r.db"));
  const events = [
    ev("git", T0 - 5 * DAY, "Drop --jitless"),
    ...Array.from({ length: 30 }, (_, i) => ev("zsh", T0 + i * 10 * MIN, `rg needle${i % 7}`)),
    ev("zsh", T0 + 15 * MIN, "rg -- --jitless"),
  ];
  store.insert(withSeeks(events));
  const all = store.allEventsSorted();
  const episodes = buildEpisodes(all, cfg);
  const ceiling = evaluateCeiling(episodes, store);
  return { cfg, counts: [{ source: "zsh", label: "/h/.zsh_history", counts: emptyCounts() }], events: all, episodes, ceiling, generatedAt: new Date(T0) };
}

test("report: sampling is deterministic per seed and never larger than the population", () => {
  assert.deepEqual(sampleIndices(100, 25, 7), sampleIndices(100, 25, 7));
  assert.notDeepEqual(sampleIndices(100, 25, 7), sampleIndices(100, 25, 8));
  assert.equal(new Set(sampleIndices(100, 25, 7)).size, 25);
  assert.deepEqual(sampleIndices(3, 25, 1), [0, 1, 2]);
});

test("report: renders rates, sample, and a labels.csv row per sampled episode", () => {
  const inp = input(5);
  const { markdown, csv, sampled } = renderReport(inp);
  assert.equal(sampled.length, 5);
  assert.match(markdown, /\*\*Repeat-seek rate:\*\* \d+\/\d+ \(\d+\.\d%\)/);
  assert.match(markdown, /\*\*Local-hit rate:\*\* \d+\/\d+/);
  assert.match(markdown, /## Sample: 5 episodes \(seed 1\)/);
  const rows = csv.trim().split("\n");
  assert.equal(rows[0], "episode_id,real_seeking_YN,answer_in_my_data_YN,notes");
  assert.equal(rows.length, 6);
  for (const ep of sampled) assert.ok(csv.includes(`${ep.episodeId},,,`));
});

test("report: refuses to write inside the repo; writes 600 files outside it", () => {
  const inp = input(3);
  assert.throws(() => writeReport(inp, join(REPO, "reports-here")), /refusing to write a report inside the repo/);
  assert.equal(isInside(join(REPO, "a", "b"), REPO), true);
  assert.equal(isInside(REPO + "-sibling", REPO), false);

  const out = join(tmp(), "out");
  const w = writeReport(inp, out);
  assert.ok(readFileSync(w.reportPath, "utf8").startsWith("# gadget miner report"));
  assert.equal(statSync(w.reportPath).mode & 0o777, 0o600);
  assert.equal(statSync(w.labelsPath).mode & 0o777, 0o600);
  // Never overwrites: a second report into the same directory fails.
  assert.throws(() => writeReport(inp, out), /EEXIST/);
});

test("report: a report.md symlink planted in the output directory is not followed", () => {
  const inp = input(3);
  const out = tmp();
  const victim = join(tmp(), "tracked-file.txt");
  writeFileSync(victim, "original\n");
  symlinkSync(victim, join(out, "report.md"));
  assert.throws(() => writeReport(inp, out), /EEXIST/);
  assert.equal(readFileSync(victim, "utf8"), "original\n");
});
