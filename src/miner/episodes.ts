import { createHash } from "node:crypto";
import { parseMeta } from "./seek.js";
import { splitCommands } from "./shell.js";
import type { StoredEvent } from "./store.js";
import type { SeekingEpisode } from "./types.js";

export interface EpisodeParams {
  seekGapMs: number; // seek actions closer than this belong to one episode
  contextWindowMs: number; // how far back the trigger context reaches
  resolutionWindowMs: number; // how long after the last seek action to look for a resolution
  maxContextEvents: number;
}

const TEST_COMMAND =
  /\b(pytest|jest|vitest|mocha|rspec|phpunit|ctest)\b|\b(npm|pnpm|yarn|bun)( run)? test\b|\b(cargo|go|swift|mix|dotnet) test\b|\bmake (test|check)\b/;

// Events must be sorted by timestampMs ascending.
export function buildEpisodes(events: StoredEvent[], p: EpisodeParams): SeekingEpisode[] {
  const episodes: SeekingEpisode[] = [];
  let group: StoredEvent[] = [];
  let lastIndex = -1;

  const close = () => {
    if (group.length === 0) return;
    episodes.push(makeEpisode(events, group, lastIndex, p));
    group = [];
  };

  events.forEach((e, i) => {
    if (e.seeks.length === 0) return;
    const prev = group.at(-1);
    if (prev && e.timestampMs - prev.timestampMs >= p.seekGapMs) close();
    group.push(e);
    lastIndex = i;
  });
  close();
  return episodes;
}

function makeEpisode(events: StoredEvent[], group: StoredEvent[], lastIndex: number, p: EpisodeParams): SeekingEpisode {
  const first = group[0]!;
  const last = group.at(-1)!;
  const start = first.timestampMs;

  const firstIndex = lowerBound(events, start - p.contextWindowMs);
  const startIndex = lowerBound(events, start);
  const contextEventIds = events
    .slice(firstIndex, startIndex)
    .slice(-p.maxContextEvents)
    .map((e) => e.eventId);

  const episode: SeekingEpisode = {
    episodeId: createHash("sha256").update(group.map((g) => g.eventId).join(",")).digest("hex").slice(0, 16),
    contextEventIds,
    seekStartMs: start,
    seekActions: group.flatMap((g) => g.seeks.map((s) => ({ kind: s.kind, query: s.query, eventId: g.eventId }))),
  };

  const resolution = findResolution(events, firstIndex, lastIndex, last.timestampMs, p);
  if (resolution) {
    episode.resolution = resolution;
    episode.costMs = resolution.atMs - start;
  }
  return episode;
}

function findResolution(
  events: StoredEvent[],
  contextStartIndex: number,
  lastSeekIndex: number,
  lastSeekMs: number,
  p: EpisodeParams,
): SeekingEpisode["resolution"] {
  // Commands still failing (per the zsh hook), tracked in time order from the start of
  // the context window: a success clears its command's failure, so only failures that are
  // unresolved when seeking ends can be resolved by a later success. Failures after the
  // last seek count too (seek -> fail -> fix -> pass).
  const failed = new Set<string>();
  const noteFailure = (e: StoredEvent) => {
    if (e.source === "zsh_hook" && exitCode(e) !== undefined && exitCode(e) !== 0) {
      const key = commandKey(e);
      if (key) failed.add(key);
    }
  };
  for (let i = contextStartIndex; i <= lastSeekIndex; i++) {
    const e = events[i]!;
    noteFailure(e);
    if (e.source === "zsh_hook" && exitCode(e) === 0) failed.delete(commandKey(e) ?? "");
  }

  const deadline = lastSeekMs + p.resolutionWindowMs;
  let firstWork: StoredEvent | undefined;
  for (let i = lastSeekIndex + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.timestampMs > deadline) break;
    if (e.source === "zsh_hook" && exitCode(e) === 0 && failed.has(commandKey(e) ?? "")) {
      // A success is known when the command finishes, not when it starts.
      const endMs = endTime(e);
      if (endMs > deadline) continue;
      return {
        kind: TEST_COMMAND.test(e.contentText) ? "TEST_PASSED" : "COMMAND_SUCCEEDED",
        sourceUri: e.sourceUri,
        atMs: endMs,
      };
    }
    noteFailure(e);
    if (!firstWork && isBackfillWorkEvent(e)) firstWork = e;
  }
  return firstWork ? { kind: "WORK_RESUMED", sourceUri: firstWork.sourceUri, atMs: firstWork.timestampMs } : undefined;
}

// Normal work by the owner, as opposed to looking things up or reading pages. WORK_RESUMED
// is the weak fallback for backfilled sources only (AGENTS.md 6.1): forward-captured hook
// commands resolve an episode only through an exit-code pair above. git commits are not
// used: `git log --all` includes other people's commits, with no record of local action.
function isBackfillWorkEvent(e: StoredEvent): boolean {
  if (e.seeks.length > 0) return false;
  if (e.source === "zsh") return true;
  return e.source === "codex_session" && parseMeta(e.metadataJson).role === "user";
}

// Identifies "the same command" across a failure and a later success: the working
// directory, the program, and its first non-option argument ("npm test" in /w, not
// "npm install"). Flags may change between attempts and are ignored.
export function commandKey(e: StoredEvent): string | undefined {
  const argv = splitCommands(e.contentText)[0]?.argv;
  if (!argv?.[0]) return undefined;
  const sub = argv.slice(1).find((a) => !a.startsWith("-")) ?? "";
  return [e.workspacePath ?? "", argv[0], sub].join("\u0000");
}

function exitCode(e: StoredEvent): number | undefined {
  const v = parseMeta(e.metadataJson).exit;
  return typeof v === "number" ? v : undefined;
}

function endTime(e: StoredEvent): number {
  const v = parseMeta(e.metadataJson).end_ms;
  return typeof v === "number" && v >= e.timestampMs ? v : e.timestampMs;
}

function lowerBound(events: StoredEvent[], ts: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.timestampMs < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
