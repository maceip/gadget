// Ported from:
// 1. Einsia/OpenChronicle:
//    - src/openchronicle/capture/event_dispatcher.py (4-timer debounce/dedup gate)
//    - src/openchronicle/capture/scheduler.py (SHA-256 content-fingerprint deduplication)
// 2. screenpipe/screenpipe:
//    - crates/screenpipe-a11y/src/tree/ (viewport bounding-box intersection + LineBudget)
// 3. thunlp/ProactiveAgent (ICLR 2025):
//    - agent/agentmodule.py (ActionListener.send_data multi-stream merger & Watcher on_created for .pdf/.docx/.txt/.md/.html)
// 4. volcengine/MineContext:
//    - opencontext/managers/consumption_manager.py (_analyze_activity_patterns + 4 commitment types)
//    - opencontext/context_consumption/completion/completion_service.py (_should_trigger_completion)
// 5. ProAgentBench (arXiv:2602.04482v2) & ProMemAgent + ideation.md:
//    - Burstiness B = (sigma_dt - mu_dt) / (sigma_dt + mu_dt)
//    - Live numbered/clause commitment pre-fetch trigger ("1) I'll send you...")
//    - Cross-app copy-paste / tab-shuttle oscillation trigger (App A <-> App B)

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";

// ---------------------------------------------------------------------------
// 1. OpenChronicle 4-Timer Event Dispatcher + SHA-256 Content Fingerprint
// ---------------------------------------------------------------------------

export interface OpenChronicleDispatcherConfig {
  debounceMs: number; // default 3000ms
  dedupIntervalMs: number; // default 1000ms
  minCaptureGapMs: number; // default 2000ms
  sameWindowDedupMs: number; // default 5000ms
}

export const DEFAULT_OPENCHRONICLE_CONFIG: OpenChronicleDispatcherConfig = {
  debounceMs: 3000,
  dedupIntervalMs: 1000,
  minCaptureGapMs: 2000,
  sameWindowDedupMs: 5000,
};

export interface DesktopRawNotification {
  kind: "AXFocusedWindowChanged" | "AXValueChanged" | "AXTitleChanged" | "didActivateApplicationNotification";
  app: string;
  windowTitle: string;
  textContent: string;
  timestampMs: number;
}

export function computeContentFingerprint(app: string, windowTitle: string, textContent: string): string {
  const normText = textContent.replace(/\s+/g, " ").trim();
  return createHash("sha256")
    .update(`${app.trim()}\0${windowTitle.trim()}\0${normText}`, "utf8")
    .digest("hex");
}

export class OpenChronicleEventDispatcher {
  readonly cfg: OpenChronicleDispatcherConfig;
  private lastNotificationKey = "";
  private lastNotificationAtMs = -Infinity;
  private lastCaptureAtMs = -Infinity;
  private lastWindowKey = "";
  private lastWindowCaptureAtMs = -Infinity;
  private lastContentFingerprint = "";
  private pendingValueChange: DesktopRawNotification | null = null;

  constructor(cfg: Partial<OpenChronicleDispatcherConfig> = {}) {
    this.cfg = { ...DEFAULT_OPENCHRONICLE_CONFIG, ...cfg };
  }

  // Evaluates whether an incoming OS / Accessibility notification should trigger a capture
  // or be suppressed by one of the 4 timers or the SHA-256 content fingerprint.
  ingestNotification(ev: DesktopRawNotification): {
    accepted: boolean;
    reason:
      | "accepted"
      | "dedup_interval"
      | "debounced_pending"
      | "min_capture_gap"
      | "same_window_dedup"
      | "identical_fingerprint";
    fingerprint?: string;
  } {
    const notifKey = `${ev.kind}:${ev.app}:${ev.windowTitle}`;
    if (
      notifKey === this.lastNotificationKey &&
      ev.timestampMs - this.lastNotificationAtMs < this.cfg.dedupIntervalMs
    ) {
      return { accepted: false, reason: "dedup_interval" };
    }
    this.lastNotificationKey = notifKey;
    this.lastNotificationAtMs = ev.timestampMs;

    // AXValueChanged is debounced until debounceMs elapses
    if (ev.kind === "AXValueChanged") {
      if (
        this.pendingValueChange &&
        ev.timestampMs - this.pendingValueChange.timestampMs < this.cfg.debounceMs
      ) {
        this.pendingValueChange = ev;
        return { accepted: false, reason: "debounced_pending" };
      }
      this.pendingValueChange = ev;
    }

    if (ev.timestampMs - this.lastCaptureAtMs < this.cfg.minCaptureGapMs) {
      return { accepted: false, reason: "min_capture_gap" };
    }

    const windowKey = `${ev.app}::${ev.windowTitle}`;
    if (
      windowKey === this.lastWindowKey &&
      ev.kind !== "AXValueChanged" &&
      ev.timestampMs - this.lastWindowCaptureAtMs < this.cfg.sameWindowDedupMs
    ) {
      return { accepted: false, reason: "same_window_dedup" };
    }

    const fingerprint = computeContentFingerprint(ev.app, ev.windowTitle, ev.textContent);
    if (fingerprint === this.lastContentFingerprint) {
      return { accepted: false, reason: "identical_fingerprint", fingerprint };
    }

    this.lastCaptureAtMs = ev.timestampMs;
    this.lastWindowKey = windowKey;
    this.lastWindowCaptureAtMs = ev.timestampMs;
    this.lastContentFingerprint = fingerprint;
    return { accepted: true, reason: "accepted", fingerprint };
  }
}

// ---------------------------------------------------------------------------
// 2. Screenpipe Viewport Intersection + LineBudget Filter
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AxNodeElement {
  role: string;
  text: string;
  rect: Rect;
}

export function rectIntersects(a: Rect, b: Rect): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function filterVisibleViewportElements(
  elements: ReadonlyArray<AxNodeElement>,
  focusedWindowRect: Rect,
  lineBudget = 200,
): { visible: AxNodeElement[]; droppedOffscreen: number; truncatedByBudget: number } {
  const visible: AxNodeElement[] = [];
  let droppedOffscreen = 0;
  let truncatedByBudget = 0;

  for (const el of elements) {
    if (!el.text.trim()) continue;
    if (!rectIntersects(el.rect, focusedWindowRect)) {
      droppedOffscreen++;
      continue;
    }
    if (visible.length >= lineBudget) {
      truncatedByBudget++;
      continue;
    }
    visible.push(el);
  }
  return { visible, droppedOffscreen, truncatedByBudget };
}

// ---------------------------------------------------------------------------
// 3. ProactiveAgent + MineContext Activity Consolidator & ProAgentBench Burstiness
// ---------------------------------------------------------------------------

const WATCHED_DOC_EXTENSIONS = new Set([".pdf", ".docx", ".txt", ".md", ".html"]);

export interface RawActivityEvent {
  timestampMs: number;
  stream: "window" | "afk" | "vscode" | "browser" | "filesystem" | "clipboard" | "keystroke";
  app?: string;
  title?: string;
  url?: string;
  domInnerText?: string;
  project?: string;
  filePath?: string;
  language?: string;
  isAfk?: boolean;
  textContent?: string;
}

export interface ConsolidatedWindowSegment {
  app: string;
  titles: string[];
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface CreatedFileArtifact {
  filePath: string;
  extension: string;
  timestampMs: number;
  previewText: string; // First 1024 chars (ProactiveAgent Watcher.on_created)
}

export interface ConsolidatedActivityObservation {
  windowSegments: ConsolidatedWindowSegment[];
  projectFiles: Record<string, Array<{ filePath: string; language: string }>>;
  browserSnapshots: Array<{ url: string; title: string; domSnippet: string }>;
  createdArtifacts: CreatedFileArtifact[];
  continuousWorkTimeMs: number;
  taskSwitchingCount: number;
  appDistributionMs: Record<string, number>;
  burstinessScore: number; // ProAgentBench B = (sigma_dt - mu_dt) / (sigma_dt + mu_dt) in [-1, 1]
}

// Computes ProAgentBench burstiness B = (sigma - mu) / (sigma + mu) over inter-event intervals.
export function computeBurstinessScore(timestampsMs: ReadonlyArray<number>): number {
  if (timestampsMs.length < 3) return 0;
  const sorted = [...timestampsMs].sort((a, b) => a - b);
  const deltas: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    deltas.push(Math.max(0, sorted[i]! - sorted[i - 1]!));
  }
  const n = deltas.length;
  const mu = deltas.reduce((a, b) => a + b, 0) / n;
  if (mu === 0) return 0;
  const variance = deltas.reduce((acc, d) => acc + (d - mu) * (d - mu), 0) / n;
  const sigma = Math.sqrt(variance);
  if (sigma + mu === 0) return 0;
  return Number(((sigma - mu) / (sigma + mu)).toFixed(4));
}

export function consolidateActivityStream(events: ReadonlyArray<RawActivityEvent>): ConsolidatedActivityObservation {
  const sorted = [...events].sort((a, b) => a.timestampMs - b.timestampMs);
  const windowSegments: ConsolidatedWindowSegment[] = [];
  const projectFiles: Record<string, Array<{ filePath: string; language: string }>> = {};
  const browserSnapshots: Array<{ url: string; title: string; domSnippet: string }> = [];
  const createdArtifacts: CreatedFileArtifact[] = [];
  const appDistributionMs: Record<string, number> = {};

  let continuousWorkTimeMs = 0;
  let taskSwitchingCount = 0;

  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i]!;
    const nextTs = sorted[i + 1]?.timestampMs ?? ev.timestampMs + 1000;
    const durMs = Math.max(0, nextTs - ev.timestampMs);

    if (ev.stream === "afk") {
      if (!ev.isAfk) continuousWorkTimeMs += durMs;
      continue;
    }

    continuousWorkTimeMs += durMs;

    if (ev.stream === "window" && ev.app) {
      const title = ev.title ?? "";
      appDistributionMs[ev.app] = (appDistributionMs[ev.app] ?? 0) + durMs;
      const prev = windowSegments.at(-1);
      // ProactiveAgent ActionListener.send_data: merge consecutive events in the same app
      if (prev && prev.app === ev.app) {
        prev.endMs = nextTs;
        prev.durationMs += durMs;
        if (title && !prev.titles.includes(title)) {
          prev.titles.push(title);
        }
      } else {
        if (prev && prev.app !== ev.app) {
          taskSwitchingCount++;
        }
        windowSegments.push({
          app: ev.app,
          titles: title ? [title] : [],
          startMs: ev.timestampMs,
          endMs: nextTs,
          durationMs: durMs,
        });
      }
    } else if (ev.stream === "vscode" && ev.project && ev.filePath) {
      const list = (projectFiles[ev.project] ??= []);
      const lang = ev.language ?? (extname(ev.filePath).replace(/^\./, "") || "text");
      if (!list.some((x) => x.filePath === ev.filePath)) {
        list.push({ filePath: ev.filePath, language: lang });
      }
    } else if (ev.stream === "browser" && ev.url) {
      browserSnapshots.push({
        url: ev.url,
        title: ev.title ?? "",
        domSnippet: (ev.domInnerText ?? "").slice(0, 1024),
      });
    } else if (ev.stream === "filesystem" && ev.filePath) {
      const ext = extname(ev.filePath).toLowerCase();
      if (WATCHED_DOC_EXTENSIONS.has(ext)) {
        let previewText = ev.textContent ?? "";
        if (!previewText && existsSync(ev.filePath)) {
          try {
            previewText = readFileSync(ev.filePath, "utf8").slice(0, 1024);
          } catch {
            previewText = "";
          }
        } else {
          previewText = previewText.slice(0, 1024);
        }
        createdArtifacts.push({
          filePath: ev.filePath,
          extension: ext,
          timestampMs: ev.timestampMs,
          previewText,
        });
      }
    }
  }

  const burstinessScore = computeBurstinessScore(sorted.map((e) => e.timestampMs));

  return {
    windowSegments,
    projectFiles,
    browserSnapshots,
    createdArtifacts,
    continuousWorkTimeMs,
    taskSwitchingCount,
    appDistributionMs,
    burstinessScore,
  };
}

// Port of volcengine/MineContext/opencontext/context_consumption/completion/completion_service.py
// (_should_trigger_completion, line 155):
export function shouldTriggerInlineCompletion(text: string, cursorPos = text.length): boolean {
  if (cursorPos < 3 || cursorPos > text.length) return false;
  const beforeCursor = text.slice(0, cursorPos);
  if (beforeCursor.endsWith(" ") || beforeCursor.endsWith("\t") || beforeCursor.endsWith("\n\n")) {
    return false;
  }
  const afterCursor = text.slice(cursorPos);
  if (afterCursor.length > 0 && /^[\p{L}\p{N}_]/u.test(afterCursor)) {
    // Cursor is mid-word
    return false;
  }
  return /\S{2,}$/.test(beforeCursor);
}

// ---------------------------------------------------------------------------
// 4. General-Life / Non-Developer In-Flight Commitment & Cross-App Shuttle Triggers
// ---------------------------------------------------------------------------

export type CommitmentCategory =
  | "EXPLICIT_ASSIGNMENT"
  | "PROACTIVE_COMMITMENT"
  | "TIME_AGREEMENT"
  | "EXPLICIT_FOLLOW_UP"
  | "NUMBERED_LIST_COMMITMENT";

export interface DetectedCommitment {
  category: CommitmentCategory;
  clauseText: string;
  prefetchQuery: string;
  completedClause: boolean; // True when followed by next numbered item or sentence boundary
}

const COMMITMENT_STOPWORDS = new Set([
  "i",
  "ill",
  "i'll",
  "we",
  "we'll",
  "will",
  "going",
  "to",
  "let",
  "me",
  "send",
  "share",
  "forward",
  "grab",
  "pull",
  "up",
  "find",
  "check",
  "follow",
  "on",
  "the",
  "a",
  "an",
  "you",
  "your",
  "our",
  "my",
  "that",
  "this",
  "for",
  "with",
  "by",
  "before",
  "after",
  "tomorrow",
  "today",
  "tonight",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "morning",
  "afternoon",
  "evening",
  "eod",
  "asap",
  "please",
  "can",
  "could",
  "make",
  "sure",
  "need",
  "todo",
  "action",
  "item",
]);

function extractTargetQueryFromClause(clause: string): string {
  const words = (clause.toLowerCase().match(/[\p{L}\p{N}._/-]+/gu) ?? [])
    .map((w) => w.replace(/^[.,;:!?()-]+|[.,;:!?()-]+$/g, ""))
    .filter((w) => w.length >= 3 && !COMMITMENT_STOPWORDS.has(w));
  return words.slice(0, 5).join(" ");
}

// Detects general-life, email/chat, meeting, and document commitments across MineContext's
// 4 categories plus ideation.md's numbered/bulleted in-flight clause trigger ("1) I'll send you... 2)").
export function detectInFlightCommitments(text: string): DetectedCommitment[] {
  const out: DetectedCommitment[] = [];
  const seen = new Set<string>();

  const pushUnique = (c: DetectedCommitment) => {
    const key = `${c.category}::${c.prefetchQuery}`;
    if (!c.prefetchQuery || seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  // 1. ideation.md rule: "start looking up before user is done typing (say 1. in a list of commitments)"
  // Matches completed numbered/bulleted item 1 when item 2 has started or a newline/punctuation completed item 1.
  const numberedRegex =
    /(?:^|\n|\s)(?:1[.)]|[-*])\s+([^\n]+?)(?=(?:\s+2[.)]|\n\s*(?:2[.)]|[-*])|\n|$))/g;
  for (const m of text.matchAll(numberedRegex)) {
    const clause = m[1]?.trim() ?? "";
    if (!clause) continue;
    const restAfterMatch = text.slice((m.index ?? 0) + m[0].length);
    const completedClause = /^\s*(?:2[.)]|[-*]|\n)/.test(restAfterMatch) || /[.!?]$/.test(clause);
    if (completedClause) {
      pushUnique({
        category: "NUMBERED_LIST_COMMITMENT",
        clauseText: clause,
        prefetchQuery: extractTargetQueryFromClause(clause),
        completedClause: true,
      });
    }
  }

  // Split into clauses/sentences for the 4 MineContext / ProMemAgent commitment categories
  const clauses = text
    .split(/(?:[\r\n]+|(?<=[.!?])\s+|;\s+)/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const clause of clauses) {
    const completed = /[.!?;]$/.test(clause) || text.indexOf(clause) + clause.length < text.length;

    // Proactive Commitment ("I'll send over the...", "Let me grab the...", "I will attach the...")
    if (/\b(i['’]?ll|i\s+will|let\s+me|we['’]?ll|i\s+am\s+going\s+to)\s+(send|share|forward|attach|grab|pull\s+up|find|check|look\s+up|drop|upload)\b/i.test(clause)) {
      pushUnique({
        category: "PROACTIVE_COMMITMENT",
        clauseText: clause,
        prefetchQuery: extractTargetQueryFromClause(clause),
        completedClause: completed,
      });
    }

    // Explicit Assignment ("Action item:", "TODO:", "@alice please...", "Need to submit...")
    if (/\b(action\s+item|todo|assigned\s+to|need\s+to\s+(?:submit|pay|renew|file|book|send))\b/i.test(clause)) {
      pushUnique({
        category: "EXPLICIT_ASSIGNMENT",
        clauseText: clause,
        prefetchQuery: extractTargetQueryFromClause(clause),
        completedClause: completed,
      });
    }

    // Time Agreement ("by Friday", "before EOD", "tomorrow morning", "due on 2026-...")
    if (/\b(by\s+(?:monday|tuesday|wednesday|thursday|friday|eod|tomorrow|tonight)|before\s+(?:eod|noon|our\s+call)|due\s+on\s+\d{4}-\d{2}-\d{2})\b/i.test(clause)) {
      pushUnique({
        category: "TIME_AGREEMENT",
        clauseText: clause,
        prefetchQuery: extractTargetQueryFromClause(clause),
        completedClause: completed,
      });
    }

    // Explicit Follow-up ("follow up on...", "circle back on...", "ping about...")
    if (/\b(follow\s+up\s+(?:on|with)|circle\s+back\s+on|check\s+back\s+on|remind\s+me\s+about)\b/i.test(clause)) {
      pushUnique({
        category: "EXPLICIT_FOLLOW_UP",
        clauseText: clause,
        prefetchQuery: extractTargetQueryFromClause(clause),
        completedClause: completed,
      });
    }
  }

  return out;
}

export interface CrossAppShuttleTrigger {
  triggered: boolean;
  appA: string;
  appB: string;
  alternations: number;
  clipboardCopies: number;
  windowDurationMs: number;
  extractedEntities: string[];
}

// Detects rapid bipartite cross-app oscillation (App A <-> App B, e.g. Chrome <-> Sheets/Notes/Mail)
// where a user is manually shuttling information across windows.
export function detectCrossAppShuttle(
  events: ReadonlyArray<RawActivityEvent>,
  opts: { maxWindowMs?: number; minAlternations?: number } = {},
): CrossAppShuttleTrigger | null {
  const maxWindowMs = opts.maxWindowMs ?? 3 * 60 * 1000;
  const minAlternations = opts.minAlternations ?? 4;

  const sorted = [...events].sort((a, b) => a.timestampMs - b.timestampMs);
  if (sorted.length === 0) return null;

  const endMs = sorted.at(-1)!.timestampMs;
  const recent = sorted.filter((e) => endMs - e.timestampMs <= maxWindowMs);

  const windowSwitches: Array<{ app: string; title: string; timestampMs: number }> = [];
  let clipboardCopies = 0;
  const entities = new Set<string>();

  for (const ev of recent) {
    if (ev.stream === "clipboard") {
      clipboardCopies++;
      if (ev.textContent) {
        for (const tok of ev.textContent.match(/\b[A-Za-z0-9_.-]{4,}\b/g) ?? []) {
          entities.add(tok);
        }
      }
    }
    if (ev.stream === "window" && ev.app) {
      const prev = windowSwitches.at(-1);
      if (!prev || prev.app !== ev.app) {
        windowSwitches.push({
          app: ev.app,
          title: ev.title ?? "",
          timestampMs: ev.timestampMs,
        });
      }
      if (ev.title) {
        for (const tok of ev.title.match(/\b[A-Za-z0-9_.-]{4,}\b/g) ?? []) {
          entities.add(tok);
        }
      }
    }
  }

  if (windowSwitches.length < minAlternations) return null;

  // Find the most frequent alternating pair (A <-> B)
  const pairCounts = new Map<string, { appA: string; appB: string; count: number; startMs: number; endMs: number }>();
  for (let i = 1; i < windowSwitches.length; i++) {
    const prev = windowSwitches[i - 1]!;
    const cur = windowSwitches[i]!;
    if (prev.app === cur.app) continue;
    const [appA, appB] = [prev.app, cur.app].sort();
    const key = `${appA}<->${appB}`;
    const entry = pairCounts.get(key);
    if (entry) {
      entry.count++;
      entry.endMs = cur.timestampMs;
    } else {
      pairCounts.set(key, {
        appA: appA!,
        appB: appB!,
        count: 1,
        startMs: prev.timestampMs,
        endMs: cur.timestampMs,
      });
    }
  }

  let best: { appA: string; appB: string; count: number; startMs: number; endMs: number } | null = null;
  for (const entry of pairCounts.values()) {
    if (!best || entry.count > best.count) {
      best = entry;
    }
  }

  if (!best || best.count < minAlternations - 1) return null;

  return {
    triggered: true,
    appA: best.appA,
    appB: best.appB,
    alternations: best.count,
    clipboardCopies,
    windowDurationMs: best.endMs - best.startMs,
    extractedEntities: [...entities].slice(0, 10),
  };
}
