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

// A forward-captured command with an exit code, keyed for failure/success matching.
interface ExitEvent {
  e: StoredEvent;
  endMs: number;
  key: string;
  exit: number;
  order: number;
}

// Exit-code state changes take effect when a command finishes, so they are replayed in
// completion order (ties keep event order).
function exitEventsByEnd(events: StoredEvent[]): ExitEvent[] {
  const out: ExitEvent[] = [];
  events.forEach((e, order) => {
    if (e.source !== "zsh_hook") return;
    const exit = exitCode(e);
    const key = commandKey(e);
    if (exit === undefined || !key) return;
    out.push({ e, endMs: endTime(e), key, exit, order });
  });
  return out.sort((a, b) => a.endMs - b.endMs || a.order - b.order);
}

// Events must be sorted by timestampMs ascending.
export function buildEpisodes(events: StoredEvent[], p: EpisodeParams): SeekingEpisode[] {
  const exits = exitEventsByEnd(events);
  const episodes: SeekingEpisode[] = [];
  let group: StoredEvent[] = [];
  let firstIndex = -1;
  let lastIndex = -1;

  const close = () => {
    if (group.length === 0) return;
    episodes.push(makeEpisode(events, exits, group, firstIndex, lastIndex, p));
    group = [];
  };

  events.forEach((e, i) => {
    if (e.seeks.length === 0) return;
    const prev = group.at(-1);
    if (prev && e.timestampMs - prev.timestampMs >= p.seekGapMs) close();
    if (group.length === 0) firstIndex = i;
    group.push(e);
    lastIndex = i;
  });
  close();
  return episodes;
}

function makeEpisode(
  events: StoredEvent[],
  exits: ExitEvent[],
  group: StoredEvent[],
  firstSeekIndex: number,
  lastSeekIndex: number,
  p: EpisodeParams,
): SeekingEpisode {
  const first = group[0]!;
  const last = group.at(-1)!;
  const start = first.timestampMs;

  // Context ends at the first seek's own position, so events with the same timestamp that
  // came before it in the source are still context.
  const contextEventIds = events
    .slice(lowerBound(events, start - p.contextWindowMs), firstSeekIndex)
    .slice(-p.maxContextEvents)
    .map((e) => e.eventId);

  const episode: SeekingEpisode = {
    episodeId: createHash("sha256").update(group.map((g) => g.eventId).join(",")).digest("hex").slice(0, 16),
    contextEventIds,
    seekStartMs: start,
    seekActions: group.flatMap((g) => g.seeks.map((s) => ({ kind: s.kind, query: s.query, eventId: g.eventId }))),
  };

  const resolution = findResolution(events, exits, start, lastSeekIndex, last.timestampMs, p);
  if (resolution) {
    episode.resolution = resolution;
    episode.costMs = resolution.atMs - start;
  }
  return episode;
}

function findResolution(
  events: StoredEvent[],
  exits: ExitEvent[],
  seekStartMs: number,
  lastSeekIndex: number,
  lastSeekMs: number,
  p: EpisodeParams,
): SeekingEpisode["resolution"] {
  const contextStart = seekStartMs - p.contextWindowMs;
  const deadline = lastSeekMs + p.resolutionWindowMs;

  // Replay exit codes in completion order. Commands that finished from the start of the
  // context window until the last seek set which commands are still failing (a failure
  // adds, a success clears), whenever they started. After that, the first command to
  // finish successfully while its command is still failing is the resolution; failures
  // in that stretch count too (seek -> fail -> fix -> pass).
  const failed = new Set<string>();
  let i = lowerBoundEnd(exits, contextStart);
  for (; i < exits.length && exits[i]!.endMs <= lastSeekMs; i++) {
    const x = exits[i]!;
    if (x.exit !== 0) failed.add(x.key);
    else failed.delete(x.key);
  }
  for (; i < exits.length && exits[i]!.endMs <= deadline; i++) {
    const x = exits[i]!;
    if (x.exit !== 0) failed.add(x.key);
    else if (failed.has(x.key)) {
      return {
        kind: TEST_COMMAND.test(x.e.contentText) ? "TEST_PASSED" : "COMMAND_SUCCEEDED",
        sourceUri: x.e.sourceUri,
        atMs: x.endMs,
      };
    }
  }

  for (let j = lastSeekIndex + 1; j < events.length; j++) {
    const e = events[j]!;
    if (e.timestampMs > deadline) break;
    if (isBackfillWorkEvent(e)) return { kind: "WORK_RESUMED", sourceUri: e.sourceUri, atMs: e.timestampMs };
  }
  return undefined;
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

function lowerBoundEnd(exits: ExitEvent[], ms: number): number {
  let lo = 0;
  let hi = exits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (exits[mid]!.endMs < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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
