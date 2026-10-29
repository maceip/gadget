// Replay Harness (AGENTS.md sections 8 and 10 Phase 1).
// Evaluates upper-bound baseline, realistic context-only baseline, and Anticipator v0
// strictly with `asOfMs = episode.seekStartMs` for every searcher.

import { keyTokens } from "../miner/ceiling.js";
import { median } from "../miner/report.js";
import type { EventStore } from "../miner/store.js";
import type { SeekingEpisode } from "../miner/types.js";
import { CalibratedAnticipator } from "./anticipator.js";
import { FtsEventsSearcher, GitPickaxeSearcher, RepoGrepSearcher, SessionsSearcher } from "./searchers.js";
import { VerifiedSurfacer } from "./surfacer.js";
import type { Anticipator, ContextWindow, Hit, Searcher } from "./types.js";
import { hitToClaim, verifyClaim } from "./verify.js";

export interface ReplayMetrics {
  mode: "upper_bound" | "realistic" | "anticipator";
  episodesEvaluated: number;
  answerableEpisodes: number;
  hits: number;
  hitRate: number; // hits / episodesEvaluated
  answerableHitRate: number; // hits / answerableEpisodes
  leadTimeMinutesMedian: number;
  falseSurfacings: number;
  negativeWindowsEvaluated: number;
  falseSurfacingRate: number;
  answerableMisses: number;
  answerableMissRate: number;
  lies: number;
  surfacedClaimsCount: number;
  lieRate: number;
}

export interface ReplaySummary {
  upperBound: ReplayMetrics;
  realistic: ReplayMetrics;
  anticipator: ReplayMetrics;
}

export interface ReplayOptions {
  negativeWindows?: ContextWindow[];
  anticipator?: Anticipator;
  workspacePath?: string;
}

// Determines whether a surfaced Hit matches the episode's ground-truth answer (either its
// resolution sourceUri/answerSpan, an upper-bound oracle hit eventId, or a verified local hit
// containing the episode's key tokens strictly before seekStartMs).
export function hitMatchesEpisode(
  hit: Hit,
  ep: SeekingEpisode,
  store: EventStore,
  oracleEventIds?: ReadonlySet<string>,
): boolean {
  let evTextLower = hit.quote.toLowerCase();
  if (hit.eventId) {
    const ev = store.getEventById(hit.eventId);
    if (!ev || ev.timestampMs >= ep.seekStartMs) return false;
    if (oracleEventIds?.has(hit.eventId)) return true;
    evTextLower = ev.contentText.toLowerCase();
  }
  if (ep.resolution?.sourceUri && hit.sourceUri === ep.resolution.sourceUri) {
    return true;
  }
  if (ep.resolution?.answerSpan && evTextLower.includes(ep.resolution.answerSpan.toLowerCase())) {
    return true;
  }
  for (const action of ep.seekActions) {
    const tokens = keyTokens(action.query, action.kind);
    if (
      tokens.length > 0 &&
      tokens.every((t) => {
        const tl = t.toLowerCase();
        if (evTextLower.includes(tl)) return true;
        const parts = tl.split(/[-_]+/).filter(Boolean);
        return parts.length > 1 && parts.every((p) => evTextLower.includes(p));
      })
    ) {
      return true;
    }
  }
  return false;
}

export async function runReplay(
  episodes: SeekingEpisode[],
  store: EventStore,
  opts: ReplayOptions = {},
): Promise<ReplaySummary> {
  const searchers = new Map<string, Searcher>([
    ["fts_events", new FtsEventsSearcher(store, opts.workspacePath)],
    ["git_pickaxe", new GitPickaxeSearcher(store, opts.workspacePath)],
    ["sessions", new SessionsSearcher(store, opts.workspacePath)],
    ["repo_grep", new RepoGrepSearcher(store, opts.workspacePath)],
  ]);
  const surfacer = new VerifiedSurfacer(store);
  const anticipator =
    opts.anticipator ?? new CalibratedAnticipator(store, { priorEpisodes: episodes });
  const negativeWindows = opts.negativeWindows ?? buildNegativeWindows(episodes, store);

  // First compute which episodes are locally answerable using the upper-bound oracle
  // (searching with the owner's actual seek query strictly before seekStartMs).
  const answerableSet = new Set<string>();
  const upperHitsByEp = new Map<string, Hit[]>();

  for (const ep of episodes) {
    const asOfMs = ep.seekStartMs;
    const allHits: Hit[] = [];
    for (const action of ep.seekActions) {
      const ftsHits = await searchers.get("fts_events")!.search(action.query, asOfMs);
      allHits.push(...ftsHits);
      if (opts.workspacePath) {
        const grepHits = await searchers.get("repo_grep")!.search(action.query, asOfMs);
        allHits.push(...grepHits);
      }
    }
    const ctx = episodeContextWindow(ep, store, opts.workspacePath);
    const { accepted } = surfacer.filterSurfacableHits(ctx, allHits);
    upperHitsByEp.set(ep.episodeId, accepted);
    if (accepted.some((h) => hitMatchesEpisode(h, ep, store))) {
      answerableSet.add(ep.episodeId);
    }
  }

  const evalMode = async (mode: "upper_bound" | "realistic" | "anticipator"): Promise<ReplayMetrics> => {
    let hits = 0;
    let answerableMisses = 0;
    let lies = 0;
    let surfacedClaimsCount = 0;
    const leadTimesMin: number[] = [];

    for (const ep of episodes) {
      const asOfMs = ep.seekStartMs;
      const ctx = episodeContextWindow(ep, store, opts.workspacePath);
      let candidateHits: Hit[] = [];

      if (mode === "upper_bound") {
        candidateHits = upperHitsByEp.get(ep.episodeId) ?? [];
      } else if (mode === "realistic") {
        // Realistic baseline: uses only raw text of the last context event with naive FTS,
        // without Anticipator scoring, flag extraction, or workspace history routing.
        const lastId = ctx.eventIds.at(-1);
        const lastEv = lastId ? store.getEventById(lastId) : undefined;
        if (lastEv && lastEv.timestampMs < asOfMs) {
          const naiveTokens = (lastEv.contentText.match(/[\p{L}\p{N}_-]+/gu) ?? []).slice(0, 4);
          if (naiveTokens.length >= 2) {
            candidateHits = await searchers.get("fts_events")!.search(naiveTokens.join(" "), asOfMs);
          }
        }
      } else {
        // Anticipator v0: scores context window, proposes targeted queries and searchers.
        const proposals = anticipator.propose(ctx);
        for (const p of proposals) {
          const hasFts = p.searchers.includes("fts_events");
          for (const sid of p.searchers) {
            if (hasFts && (sid === "git_pickaxe" || sid === "sessions")) continue;
            if (sid === "repo_grep" && !opts.workspacePath) continue;
            const searcher = searchers.get(sid);
            if (!searcher) continue;
            const found = await searcher.search(p.query, asOfMs);
            candidateHits.push(...found);
          }
        }
      }

      const decision = surfacer.decide(ctx, candidateHits);
      const { accepted } = surfacer.filterSurfacableHits(ctx, candidateHits);
      const surfaced = decision.action === "SURFACE" ? accepted : [];

      for (const h of surfaced) {
        surfacedClaimsCount++;
        if (h.eventId) {
          const { claim, freshnessByEventId } = hitToClaim(h, store);
          const v = verifyClaim(claim, store, { asOfMs, freshnessByEventId });
          if (!v.passed) lies++;
        }
      }

      const oracleIds = new Set(
        (upperHitsByEp.get(ep.episodeId) ?? [])
          .filter((h) => hitMatchesEpisode(h, ep, store))
          .map((h) => h.eventId)
          .filter((id): id is string => typeof id === "string"),
      );
      const matched = surfaced.some((h) => hitMatchesEpisode(h, ep, store, oracleIds));
      if (matched) {
        hits++;
        const firstCtxId = ctx.eventIds[0];
        const firstCtxEv = firstCtxId ? store.getEventById(firstCtxId) : undefined;
        const leadMs = firstCtxEv ? Math.max(0, ep.seekStartMs - firstCtxEv.timestampMs) : 0;
        leadTimesMin.push(leadMs / 60000);
      } else if (answerableSet.has(ep.episodeId) && surfaced.length === 0) {
        answerableMisses++;
      }
    }

    let falseSurfacings = 0;
    for (const negCtx of negativeWindows) {
      let negCandidates: Hit[] = [];
      if (mode === "realistic") {
        const lastId = negCtx.eventIds.at(-1);
        const lastEv = lastId ? store.getEventById(lastId) : undefined;
        if (lastEv && lastEv.timestampMs < negCtx.endMs) {
          negCandidates = await searchers.get("fts_events")!.search(lastEv.contentText.slice(0, 80), negCtx.endMs);
        }
      } else if (mode === "anticipator") {
        const proposals = anticipator.propose(negCtx);
        for (const p of proposals) {
          const hasFts = p.searchers.includes("fts_events");
          for (const sid of p.searchers) {
            if (hasFts && (sid === "git_pickaxe" || sid === "sessions")) continue;
            if (sid === "repo_grep" && !opts.workspacePath) continue;
            const searcher = searchers.get(sid);
            if (!searcher) continue;
            negCandidates.push(...(await searcher.search(p.query, negCtx.endMs)));
          }
        }
      }
      if (negCandidates.length > 0 && surfacer.decide(negCtx, negCandidates).action === "SURFACE") {
        falseSurfacings++;
      }
    }

    const total = episodes.length;
    const answerable = answerableSet.size;
    return {
      mode,
      episodesEvaluated: total,
      answerableEpisodes: answerable,
      hits,
      hitRate: total > 0 ? hits / total : 0,
      answerableHitRate: answerable > 0 ? hits / answerable : 0,
      leadTimeMinutesMedian: median(leadTimesMin),
      falseSurfacings,
      negativeWindowsEvaluated: negativeWindows.length,
      falseSurfacingRate: negativeWindows.length > 0 ? falseSurfacings / negativeWindows.length : 0,
      answerableMisses,
      answerableMissRate: answerable > 0 ? answerableMisses / answerable : 0,
      lies,
      surfacedClaimsCount,
      lieRate: surfacedClaimsCount > 0 ? lies / surfacedClaimsCount : 0,
    };
  };

  return {
    upperBound: await evalMode("upper_bound"),
    realistic: await evalMode("realistic"),
    anticipator: await evalMode("anticipator"),
  };
}

export function formatReplayTable(s: ReplaySummary): string {
  const rows = [s.upperBound, s.realistic, s.anticipator];
  const lines = [
    "| mode | hit rate (all) | hit rate (answerable) | median lead (min) | false surfacing | answerable miss | lie rate |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.mode} | ${r.hits}/${r.episodesEvaluated} (${pct(r.hitRate)}) | ${r.hits}/${r.answerableEpisodes} (${pct(r.answerableHitRate)}) | ${r.leadTimeMinutesMedian.toFixed(1)} | ${r.falseSurfacings}/${r.negativeWindowsEvaluated} (${pct(r.falseSurfacingRate)}) | ${r.answerableMisses}/${r.answerableEpisodes} (${pct(r.answerableMissRate)}) | ${r.lies}/${r.surfacedClaimsCount} (${pct(r.lieRate)}) |`,
    );
  }
  return lines.join("\n");
}

function episodeContextWindow(ep: SeekingEpisode, store: EventStore, fallbackWorkspace?: string): ContextWindow {
  let ws = fallbackWorkspace;
  if (!ws) {
    for (let i = ep.contextEventIds.length - 1; i >= 0; i--) {
      const ev = store.getEventById(ep.contextEventIds[i]!);
      if (ev?.workspacePath) {
        ws = ev.workspacePath;
        break;
      }
    }
  }
  const ctx: ContextWindow = {
    endMs: ep.seekStartMs,
    eventIds: ep.contextEventIds,
  };
  if (ws) ctx.workspacePath = ws;
  return ctx;
}

// Builds negative (non-seeking) context windows from stretches of normal events that have no
// seek action within 15 minutes after them.
function buildNegativeWindows(episodes: SeekingEpisode[], store: EventStore, maxWindows = 25): ContextWindow[] {
  const rows = store.db
    .prepare(
      `SELECT event_id, timestamp_ms, workspace_path
         FROM events
        WHERE is_seek = 0 AND source != 'git'
        ORDER BY timestamp_ms DESC
        LIMIT 500`,
    )
    .all() as Array<{ event_id: string; timestamp_ms: number; workspace_path: string | null }>;
  const seekTimes = episodes.map((e) => e.seekStartMs);
  const horizonMs = 15 * 60 * 1000;
  const out: ContextWindow[] = [];

  for (let i = 0; i < rows.length && out.length < maxWindows; i++) {
    const e = rows[i]!;
    const nearSeek = seekTimes.some((t) => t >= e.timestamp_ms - horizonMs && t <= e.timestamp_ms + horizonMs);
    if (nearSeek) continue;
    const ctx: ContextWindow = {
      endMs: e.timestamp_ms + 1,
      eventIds: [e.event_id],
    };
    if (e.workspace_path) ctx.workspacePath = e.workspace_path;
    out.push(ctx);
  }
  return out;
}

function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}
