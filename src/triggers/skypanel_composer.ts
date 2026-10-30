// De Minimis Skypanel Card Composer & Proactive Engine Integrator.
//
// Unifies BOTH trigger paths onto the same de minimis 2-row Skypanel HUD & Agent Brief:
//   1. SPOKEN_UTTERANCE ("Hey Gadget", "Note to self", "Mental note", "FYI", "PSA", etc.)
//   2. PROACTIVE_ANTICIPATOR (CalibratedAnticipator + Multi-Searcher + VerifiedSurfacer)
//
// Renders a 2-row de minimis card:
//   Row 1: [ {source modality icons}   <2-5 word nugget label>   {target app icons} ]
//   Row 2: [                {revise}   {mode: app | agent}       {go go gadget}     ]

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertOutsideRepo } from "../miner/paths.js";
import type { EventStore } from "../miner/store.js";
import { FtsEventsSearcher, GitPickaxeSearcher, RepoGrepSearcher, SessionsSearcher } from "../runtime/searchers.js";
import { formatUntrustedDataBlock } from "../runtime/sink.js";
import { VerifiedSurfacer } from "../runtime/surfacer.js";
import type { ContextWindow, Hit } from "../runtime/types.js";
import { classifyCosmoSlots, type SpokenSlotRecord } from "./cosmo_spoken_slots.js";

export type SkypanelIconId =
  | "android"
  | "messages"
  | "calendar"
  | "chrome"
  | "terminal"
  | "github"
  | "docs"
  | "mic"
  | "timer"
  | "recall"
  | "agent";

export type SkypanelSurface = "desktop" | "browser" | "mobile";
export type SkypanelTriggerKind = "SPOKEN_UTTERANCE" | "PROACTIVE_ANTICIPATOR";
export type SkypanelExecutionMode = "app" | "agent";

export interface SkypanelRevision {
  atMs: number;
  instruction: string;
  previousLabel: string;
  newLabel: string;
}

export interface SkypanelVerifiedHit {
  sourceUri: string;
  eventId?: string;
  quote: string;
  freshness: string;
  freshnessCheck: string;
}

export interface SkypanelAgentReceipt {
  executedAtMs: number;
  mode: SkypanelExecutionMode;
  summary: string;
  verifiedHitCount: number;
  artifactPaths: string[];
}

export interface SkypanelCard {
  cardId: string;
  slotId: string;
  triggerKind: SkypanelTriggerKind;
  anticipatorScore: number;
  createdAtMs: number;
  updatedAtMs: number;
  compactLabel: string;
  sourceIcons: SkypanelIconId[];
  targetIcons: SkypanelIconId[];
  selectedMode: SkypanelExecutionMode;
  contactName: string | null;
  inferredWorkingHours: string;
  proposedTimeIso: string | null;
  proposedTimeLabel: string | null;
  contextSummary: string;
  verifiedHits: SkypanelVerifiedHit[];
  stagedReply: string | null;
  stagedIcs: string | null;
  stagedAgentBrief: string;
  activeSurface: SkypanelSurface;
  revisions: SkypanelRevision[];
  status: "PENDING" | "DISPATCHED" | "DISMISSED";
  dispatchedPaths: string[];
  agentReceipt: SkypanelAgentReceipt | null;
}

const STOPWORDS = new Set([
  "hey",
  "gadget",
  "note",
  "self",
  "mental",
  "fyi",
  "psa",
  "vip",
  "asap",
  "adr",
  "tbc",
  "remind",
  "bookmark",
  "lock",
  "respond",
  "reply",
  "message",
  "text",
  "ping",
  "call",
  "set",
  "setup",
  "schedule",
  "book",
  "meeting",
  "meet",
  "time",
  "with",
  "and",
  "the",
  "for",
  "about",
  "tomorrow",
  "today",
  "tonight",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "morning",
  "afternoon",
  "evening",
  "next",
  "this",
  "week",
  "make",
  "some",
  "dont",
  "forget",
  "your",
  "check",
  "look",
  "into",
  "write",
  "create",
  "draft",
]);

/**
 * Dynamically extracts a person/contact handle from the utterance text without any hardcoded names.
 */
export function extractContactName(bodyText: string): string | null {
  const patterns = [
    /\b(?:respond\s+to|reply\s+to|text|message|ping|ask|tell|meet\s+with|meeting\s+with|set\s+up\s+a?\s*time\s+with|schedule\s+with|follow\s+up\s+with|call|email)\s+([A-Za-z][A-Za-z0-9_-]{1,24})\b/i,
    /\bwith\s+([A-Z][a-z]{1,20})\b/,
  ];

  for (const re of patterns) {
    const m = re.exec(bodyText);
    if (m && m[1]) {
      const candidate = m[1].trim();
      if (!STOPWORDS.has(candidate.toLowerCase())) {
        return candidate.charAt(0).toUpperCase() + candidate.slice(1).toLowerCase();
      }
    }
  }
  return null;
}

/**
 * Produces a concise 2-5 word nugget label dynamically from the utterance and extracted contact.
 */
export function buildCompactNuggetLabel(bodyText: string, contactName: string | null): string {
  const lower = bodyText.toLowerCase();
  const hasMeetingIntent = /\b(?:set\s+up\s+a?\s*time|meet|meeting|schedule|calendar|sync|call)\b/i.test(lower);
  const hasReplyIntent = /\b(?:respond|reply|text|message|ping)\b/i.test(lower);

  if (contactName) {
    if (hasMeetingIntent) {
      return `set meeting ${contactName.toLowerCase()}`;
    }
    if (hasReplyIntent) {
      return `reply ${contactName.toLowerCase()}`;
    }
  }

  const cleaned = bodyText
    .replace(
      /^(?:remind\s+me\s+to|remind\s+me\s+about|remind\s+me|don'?t\s+forget\s+to|don'?t\s+forget\s+about|i\s+need\s+to|make\s+sure\s+to|go\s+make\s+me\s+some|go\s+make\s+me|please)\s+/i,
      "",
    )
    .replace(/\b(?:and\s+set\s+up\s+a\s+time\s+to)\b/gi, " ")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  const words = cleaned.split(" ").filter((w) => w.length > 1 && w !== "your" && w !== "about");
  if (words.length === 0) return bodyText.slice(0, 28).toLowerCase();
  return words.slice(0, 4).join(" ");
}

/**
 * Infers the owner's typical working hours from empirical timestamp distributions in `EventStore`
 * and selects a conflict-free slot against existing `calendar` events and `spoken_slots`.
 */
export function inferWorkingHoursAndNextSlot(
  store: EventStore,
  nowMs: number,
  explicitTimeText?: string,
): {
  workingHoursLabel: string;
  startHour: number;
  endHour: number;
  proposedTimeIso: string;
  proposedTimeLabel: string;
} {
  let startHour = 9;
  let endHour = 18;

  try {
    const rows = store.db
      .prepare(`SELECT timestamp_ms FROM events ORDER BY timestamp_ms DESC LIMIT 2000`)
      .all() as Array<{ timestamp_ms: number }>;

    if (rows.length >= 20) {
      const hourCounts = new Array<number>(24).fill(0);
      for (const r of rows) {
        const d = new Date(Number(r.timestamp_ms));
        const h = d.getHours();
        if (h >= 0 && h < 24) hourCounts[h]!++;
      }
      let bestSum = -1;
      let bestStart = 9;
      for (let s = 7; s <= 13; s++) {
        let sum = 0;
        for (let h = s; h < s + 9; h++) sum += hourCounts[h] ?? 0;
        if (sum > bestSum) {
          bestSum = sum;
          bestStart = s;
        }
      }
      startHour = bestStart;
      endHour = bestStart + 9;
    }
  } catch {
    // default 9am-6pm if empty DB
  }

  const fmtHour = (h: number) => {
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:00 ${ampm}`;
  };
  const workingHoursLabel = `${fmtHour(startHour)} – ${fmtHour(endHour)} local`;

  const base = new Date(nowMs);
  const candidate = new Date(nowMs);

  const lowerTime = (explicitTimeText ?? "").toLowerCase();
  const explicitHourMatch = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i.exec(lowerTime);

  if (/\btomorrow\b/.test(lowerTime)) {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(startHour + 1, 0, 0, 0);
  } else if (/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(lowerTime)) {
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const matchedDay = dayNames.findIndex((d) => lowerTime.includes(d));
    if (matchedDay >= 0) {
      const currentDay = candidate.getDay();
      let daysAhead = (matchedDay - currentDay + 7) % 7;
      if (daysAhead === 0) daysAhead = 7;
      candidate.setDate(candidate.getDate() + daysAhead);
      candidate.setHours(startHour + 1, 0, 0, 0);
    }
  } else {
    const nextHour = base.getHours() + 2;
    if (nextHour >= startHour && nextHour <= endHour - 1) {
      candidate.setHours(nextHour, 0, 0, 0);
    } else {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(startHour + 1, 0, 0, 0);
    }
  }

  if (explicitHourMatch) {
    let hr = Number(explicitHourMatch[1]);
    const min = explicitHourMatch[2] ? Number(explicitHourMatch[2]) : 0;
    const mer = explicitHourMatch[3]!.toLowerCase();
    if (mer.startsWith("p") && hr < 12) hr += 12;
    if (mer.startsWith("a") && hr === 12) hr = 0;
    candidate.setHours(hr, min, 0, 0);
  } else if (/\bafternoon\b/.test(lowerTime)) {
    candidate.setHours(14, 0, 0, 0);
  } else if (/\bmorning\b/.test(lowerTime)) {
    candidate.setHours(Math.max(9, startHour), 0, 0, 0);
  } else if (/\b(?:evening|tonight)\b/.test(lowerTime)) {
    candidate.setHours(18, 0, 0, 0);
  }

  // Avoid colliding with any existing calendar events in EventStore
  try {
    const calRows = store.db
      .prepare(`SELECT metadata_json FROM events WHERE source = 'calendar' ORDER BY timestamp_ms DESC LIMIT 50`)
      .all() as Array<{ metadata_json: string }>;
    const busyHours = new Set<number>();
    for (const r of calRows) {
      try {
        const meta = JSON.parse(r.metadata_json) as { startIso?: string };
        if (meta.startIso) {
          const d = new Date(meta.startIso);
          if (d.toDateString() === candidate.toDateString()) {
            busyHours.add(d.getHours());
          }
        }
      } catch {
        // ignore
      }
    }
    while (busyHours.has(candidate.getHours()) && candidate.getHours() < endHour) {
      candidate.setHours(candidate.getHours() + 1);
    }
  } catch {
    // ignore
  }

  const dayStr = candidate.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const timeStr = candidate.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return {
    workingHoursLabel,
    startHour,
    endHour,
    proposedTimeIso: candidate.toISOString(),
    proposedTimeLabel: `${dayStr} · ${timeStr}`,
  };
}

export function inferActiveSurface(store: EventStore, nowMs = Date.now()): SkypanelSurface {
  try {
    const latestScreen = store.db
      .prepare(
        `SELECT metadata_json, timestamp_ms FROM events WHERE source = 'screen' ORDER BY timestamp_ms DESC LIMIT 1`,
      )
      .get() as { metadata_json: string; timestamp_ms: number } | undefined;

    if (latestScreen && nowMs - Number(latestScreen.timestamp_ms) < 5 * 60 * 1000) {
      const meta = JSON.parse(latestScreen.metadata_json) as { app?: string };
      const app = (meta.app ?? "").toLowerCase();
      if (app.includes("chrome") || app.includes("safari") || app.includes("arc") || app.includes("firefox")) {
        return "browser";
      }
      return "desktop";
    }
  } catch {
    // ignore
  }
  return "desktop";
}

function buildIcsCalendarContent(opts: {
  uid: string;
  summary: string;
  description: string;
  startIso: string;
  durationMinutes?: number;
}): string {
  const start = new Date(opts.startIso);
  const end = new Date(start.getTime() + (opts.durationMinutes ?? 30) * 60 * 1000);
  const fmtIcsDate = (d: Date) =>
    d
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//GoGoGadget Ambient Recall//Skypanel//EN",
    "BEGIN:VEVENT",
    `UID:${opts.uid}@gogogadget.local`,
    `DTSTAMP:${fmtIcsDate(new Date())}`,
    `DTSTART:${fmtIcsDate(start)}`,
    `DTEND:${fmtIcsDate(end)}`,
    `SUMMARY:${opts.summary.replace(/[\r\n]+/g, " ")}`,
    `DESCRIPTION:${opts.description.replace(/[\r\n]+/g, "\\n")}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/**
 * Runs the Proactive Engine's searchers (`FtsEventsSearcher`, `GitPickaxeSearcher`,
 * `RepoGrepSearcher`, `SessionsSearcher`) and `VerifiedSurfacer` (`verifyClaim` + `asOfMs` cutoff).
 */
export async function runProactiveSearchForQuery(
  store: EventStore,
  query: string,
  asOfMs: number,
  workspacePath?: string,
  contextEventIds: string[] = [],
): Promise<Hit[]> {
  if (!query.trim()) return [];
  const fts = new FtsEventsSearcher(store, workspacePath);
  const git = new GitPickaxeSearcher(store, workspacePath);
  const sessions = new SessionsSearcher(store, workspacePath);
  const surfacer = new VerifiedSurfacer(store);

  const rawHits: Hit[] = [];
  try {
    rawHits.push(...(await fts.search(query, asOfMs)));
    rawHits.push(...(await git.search(query, asOfMs)));
    rawHits.push(...(await sessions.search(query, asOfMs)));
    if (workspacePath) {
      const repoGrep = new RepoGrepSearcher(store, workspacePath);
      rawHits.push(...(await repoGrep.search(query, asOfMs)));
    }
  } catch {
    // ignore searcher edge cases
  }

  const ctx: ContextWindow = {
    endMs: asOfMs,
    eventIds: contextEventIds,
    ...(workspacePath ? { workspacePath } : {}),
  };

  const { accepted } = surfacer.filterSurfacableHits(
    ctx,
    rawHits.filter((h) => !h.sourceUri.includes("/capture/screen.jsonl:")),
  );
  return accepted.slice(0, 4);
}

/**
 * Composes a complete `SkypanelCard` from a `SpokenSlotRecord` by dynamically resolving
 * contacts, prior messages/events, source/target app icons, working hours, and
 * verified hits from `EventStore`.
 */
export function composeSkypanelCard(
  slot: SpokenSlotRecord,
  store: EventStore,
  existingCard?: SkypanelCard,
  preverifiedHits: Hit[] = [],
): SkypanelCard {
  const contactName = extractContactName(slot.bodyText);
  const compactLabel = buildCompactNuggetLabel(slot.bodyText, contactName);
  const lower = slot.bodyText.toLowerCase();

  const matchedContextSnippets: string[] = [];
  let sawAndroidOrSms = false;
  let sawMessagesApp = false;
  let sawChrome = false;
  let sawGitOrTerminal = false;

  const searchTerms: string[] = [];
  if (contactName) searchTerms.push(contactName.toLowerCase());
  const words = lower
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  searchTerms.push(...words.slice(0, 3));

  const verifiedHits: SkypanelVerifiedHit[] = preverifiedHits.map((h) => ({
    sourceUri: h.sourceUri,
    ...(h.eventId ? { eventId: h.eventId } : {}),
    quote: h.quote,
    freshness: h.freshness,
    freshnessCheck: h.freshnessCheck,
  }));

  if (searchTerms.length > 0) {
    try {
      const ftsQuery = [...new Set(searchTerms)]
        .slice(0, 4)
        .map((t) => `"${t.replace(/"/g, '""')}"`)
        .join(" OR ");
      const hits = store.searchBefore(ftsQuery, slot.timestampMs + 1, 5);
      for (const h of hits) {
        const snipLower = `${h.source} ${h.sourceUri} ${h.snippet}`.toLowerCase();
        if (h.source === "android" || snipLower.includes("android") || snipLower.includes("sms")) {
          sawAndroidOrSms = true;
        }
        if (
          h.source === "messages" ||
          h.source === "android" ||
          snipLower.includes("messages") ||
          snipLower.includes("imessage") ||
          snipLower.includes("sms")
        ) {
          sawMessagesApp = true;
        }
        if (h.source === "chrome") sawChrome = true;
        if (h.source === "git" || h.source === "zsh" || h.source === "zsh_hook") sawGitOrTerminal = true;
        matchedContextSnippets.push(`[${h.source}] ${h.snippet.replace(/\s+/g, " ").trim()}`);
        if (verifiedHits.length < 4 && !verifiedHits.some((vh) => vh.eventId === h.eventId)) {
          verifiedHits.push({
            sourceUri: h.sourceUri,
            eventId: h.eventId,
            quote: h.snippet.replace(/\s+/g, " ").trim(),
            freshness: "CURRENT",
            freshnessCheck: `store_cutoff_verified(ts=${h.timestampMs} <= asOfMs=${slot.timestampMs}): CURRENT`,
          });
        }
      }
    } catch {
      // ignore FTS query errors
    }
  }

  const combinedContextLower =
    `${slot.bodyText} ${slot.context.activeApp ?? ""} ${slot.context.windowTitle ?? ""} ${slot.context.screenSnippet ?? ""}`.toLowerCase();

  if (
    combinedContextLower.includes("android") ||
    combinedContextLower.includes("sms") ||
    combinedContextLower.includes("text") ||
    /\b(?:respond\s+to|reply\s+to)\b/i.test(slot.bodyText)
  ) {
    sawAndroidOrSms = true;
    sawMessagesApp = true;
  }
  if (combinedContextLower.includes("messages")) {
    sawMessagesApp = true;
  }
  if (combinedContextLower.includes("chrome") || slot.allSlots.includes("BROWSING_AGENT")) {
    sawChrome = true;
  }
  if (combinedContextLower.includes("github") || combinedContextLower.includes("pull request")) {
    sawGitOrTerminal = true;
  }

  const sourceIcons: SkypanelIconId[] = [];
  if (sawAndroidOrSms) sourceIcons.push("android");
  if (sawMessagesApp) sourceIcons.push("messages");
  if (sawChrome && sourceIcons.length < 2) sourceIcons.push("chrome");
  if (sawGitOrTerminal && sourceIcons.length < 2) sourceIcons.push("github");
  if (sourceIcons.length === 0) {
    sourceIcons.push("mic");
  }

  const targetIcons: SkypanelIconId[] = [];
  const wantsMeetingOrCalendar =
    slot.allSlots.includes("CREATE_CALENDAR_EVENT") ||
    slot.allSlots.includes("PROVIDE_EVENT_CONTEXT") ||
    /\b(?:meet|meeting|set\s+up\s+a?\s*time|schedule|calendar|court\s+case|hearing|appointment)\b/i.test(slot.bodyText);

  if (wantsMeetingOrCalendar) {
    targetIcons.push("calendar");
  }
  if (slot.allSlots.includes("ADD_TIMER")) {
    targetIcons.push("timer");
  }
  if (slot.allSlots.includes("CREATE_DOC")) {
    targetIcons.push("docs");
  }
  if (slot.allSlots.includes("PROVIDE_RECALL")) {
    targetIcons.push("recall");
  }
  if (targetIcons.length === 0) {
    targetIcons.push("agent");
  }

  const defaultMode: SkypanelExecutionMode =
    existingCard?.selectedMode ??
    (wantsMeetingOrCalendar || Boolean(contactName) ? "app" : "agent");

  const schedule = inferWorkingHoursAndNextSlot(store, slot.timestampMs, slot.extractedTimeText);
  const hasTimeSlot = wantsMeetingOrCalendar || slot.isTimeBoundCommitment;

  const proposedTimeIso = hasTimeSlot ? schedule.proposedTimeIso : null;
  const proposedTimeLabel = hasTimeSlot ? schedule.proposedTimeLabel : null;

  const stagedReply = contactName
    ? `Hey ${contactName} — let's meet ${schedule.proposedTimeLabel} (within my ${schedule.workingHoursLabel} window). Let me know if that works!`
    : null;

  const cardId =
    existingCard?.cardId ??
    createHash("sha256")
      .update(`skypanel_card\0${slot.slotId}`)
      .digest("hex")
      .slice(0, 20);

  const stagedIcs =
    wantsMeetingOrCalendar && proposedTimeIso
      ? buildIcsCalendarContent({
          uid: cardId,
          summary: contactName ? `Meeting with ${contactName}` : compactLabel,
          description: `Triggered via "${slot.triggerPrefix}": ${slot.bodyText}${stagedReply ? `\n\nStaged note: ${stagedReply}` : ""}`,
          startIso: proposedTimeIso,
          durationMinutes: 30,
        })
      : null;

  const contextParts: string[] = [];
  if (contactName) {
    contextParts.push(`Contact: ${contactName} (${sawAndroidOrSms ? "Android SMS / Messages" : "local history"})`);
  }
  if (proposedTimeLabel) {
    contextParts.push(`Slot: ${proposedTimeLabel} (Working hrs: ${schedule.workingHoursLabel})`);
  }
  if (slot.context.activeApp || slot.context.windowTitle) {
    contextParts.push(`Screen: ${slot.context.activeApp ?? "App"} — ${slot.context.windowTitle ?? ""}`.trim());
  }
  if (matchedContextSnippets[0]) {
    contextParts.push(`Prior: ${matchedContextSnippets[0].slice(0, 100)}`);
  }
  const contextSummary =
    contextParts.join(" · ") || `Captured via "${slot.triggerPrefix}" (${slot.primarySlot})`;

  const stagedAgentBrief = [
    `# Go Go Gadget — Approved Skypanel Action (${compactLabel})`,
    `- **Card ID:** \`${cardId}\` | **Slot ID:** \`${slot.slotId}\` | **Trigger:** \`SPOKEN_UTTERANCE\` (\`${slot.triggerPrefix}\`)`,
    `- **Selected Mode:** \`${defaultMode}\` (\`app\` = Native App/Draft Launch, \`agent\` = Scoped Action Agent)`,
    `- **Spoken Utterance:** "${slot.bodyText}"`,
    `- **Cosmo Gatekeeper Heads:** \`${slot.allSlots.join(", ")}\``,
    contactName ? `- **Resolved Contact:** \`${contactName}\` (Modalities: \`${sourceIcons.join(", ")}\`)` : null,
    proposedTimeLabel
      ? `- **Proposed Calendar Slot:** \`${proposedTimeLabel}\` (\`${proposedTimeIso}\`, inferred working hours: \`${schedule.workingHoursLabel}\`)`
      : null,
    stagedReply ? `- **Staged Reply Draft (local outbox):** "${stagedReply}"` : null,
    slot.context.windowTitle
      ? `- **Visual Context at Utterance:** \`${slot.context.activeApp ?? "unknown"}\` — \`${slot.context.windowTitle}\``
      : null,
    verifiedHits.length > 0
      ? [
          "",
          "## Proactive Engine Verified Context Hits",
          ...verifiedHits.map((vh, idx) =>
            formatUntrustedDataBlock(
              {
                sourceUri: vh.sourceUri,
                ...(vh.eventId ? { eventId: vh.eventId } : {}),
                quote: vh.quote,
                freshness: "CURRENT",
                freshnessCheck: vh.freshnessCheck,
              },
              idx,
            ),
          ),
        ].join("\n")
      : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  return {
    cardId,
    slotId: slot.slotId,
    triggerKind: "SPOKEN_UTTERANCE",
    anticipatorScore: 1.0,
    createdAtMs: existingCard?.createdAtMs ?? slot.timestampMs,
    updatedAtMs: Date.now(),
    compactLabel,
    sourceIcons,
    targetIcons,
    selectedMode: defaultMode,
    contactName,
    inferredWorkingHours: schedule.workingHoursLabel,
    proposedTimeIso,
    proposedTimeLabel,
    contextSummary,
    verifiedHits,
    stagedReply,
    stagedIcs,
    stagedAgentBrief,
    activeSurface: inferActiveSurface(store, slot.timestampMs),
    revisions: existingCard?.revisions ?? [],
    status: existingCard?.status ?? "PENDING",
    dispatchedPaths: existingCard?.dispatchedPaths ?? [],
    agentReceipt: existingCard?.agentReceipt ?? null,
  };
}

/**
 * Composes a Proactive Skypanel Card when `CalibratedAnticipator` + `VerifiedSurfacer`
 * autonomously identify a high-value verified nugget from the owner's history.
 */
export function composeProactiveSkypanelCard(opts: {
  query: string;
  pSeek: number;
  reason: string;
  acceptedHits: Hit[];
  store: EventStore;
  nowMs?: number;
}): SkypanelCard | null {
  const topHit = opts.acceptedHits[0];
  if (!topHit) return null;
  const nowMs = opts.nowMs ?? Date.now();

  const cardId = createHash("sha256")
    .update(`proactive_card\0${opts.query.toLowerCase().trim()}\0${topHit.sourceUri}`)
    .digest("hex")
    .slice(0, 20);

  const sourceIcons: SkypanelIconId[] = [];
  for (const h of opts.acceptedHits.slice(0, 3)) {
    const uri = h.sourceUri.toLowerCase();
    if (uri.startsWith("git:") || uri.includes("github")) {
      if (!sourceIcons.includes("github")) sourceIcons.push("github");
    } else if (uri.includes("zsh")) {
      if (!sourceIcons.includes("terminal")) sourceIcons.push("terminal");
    } else if (uri.includes("chrome") || uri.startsWith("http")) {
      if (!sourceIcons.includes("chrome")) sourceIcons.push("chrome");
    } else if (uri.includes("codex") || uri.includes("antigravity")) {
      if (!sourceIcons.includes("agent")) sourceIcons.push("agent");
    }
  }
  if (sourceIcons.length === 0) sourceIcons.push("terminal");

  const targetIcons: SkypanelIconId[] = ["recall", "agent"];
  const compactLabel = `recall · ${opts.query.trim().toLowerCase().split(/\s+/).slice(0, 3).join(" ")}`;
  const schedule = inferWorkingHoursAndNextSlot(opts.store, nowMs);

  const verifiedHits: SkypanelVerifiedHit[] = opts.acceptedHits.slice(0, 4).map((h) => ({
    sourceUri: h.sourceUri,
    ...(h.eventId ? { eventId: h.eventId } : {}),
    quote: h.quote,
    freshness: h.freshness,
    freshnessCheck: h.freshnessCheck,
  }));

  const stagedAgentBrief = [
    `# Go Go Gadget — Proactive Engine Recall Brief (${compactLabel})`,
    `- **Card ID:** \`${cardId}\` | **Trigger:** \`PROACTIVE_ANTICIPATOR\` (\`pSeek=${opts.pSeek.toFixed(2)}\`)`,
    `- **Anticipated Query:** \`${opts.query}\``,
    `- **Surfacer Decision:** ${opts.reason}`,
    "",
    "## Verified Historical Hits",
    ...opts.acceptedHits.slice(0, 4).map((h, i) => formatUntrustedDataBlock(h, i)),
  ].join("\n");

  return {
    cardId,
    slotId: `proactive_${cardId}`,
    triggerKind: "PROACTIVE_ANTICIPATOR",
    anticipatorScore: opts.pSeek,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    compactLabel,
    sourceIcons: sourceIcons.slice(0, 2),
    targetIcons,
    selectedMode: "agent",
    contactName: null,
    inferredWorkingHours: schedule.workingHoursLabel,
    proposedTimeIso: null,
    proposedTimeLabel: null,
    contextSummary: `Proactive Anticipator (pSeek=${opts.pSeek.toFixed(2)}) · ${opts.acceptedHits.length} verified hit(s) · Top: ${topHit.sourceUri.slice(0, 60)}`,
    verifiedHits,
    stagedReply: null,
    stagedIcs: null,
    stagedAgentBrief,
    activeSurface: inferActiveSurface(opts.store, nowMs),
    revisions: [],
    status: "PENDING",
    dispatchedPaths: [],
    agentReceipt: null,
  };
}

export function reviseSkypanelCard(
  card: SkypanelCard,
  slot: SpokenSlotRecord | undefined,
  instruction: string,
  store: EventStore,
): { updatedSlot?: SpokenSlotRecord; updatedCard: SkypanelCard } {
  if (slot) {
    const combinedBody = `${slot.bodyText} (${instruction.trim()})`;
    const reclass = classifyCosmoSlots(combinedBody);

    const updatedSlot: SpokenSlotRecord = {
      ...slot,
      bodyText: combinedBody,
      primarySlot: reclass.primarySlot,
      allSlots: reclass.allSlots,
      ...(reclass.extractedTimeText
        ? { extractedTimeText: reclass.extractedTimeText }
        : slot.extractedTimeText
          ? { extractedTimeText: slot.extractedTimeText }
          : {}),
      isTimeBoundCommitment: reclass.isTimeBoundCommitment,
    };

    const recomposed = composeSkypanelCard(updatedSlot, store, card);
    const rev: SkypanelRevision = {
      atMs: Date.now(),
      instruction: instruction.trim(),
      previousLabel: card.compactLabel,
      newLabel: recomposed.compactLabel,
    };
    recomposed.revisions = [...card.revisions, rev];
    recomposed.status = "PENDING";

    return { updatedSlot, updatedCard: recomposed };
  }

  const newLabel = buildCompactNuggetLabel(instruction, extractContactName(instruction));
  const rev: SkypanelRevision = {
    atMs: Date.now(),
    instruction: instruction.trim(),
    previousLabel: card.compactLabel,
    newLabel,
  };
  const updatedCard: SkypanelCard = {
    ...card,
    updatedAtMs: Date.now(),
    compactLabel: newLabel,
    contextSummary: `${card.contextSummary} · Revised: ${instruction.trim()}`,
    stagedAgentBrief: `${card.stagedAgentBrief}\n\n## Owner Revision\n- ${instruction.trim()}`,
    revisions: [...card.revisions, rev],
    status: "PENDING",
  };
  return { updatedCard };
}

/**
 * Mode 1 (`app` — Native App / Draft Launch):
 * Stages concrete `.ics` calendar invite, reply draft, and action brief into `~/.gadget/staged/`.
 */
export function executeNativeAppMode(
  card: SkypanelCard,
  dbPath: string,
): { updatedCard: SkypanelCard; writtenPaths: string[] } {
  const stagedDir = join(dirname(dbPath), "staged");
  assertOutsideRepo(stagedDir, "staged Skypanel actions");
  mkdirSync(stagedDir, { recursive: true, mode: 0o700 });
  chmodSync(stagedDir, 0o700);

  const writtenPaths: string[] = [];

  const briefPath = join(stagedDir, `gadget-action-${card.cardId}.md`);
  writeFileSync(briefPath, `${card.stagedAgentBrief}\n`, { mode: 0o600 });
  chmodSync(briefPath, 0o600);
  writtenPaths.push(briefPath);

  if (card.stagedIcs) {
    const icsPath = join(stagedDir, `meeting-${card.cardId}.ics`);
    writeFileSync(icsPath, card.stagedIcs, { mode: 0o600 });
    chmodSync(icsPath, 0o600);
    writtenPaths.push(icsPath);
  }

  if (card.stagedReply) {
    const replyPath = join(stagedDir, `reply-${card.cardId}.txt`);
    writeFileSync(replyPath, `${card.stagedReply}\n`, { mode: 0o600 });
    chmodSync(replyPath, 0o600);
    writtenPaths.push(replyPath);
  }

  const receipt: SkypanelAgentReceipt = {
    executedAtMs: Date.now(),
    mode: "app",
    summary: `Staged ${writtenPaths.length} native app artifact(s) (${card.stagedIcs ? "Calendar .ics + " : ""}${card.stagedReply ? "Reply draft + " : ""}Action brief)`,
    verifiedHitCount: card.verifiedHits.length,
    artifactPaths: writtenPaths,
  };

  const updatedCard: SkypanelCard = {
    ...card,
    selectedMode: "app",
    updatedAtMs: Date.now(),
    status: "DISPATCHED",
    dispatchedPaths: writtenPaths,
    agentReceipt: receipt,
  };

  return { updatedCard, writtenPaths };
}
