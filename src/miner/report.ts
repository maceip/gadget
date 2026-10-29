import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DAY_MS, type CeilingResult, type EpisodeEval, type Rate } from "./ceiling.js";
import type { MinerConfig } from "./config.js";
import { MINER_VERSION } from "./event.js";
import { assertOutsideRepo } from "./paths.js";
import type { SensitivityRow } from "./sensitivity.js";
import type { StoredEvent } from "./store.js";
import type { ParseCounts, SeekingEpisode } from "./types.js";

export { isInside, realResolve, REPO_ROOT } from "./paths.js";

// Deterministic PRNG so a sample can be reproduced from its seed.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleIndices(n: number, k: number, seed: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  const rand = mulberry32(seed);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx.slice(0, Math.min(k, n)).sort((a, b) => a - b);
}

export interface ReportInput {
  cfg: MinerConfig;
  counts: Array<{ source: string; label: string; counts: ParseCounts }>;
  events: StoredEvent[];
  episodes: SeekingEpisode[];
  ceiling: CeilingResult;
  sensitivity?: SensitivityRow[];
  generatedAt: Date;
}

export function renderReport(input: ReportInput): { markdown: string; csv: string; sampled: SeekingEpisode[] } {
  const { cfg, counts, events, episodes, ceiling, generatedAt } = input;
  const byId = new Map(events.map((e) => [e.eventId, e]));
  const evalById = new Map(ceiling.evals.map((e) => [e.episodeId, e]));
  const sampled = sampleIndices(episodes.length, cfg.sampleSize, cfg.seed).map((i) => episodes[i]!);
  const out: string[] = [];

  out.push("# gadget miner report", "");
  out.push(`Generated ${generatedAt.toISOString()} by miner ${MINER_VERSION}. Sample seed ${cfg.seed}.`, "");
  out.push(
    "This report contains your private data. It is written outside the repo and must not be committed.",
    "",
  );

  out.push("## Parameters", "");
  out.push(`- seek gap: ${minutes(cfg.seekGapMs)}`);
  out.push(`- context window: ${minutes(cfg.contextWindowMs)}`);
  out.push(`- resolution window: ${minutes(cfg.resolutionWindowMs)}`, "");

  out.push("## Sources", "");
  out.push("| source | read | parsed | skipped | unknown | location |", "|---|---|---|---|---|---|");
  for (const c of counts) {
    out.push(
      `| ${c.source} | ${c.counts.read} | ${c.counts.parsed} | ${breakdown(c.counts.skipped)} | ${breakdown(c.counts.unknown)} | ${cell(c.label)} |`,
    );
  }
  out.push("");

  out.push("## Episodes", "");
  out.push(`${episodes.length} episodes from ${events.reduce((n, e) => n + e.seeks.length, 0)} seek actions.`, "");
  const kinds = new Map<string, number>();
  for (const ep of episodes) for (const k of new Set(ep.seekActions.map((a) => a.kind))) kinds.set(k, (kinds.get(k) ?? 0) + 1);
  out.push("| seek kind | episodes containing it |", "|---|---|");
  for (const [k, v] of [...kinds].sort()) out.push(`| ${k} | ${v} |`);
  out.push("");
  const resolutions = new Map<string, number>();
  for (const ep of episodes) {
    const k = ep.resolution?.kind ?? "unresolved";
    resolutions.set(k, (resolutions.get(k) ?? 0) + 1);
  }
  out.push("| resolution | episodes | median minutes to resolution |", "|---|---|---|");
  for (const [k, v] of [...resolutions].sort()) {
    const costs = episodes.filter((e) => (e.resolution?.kind ?? "unresolved") === k && e.costMs !== undefined).map((e) => e.costMs!);
    out.push(`| ${k} | ${v} | ${costs.length ? (median(costs) / 60000).toFixed(1) : "-"} |`);
  }
  out.push("");

  out.push("## Ceiling", "");
  out.push(`- **Repeat-seek rate:** ${rate(ceiling.repeatSeek)}. You looked for the same thing in an earlier episode.`);
  out.push(
    `- **Local-hit rate:** ${rate(ceiling.localHit)}. Your own data from before you started looking contains the query's key tokens.`,
  );
  out.push(`- **Local-hit rate, data older than one day:** ${rate(ceiling.localHitOlderThanDay)}.`, "");
  out.push(
    "Both are proxies. A token match is not an answer. Your labels on the sample below are the real measurement; " +
      "the proxies are only useful once they agree with your labels.",
    "",
  );

  if (input.sensitivity?.length) {
    out.push("## Sensitivity to the episode parameters", "");
    out.push(
      "The seek gap decides which seek actions form one episode, so it moves the rates. " +
        "The context window only changes what counts as a failing command before a COMMAND_SUCCEEDED resolution and what context is shown.",
      "",
    );
    out.push(
      "| seek gap | context window | episodes | resolved | repeat-seek | local-hit | local-hit, older than one day |",
      "|---|---|---|---|---|---|---|",
    );
    for (const r of input.sensitivity) {
      out.push(
        `| ${minutes(r.seekGapMs)}${r.isDefault ? " (default)" : ""} | ${minutes(r.contextWindowMs)} | ${r.episodes} | ${r.resolved} | ${rate(r.repeatSeek)} | ${rate(r.localHit)} | ${rate(r.localHitOlderThanDay)} |`,
      );
    }
    out.push("");
  }

  out.push(`## Sample: ${sampled.length} episodes (seed ${cfg.seed})`, "");
  out.push("Label each one in `labels.csv` next to this file: was it real seeking (Y/N), and was the answer already in your data (Y/N).", "");
  sampled.forEach((ep, n) => {
    const ev = evalById.get(ep.episodeId);
    out.push(`### ${n + 1}. \`${ep.episodeId}\` at ${new Date(ep.seekStartMs).toISOString()}`, "");
    out.push("Seek actions:");
    for (const a of ep.seekActions) {
      const e = byId.get(a.eventId);
      out.push(`- ${a.kind}: ${code(a.query)}${e ? ` (${e.source}, ${code(e.sourceUri)})` : ""}`);
    }
    out.push("", "Context before it (most recent last):");
    const ctx = ep.contextEventIds.slice(-5).map((id) => byId.get(id)).filter((e): e is StoredEvent => !!e);
    if (ctx.length === 0) out.push("- (nothing in the context window)");
    for (const e of ctx) out.push(`- ${clock(e.timestampMs)} ${e.source}: ${code(e.contentText)}`);
    out.push("");
    out.push(`Key tokens: ${ev && ev.keyTokens.length ? ev.keyTokens.map(code).join(" ") : "(none)"}`);
    if (!ev || ev.actions.length === 0) out.push("Top local hit: none (no key tokens)");
    for (const a of ev?.actions ?? []) {
      const label = ev!.actions.length > 1 ? ` for ${code(a.query)}` : "";
      out.push(`Top local hit${label}: ${hitLine(a.hit, ep.seekStartMs)}`);
      out.push(`Top local hit${label}, older than one day: ${hitLine(a.hitOlderThanDay, ep.seekStartMs)}`);
    }
    out.push(`Repeat seek: ${ev?.repeatSeek ? "yes" : "no"}`);
    out.push(
      `Resolution: ${ep.resolution ? `${ep.resolution.kind} after ${(ep.costMs! / 60000).toFixed(1)} min` : "none within the window"}`,
      "",
    );
  });

  const csv = ["episode_id,real_seeking_YN,answer_in_my_data_YN,notes", ...sampled.map((ep) => `${ep.episodeId},,,`)].join("\n") + "\n";
  return { markdown: out.join("\n") + "\n", csv, sampled };
}

// Writes report.md and labels.csv to <reportsDir>/<timestamp>/. Refuses any path inside the repo.
export function writeReport(input: ReportInput, outDirOverride?: string): { dir: string; reportPath: string; labelsPath: string } {
  const stamp = input.generatedAt.toISOString().replace(/[:.]/g, "-");
  const dir = resolve(outDirOverride ?? join(input.cfg.reportsDir, stamp));
  assertOutsideRepo(dir, "a report");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { markdown, csv } = renderReport(input);
  const reportPath = join(dir, "report.md");
  const labelsPath = join(dir, "labels.csv");
  // "wx": create only. Never overwrite, and never follow an existing file or symlink
  // at these names (it could point into the repo). If labels.csv fails after report.md
  // is created, remove report.md so a half-written pair is never left behind.
  writeFileSync(reportPath, markdown, { mode: 0o600, flag: "wx" });
  try {
    writeFileSync(labelsPath, csv, { mode: 0o600, flag: "wx" });
  } catch (err) {
    rmSync(reportPath, { force: true });
    throw err;
  }
  return { dir, reportPath, labelsPath };
}

export function rate(r: Rate): string {
  return r.den === 0 ? "0/0 (no usable episodes)" : `${r.num}/${r.den} (${((100 * r.num) / r.den).toFixed(1)}%)`;
}

function hitLine(hit: EpisodeEval["hit"], seekStartMs: number): string {
  if (!hit) return "none";
  const age = seekStartMs - hit.timestampMs;
  const ageText = age >= DAY_MS ? `${(age / DAY_MS).toFixed(1)} days` : `${(age / 60000).toFixed(1)} min`;
  return `${hit.source}, ${ageText} earlier, ${code(hit.sourceUri)}: ${code(hit.snippet)}`;
}

function code(s: string): string {
  const flat = s.replace(/\s+/g, " ").replace(/`/g, "'").trim();
  return "`" + (flat.length > 160 ? flat.slice(0, 157) + "..." : flat) + "`";
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function breakdown(m: Record<string, number>): string {
  const entries = Object.entries(m);
  if (entries.length === 0) return "0";
  return entries.map(([k, v]) => `${cell(k)}=${v}`).join(", ");
}

function minutes(ms: number): string {
  return `${ms / 60000} min`;
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
