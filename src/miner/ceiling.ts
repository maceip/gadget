// Ceiling metrics (AGENTS.md section 10, Phase 0 step 5). Both are proxies for
// "the answer already existed in the owner's data"; the owner's labels are the truth.

import type { EventStore, Hit } from "./store.js";
import type { SeekKind, SeekingEpisode } from "./types.js";

export const DAY_MS = 24 * 60 * 60 * 1000;

const STOPWORDS = new Set(
  "the and for with that this from what how why where when which who does did are was were can could would should have has not but you your into about there their them then than use using get set make".split(
    " ",
  ),
);

export function normalizeQuery(q: string): string {
  return q
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// Key tokens keep compound identifiers whole ("wasm-tier-up", "vitre_build"); each one is
// matched as an FTS phrase, so the index's word splitting turns it into adjacent words.
// Leading/trailing '-' and '_' are dropped: "--jitless" matches text that says "jitless".
export function keyTokens(query: string, kind: SeekKind): string[] {
  const raw = (query.match(/[\p{L}\p{N}_-]+/gu) ?? []).map((t) => t.toLowerCase());
  const cleaned = raw
    .map((t) => ({ t: t.replace(/^[-_]+|[-_]+$/g, ""), identifier: /[-_\d]/.test(t) }))
    .filter(({ t }) => t.length >= 3 && !STOPWORDS.has(t));
  const seen = new Set<string>();
  const unique = cleaned.filter(({ t }) => (seen.has(t) ? false : (seen.add(t), true)));
  if (kind === "ASK_AGENT") {
    // Questions are long; prefer identifier-like tokens, else the longest words.
    const ids = unique.filter((u) => u.identifier).map((u) => u.t);
    const pick = ids.length > 0 ? ids : unique.map((u) => u.t).sort((a, b) => b.length - a.length);
    return pick.slice(0, 4);
  }
  return unique.map((u) => u.t).slice(0, 5);
}

export function ftsMatch(tokens: string[]): string {
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
}

export interface EpisodeEval {
  episodeId: string;
  usableQuery: boolean; // has a normalized query of 3+ chars
  repeatSeek: boolean;
  keyTokens: string[];
  hit: Hit | null; // best non-seek match strictly before seekStartMs
  hitOlderThanDay: Hit | null; // best match older than one day before seekStartMs
}

export interface Rate {
  num: number;
  den: number;
}

export interface CeilingResult {
  evals: EpisodeEval[];
  repeatSeek: Rate;
  localHit: Rate;
  localHitOlderThanDay: Rate;
}

// Episodes must be in seekStartMs order.
export function evaluateCeiling(episodes: SeekingEpisode[], store: EventStore): CeilingResult {
  const seen = new Set<string>();
  const evals: EpisodeEval[] = [];
  const repeatSeek: Rate = { num: 0, den: 0 };
  const localHit: Rate = { num: 0, den: 0 };
  const localHitOlderThanDay: Rate = { num: 0, den: 0 };

  for (const ep of episodes) {
    const queries = ep.seekActions.map((a) => normalizeQuery(a.query)).filter((q) => q.length >= 3);
    const usableQuery = queries.length > 0;
    const repeat = usableQuery && queries.some((q) => seen.has(q));
    if (usableQuery) {
      repeatSeek.den++;
      if (repeat) repeatSeek.num++;
    }

    // Each seek action is its own query (all of its tokens must match); the episode has a
    // local hit if any action does. Different actions in one episode are often different
    // phrasings ("rg -- --jitless", then a web search for "v8 jitless").
    const perAction = ep.seekActions.map((a) => keyTokens(a.query, a.kind)).filter((t) => t.length > 0);
    const tokens = [...new Set(perAction.flat())];
    let hit: Hit | null = null;
    let hitOld: Hit | null = null;
    if (perAction.length > 0) {
      for (const t of perAction) {
        const match = ftsMatch(t);
        hit ??= store.searchBefore(match, ep.seekStartMs)[0] ?? null;
        hitOld ??= store.searchBefore(match, ep.seekStartMs - DAY_MS)[0] ?? null;
        if (hit && hitOld) break;
      }
      localHit.den++;
      localHitOlderThanDay.den++;
      if (hit) localHit.num++;
      if (hitOld) localHitOlderThanDay.num++;
    }

    evals.push({ episodeId: ep.episodeId, usableQuery, repeatSeek: repeat, keyTokens: tokens, hit, hitOlderThanDay: hitOld });
    for (const q of queries) seen.add(q);
  }
  return { evals, repeatSeek, localHit, localHitOlderThanDay };
}
