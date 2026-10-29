// AGENTS.md 6.1: SEEK_GAP and CONTEXT_WINDOW are parameters, so the report shows the
// results at more than one value instead of trusting the defaults.

import { evaluateCeiling, type Rate } from "./ceiling.js";
import { buildEpisodes, type EpisodeParams } from "./episodes.js";
import type { EventStore, StoredEvent } from "./store.js";

const MIN = 60 * 1000;
const SEEK_GAPS = [2 * MIN, 5 * MIN, 10 * MIN];
const CONTEXT_WINDOWS = [5 * MIN, 10 * MIN, 20 * MIN];

export interface SensitivityRow {
  seekGapMs: number;
  contextWindowMs: number;
  isDefault: boolean;
  episodes: number;
  resolved: number;
  repeatSeek: Rate;
  localHit: Rate;
  localHitOlderThanDay: Rate;
}

// Varies one parameter at a time around the configured values.
export function sensitivityGrid(base: EpisodeParams): EpisodeParams[] {
  const grid: EpisodeParams[] = [];
  const seen = new Set<string>();
  const add = (p: EpisodeParams) => {
    const key = `${p.seekGapMs}/${p.contextWindowMs}`;
    if (!seen.has(key)) {
      seen.add(key);
      grid.push(p);
    }
  };
  add(base);
  for (const g of SEEK_GAPS) add({ ...base, seekGapMs: g });
  for (const c of CONTEXT_WINDOWS) add({ ...base, contextWindowMs: c });
  return grid.sort((a, b) => a.seekGapMs - b.seekGapMs || a.contextWindowMs - b.contextWindowMs);
}

export function computeSensitivity(events: StoredEvent[], store: EventStore, base: EpisodeParams): SensitivityRow[] {
  return sensitivityGrid(base).map((p) => {
    const episodes = buildEpisodes(events, p);
    const c = evaluateCeiling(episodes, store);
    return {
      seekGapMs: p.seekGapMs,
      contextWindowMs: p.contextWindowMs,
      isDefault: p.seekGapMs === base.seekGapMs && p.contextWindowMs === base.contextWindowMs,
      episodes: episodes.length,
      resolved: episodes.filter((e) => e.resolution).length,
      repeatSeek: c.repeatSeek,
      localHit: c.localHit,
      localHitOlderThanDay: c.localHitOlderThanDay,
    };
  });
}
