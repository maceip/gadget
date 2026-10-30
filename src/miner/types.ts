// Shapes from AGENTS.md section 5. Keep them in sync with that file.

export type Source =
  | "zsh"
  | "zsh_hook"
  | "chrome"
  | "codex_session"
  | "antigravity_session"
  | "git"
  | "clipboard"
  | "screen"
  | "audio"
  | "keyboard"
  | "android"
  | "messages"
  | "calendar";

export type SeekKind = "WEB_SEARCH" | "GREP" | "GIT_ARCHAEOLOGY" | "HELP_LOOKUP" | "ASK_AGENT";

export type ResolutionKind = "PASTE_FROM_SOURCE" | "COMMAND_SUCCEEDED" | "TEST_PASSED" | "WORK_RESUMED";

export interface EpisodicEvent {
  eventId: string;
  source: Source;
  timestampMs: number;
  workspacePath?: string;
  contentText: string;
  sourceUri: string;
  metadataJson: string;
}

export interface Seek {
  kind: SeekKind;
  query: string;
}

export interface SeekingEpisode {
  episodeId: string;
  contextEventIds: string[];
  seekStartMs: number;
  seekActions: Array<{ kind: SeekKind; query: string; eventId: string }>;
  resolution?: {
    kind: ResolutionKind;
    sourceUri?: string;
    answerSpan?: string;
    atMs: number;
  };
  costMs?: number; // seekStart -> resolution; absent when unresolved
}

// Every parser reports what it read, kept, skipped (with reasons), and did not recognize.
export interface ParseCounts {
  read: number;
  parsed: number;
  skipped: Record<string, number>;
  unknown: Record<string, number>;
}

export interface ParseResult {
  events: EpisodicEvent[];
  counts: ParseCounts;
}

export function emptyCounts(): ParseCounts {
  return { read: 0, parsed: 0, skipped: {}, unknown: {} };
}

export function bump(map: Record<string, number>, key: string, n = 1): void {
  map[key] = (map[key] ?? 0) + n;
}

export function mergeCounts(into: ParseCounts, from: ParseCounts): void {
  into.read += from.read;
  into.parsed += from.parsed;
  for (const [k, v] of Object.entries(from.skipped)) bump(into.skipped, k, v);
  for (const [k, v] of Object.entries(from.unknown)) bump(into.unknown, k, v);
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function safeLabel(s: string): string {
  return /^[a-z0-9_./-]{1,60}$/i.test(s) ? s : "<unprintable>";
}
