// Cosmo-inspired Spoken Commitment & Multi-Head Gatekeeper Slot Engine.
//
// Models the 13 Conformer heads (AudioGatekeepingModel) + 6 RegexGatekeepingModelV0
// slots from com.google.research.air.cosmo, triggered by:
//   1. "Hey Gadget" (alone wake phrase)
//   2. Human-safe discreet prefixes that do NOT attract human attention in a room
//      ("Note to self", "Mental note", "FYI", "PSA", "Bookmark", "Remind me",
//       "Lock it in", "VIP", "ASAP", "ADR", "TBC")
//
// Every triggered utterance is classified into one or more Cosmo slots, parsed for
// time-bound deadlines (TBCs), and stapled to the concurrent screen/window/clipboard
// context at the moment it was spoken or typed.

import { createHash } from "node:crypto";
import type { EpisodicEvent } from "../miner/types.js";

export type CosmoSlotKind =
  | "CREATE_CALENDAR_EVENT" // Conformer head 4 (0.90): Time-Bound Commitment (TBC) with deadline/date/time
  | "ADD_TASK"              // RegexGatekeepingV0 head 16: Action item / To-Do
  | "ADD_TIMER"             // Conformer head 12 (0.90): Countdown / relative time trigger ("in 20 min", "food time")
  | "ADD_TO_LIST"           // Conformer head 1 (0.65): Add item to a named list
  | "ADD_TO_MEMORY"         // Conformer head 0 (0.57): Declarative fact / memory pin
  | "PROVIDE_RECALL"        // RegexGatekeepingV0 head 13: "What did I say / see earlier about X?"
  | "PROVIDE_PERSON_CONTEXT"// Conformer head 6 (0.56): Person / relationship context
  | "PROVIDE_EVENT_CONTEXT" // Conformer head 7 (0.74): Court case / meeting / flight / event context
  | "CREATE_DOC"            // Conformer head 5 (0.90): Draft or create a document/note
  | "DEEP_RESEARCH"         // Conformer head 8 (0.90): Deep research / investigate topic
  | "DEFINE_TERM"           // Conformer head 2 (0.90): Term / concept lookup
  | "QUERY_PHOTOS"          // Conformer head 3 (0.90): Screenshot / visual reference
  | "PROVIDE_INSIGHT"       // Conformer head 9 (0.90): Synthesis / pattern insight
  | "BROWSING_AGENT";       // Conformer head 10 (0.90): URL / browser lookup

export type TriggerSocialMode =
  | "alone_wake_word"       // "Hey Gadget" — high salience when alone, attracts human attention in groups
  | "human_safe_self_note"  // "Note to self", "Mental note", "Remind me", "Bookmark", "Lock it in" — humans recognize as self-talk
  | "human_safe_acronym";   // "FYI", "PSA", "VIP", "ASAP", "ADR", "TBC" — brief initialisms without "Hey"

export interface TriggerPrefixSpec {
  id: string;
  canonicalLabel: string;
  socialMode: TriggerSocialMode;
  whisperExactRate: string;
  pattern: RegExp;
}

/**
 * Empirically verified prefixes tested against `/opt/homebrew/bin/whisper-cli`
 * (`ggml-base.en.bin`). Includes both "Hey Gadget" (when alone) and non-"Hey"
 * prefixes that won't make nearby humans turn around thinking you addressed them.
 */
export const SPOKEN_TRIGGER_PREFIXES: readonly TriggerPrefixSpec[] = [
  {
    id: "hey_gadget",
    canonicalLabel: "Hey Gadget",
    socialMode: "alone_wake_word",
    whisperExactRate: "100% (3/3)",
    pattern: /^(?:hey|hi|okay|ok|yo)\s+gadget[\s,.:;\-!?]+/i,
  },
  {
    id: "note_to_self",
    canonicalLabel: "Note to self",
    socialMode: "human_safe_self_note",
    whisperExactRate: "100% (3/3)",
    pattern: /^(?:let\s+me\s+make\s+a\s+|quick\s+)?note\s+to\s+self[\s,.:;\-!?]+/i,
  },
  {
    id: "mental_note",
    canonicalLabel: "Mental note",
    socialMode: "human_safe_self_note",
    whisperExactRate: "100% (3/3)",
    pattern: /^(?:make\s+a\s+|quick\s+)?mental\s+note[\s,.:;\-!?]+/i,
  },
  {
    id: "fyi",
    canonicalLabel: "FYI",
    socialMode: "human_safe_acronym",
    whisperExactRate: "100% (3/3)",
    pattern: /^f\.?y\.?i\.?(?:\s+gadget)?[\s,.:;\-!?]+/i,
  },
  {
    id: "psa",
    canonicalLabel: "PSA",
    socialMode: "human_safe_acronym",
    whisperExactRate: "100% (3/3)",
    pattern: /^p\.?s\.?a\.?(?:\s+gadget)?[\s,.:;\-!?]+/i,
  },
  {
    id: "remind_me",
    canonicalLabel: "Remind me",
    socialMode: "human_safe_self_note",
    whisperExactRate: "100% (3/3)",
    pattern: /^remind\s+me(?:\s+to|\s+about|\s+that)?[\s,.:;\-!?]+/i,
  },
  {
    id: "bookmark",
    canonicalLabel: "Bookmark",
    socialMode: "human_safe_self_note",
    whisperExactRate: "100% (3/3)",
    pattern: /^bookmark(?:\s+this)?[\s,.:;\-!?]+/i,
  },
  {
    id: "lock_it_in",
    canonicalLabel: "Lock it in",
    socialMode: "human_safe_self_note",
    whisperExactRate: "100% (3/3)",
    pattern: /^lock\s+it\s+in[\s,.:;\-!?]+/i,
  },
  {
    id: "vip",
    canonicalLabel: "VIP",
    socialMode: "human_safe_acronym",
    whisperExactRate: "100% (3/3)",
    pattern: /^v\.?i\.?p\.?[\s,.:;\-!?]+/i,
  },
  {
    id: "asap",
    canonicalLabel: "ASAP",
    socialMode: "human_safe_acronym",
    whisperExactRate: "100% (3/3)",
    pattern: /^a\.?s\.?a\.?p\.?[\s,.:;\-!?]+/i,
  },
  {
    id: "adr",
    canonicalLabel: "ADR",
    socialMode: "human_safe_acronym",
    whisperExactRate: "100% (3/3)",
    pattern: /^a\.?d\.?r\.?[\s,.:;\-!?]+/i,
  },
  {
    id: "tbc",
    canonicalLabel: "TBC",
    socialMode: "human_safe_acronym",
    whisperExactRate: "33% (clipped when fast; supported for typed/clear speech)",
    pattern: /^t\.?b\.?c\.?[\s,.:;\-!?]+/i,
  },
];

export interface SpokenSlotContextSnapshot {
  screenEventId?: string;
  activeApp?: string;
  windowTitle?: string;
  screenSnippet?: string;
  clipboardEventId?: string;
  clipboardSnippet?: string;
  workspacePath?: string;
}

export interface SpokenSlotRecallHit {
  eventId: string;
  source: string;
  timestampMs: number;
  sourceUri: string;
  quote: string;
}

export interface SpokenSlotRecord {
  slotId: string;
  eventId: string;
  source: EpisodicEvent["source"];
  timestampMs: number;
  triggerId: string;
  triggerPrefix: string;
  socialMode: TriggerSocialMode;
  primarySlot: CosmoSlotKind;
  allSlots: CosmoSlotKind[];
  rawText: string;
  bodyText: string;
  extractedTimeText?: string;
  isTimeBoundCommitment: boolean;
  context: SpokenSlotContextSnapshot;
  recallHits?: SpokenSlotRecallHit[];
  status: "ACTIVE" | "RESOLVED";
}

// Time-bound expression detector (dates, days of week, relative durations, clock times, deadlines)
const TIME_BOUND_PATTERNS: readonly RegExp[] = [
  /\b(?:by|before|until|on|at|this|next|tomorrow)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|night|tonight|noon|midnight|weekend|week|month)\b/i,
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:morning|afternoon|evening|night|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i,
  /\b(?:at|by|around|before|after)\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i,
  /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?\b/i,
  /\bin\s+(?:\d+|a|an|one|two|three|four|five|ten|fifteen|twenty|thirty|forty-five|sixty)\s+(?:second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks)\b/i,
  /\b(?:tomorrow|tonight|today|this\s+evening|this\s+afternoon|this\s+morning|end\s+of\s+day|eod|end\s+of\s+week|eow)\b/i,
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?\b/i,
];

// Timer / countdown / immediate alarm patterns (Cosmo head 12: hasStartTimerIntent)
const TIMER_PATTERNS: readonly RegExp[] = [
  /\b(?:set\s+a?\s*timer|start\s+a?\s*timer|timer\s+for|countdown|alarm\s+for)\b/i,
  /\bin\s+(?:\d+|a|an|one|two|three|five|ten|fifteen|twenty|thirty|forty-five)\s+(?:second|seconds|minute|minutes|min|mins|hour|hours)\b/i,
  /\b(?:food\s+time|lunch\s+time|dinner\s+time|break\s+time|time\s+to\s+eat|oven|laundry)\b/i,
];

// Recall patterns ported directly from Cosmo's RegexGatekeepingModelV0 (head 13: hasProvideRecallIntent)
// plus natural memory queries ("what did I say two weeks ago", "where did I put", etc.)
const PROVIDE_RECALL_PATTERNS: readonly RegExp[] = [
  /\b(?:what|where|when|who|which|how)\s+(?:did\s+i|was\s+that|was\s+the|were\s+the|is\s+the|is\s+my|were\s+my)\b/i,
  /\b(?:do\s+you\s+remember|can\s+you\s+recall|recall\s+when|remember\s+when|what\s+did\s+we\s+decide)\b/i,
  /\b(?:weeks?\s+ago|days?\s+ago|yesterday|last\s+week|last\s+month|earlier\s+today)\b.*\?/i,
  /\?\s*$/,
];

// Add-to-list patterns ported from Cosmo's RegexGatekeepingModelV0 (head 1: hasAddToListIntent)
const ADD_TO_LIST_PATTERNS: readonly RegExp[] = [
  /\b(?:add|put)\s+.+\s+(?:to|on)\s+(?:my|the)\s+[\w\s-]*list\b/i,
  /\b(?:grocery|shopping|packing|reading|watch|todo|to-do|bucket)\s+list\b/i,
];

// Add-task patterns ported from Cosmo's RegexGatekeepingModelV0 (head 16: hasAddTaskIntent)
const ADD_TASK_PATTERNS: readonly RegExp[] = [
  /\b(?:add\s+task|add\s+a\s+task|new\s+task|todo|to-do)\b/i,
  /\b(?:remind\s+me\s+to|i\s+need\s+to|i\s+have\s+to|i\s+gotta|i\s+must|remember\s+to|don'?t\s+forget(?:\s+to|\s+about)?|make\s+sure(?:\s+to|\s+i)?|be\s+sure\s+to)\b/i,
  /^(?:go\s+|please\s+)?(?:make|build|fix|send|call|check|review|update|write|file|submit|pay|buy|order|pick\s+up|schedule|book|cancel|reply|email|ping|follow\s+up|finish|complete|deploy|test|verify|clean|prepare)\b/i,
];

// Event / court / meeting context patterns (Cosmo head 7: hasEventContext)
const EVENT_CONTEXT_PATTERNS: readonly RegExp[] = [
  /\b(?:court\s+case|court\s+date|hearing|filing|docket|trial|deposition|subpoena|deadline|meeting|appointment|flight|conference|interview|standup|sync|demo|presentation)\b/i,
];

// Person context patterns (Cosmo head 6: hasPersonContext)
const PERSON_CONTEXT_PATTERNS: readonly RegExp[] = [
  /\b(?:talk\s+to|speak\s+with|follow\s+up\s+with|check\s+in\s+with|ask|tell|meet\s+with|call\s+back|reply\s+to)\s+[A-Za-z]/i,
  /\b(?:his|her|their)\s+(?:number|email|address|birthday|wife|husband|partner|boss|lawyer|attorney|doctor|manager)\b/i,
];

// Create doc patterns (Cosmo head 5: hasCreateDocIntent)
const CREATE_DOC_PATTERNS: readonly RegExp[] = [
  /\b(?:create|start|write|draft)\s+(?:a\s+)?(?:doc|document|memo|spec|design\s+doc|brief|proposal|report)\b/i,
];

// Deep research patterns (Cosmo head 8: hasDeepResearchIntent)
const DEEP_RESEARCH_PATTERNS: readonly RegExp[] = [
  /\b(?:deep\s+research|research|investigate|look\s+into|dig\s+into|compare\s+options\s+for|find\s+out\s+everything\s+about)\b/i,
];

// Define term patterns (Cosmo head 2: hasTermSearchQuery)
const DEFINE_TERM_PATTERNS: readonly RegExp[] = [
  /\b(?:define|what\s+does\s+.+\s+mean|meaning\s+of|definition\s+of)\b/i,
];

// Photo / screenshot query patterns (Cosmo head 3: hasPhotoQuery)
const QUERY_PHOTOS_PATTERNS: readonly RegExp[] = [
  /\b(?:screenshot|screen\s+shot|photo|picture|image|diagram\s+on\s+screen)\b/i,
];

// Browsing / URL patterns (Cosmo head 10: hasBrowsingAgentIntent)
const BROWSING_AGENT_PATTERNS: readonly RegExp[] = [
  /\b(?:open\s+the\s+page|check\s+the\s+site|website|url|link\s+on\s+screen|repo|github\s+issue|pull\s+request)\b/i,
];

/**
 * Strips leading Whisper/keyboard punctuation, timestamps, or `[BLANK_AUDIO]` noise.
 */
function normalizeUtteranceText(raw: string): string {
  return raw
    .replace(/\[BLANK_AUDIO\]/gi, " ")
    .replace(/\[(?:MUSIC|NOISE|SILENCE|INAUDIBLE)\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractTimeExpression(text: string): string | undefined {
  for (const re of TIME_BOUND_PATTERNS) {
    const m = re.exec(text);
    if (m && m[0]) {
      return m[0].trim();
    }
  }
  return undefined;
}

export interface MatchedTriggerPrefix {
  spec: TriggerPrefixSpec;
  matchedPrefixText: string;
  bodyText: string;
}

/**
 * Checks whether an utterance (or sentence inside an audio chunk) begins with one
 * of the configured spoken trigger prefixes ("Hey Gadget", "Note to self", "Mental note",
 * "FYI", "PSA", "Remind me", "Bookmark", "Lock it in", "VIP", "ASAP", "ADR", "TBC").
 */
export function matchSpokenTriggerPrefix(rawText: string): MatchedTriggerPrefix | null {
  const cleaned = normalizeUtteranceText(rawText);
  if (!cleaned) return null;

  // Check from the start of the utterance first, then check sentence boundaries
  // in case a 3-second audio window captured a word before the trigger phrase.
  const segments = [cleaned, ...cleaned.split(/(?<=[.!?])\s+/)];

  for (const segment of segments) {
    const trimmed = segment.trim().replace(/^["'`(\[]+/, "");
    if (!trimmed) continue;

    for (const spec of SPOKEN_TRIGGER_PREFIXES) {
      const m = spec.pattern.exec(trimmed);
      if (m) {
        const matchedPrefixText = m[0].replace(/[\s,.:;\-!?]+$/, "").trim();
        let bodyText = trimmed.slice(m[0].length).trim();
        // For "Remind me ...", preserve the full "Remind me ..." phrase for downstream task/time classification
        // if the remainder is non-empty.
        if (!bodyText || bodyText.length < 2) continue;
        if (spec.id === "remind_me") {
          bodyText = trimmed;
        }
        return {
          spec,
          matchedPrefixText,
          bodyText,
        };
      }
    }
  }

  return null;
}

/**
 * Multi-head classifier modeled on Google Cosmo's 13 Conformer heads + 6 RegexGatekeepingModelV0
 * heads. Returns all matching slots in priority order, plus the primary slot.
 */
export function classifyCosmoSlots(
  bodyText: string,
  triggerSpec?: TriggerPrefixSpec,
): {
  primarySlot: CosmoSlotKind;
  allSlots: CosmoSlotKind[];
  extractedTimeText?: string;
  isTimeBoundCommitment: boolean;
} {
  const slots: CosmoSlotKind[] = [];
  const addSlot = (s: CosmoSlotKind) => {
    if (!slots.includes(s)) slots.push(s);
  };

  const extractedTimeText = extractTimeExpression(bodyText);
  const matchesAny = (patterns: readonly RegExp[]) => patterns.some((re) => re.test(bodyText));

  // 1. Check Recall intent first (e.g. "what did I say two weeks ago?", "what was that code?")
  const isQuestion = PROVIDE_RECALL_PATTERNS.some((re) => re.test(bodyText));
  if (isQuestion && !/\b(?:don'?t\s+forget|remind\s+me\s+to|make\s+sure\s+to)\b/i.test(bodyText)) {
    if (matchesAny(DEFINE_TERM_PATTERNS)) {
      addSlot("DEFINE_TERM");
    }
    addSlot("PROVIDE_RECALL");
  }

  // 2. Check Timer / Countdown / Meal-time triggers ("food time", "in 20 minutes", "set a timer")
  if (matchesAny(TIMER_PATTERNS)) {
    addSlot("ADD_TIMER");
  }

  // 3. Check Time-Bound Commitments (Calendar / Deadline slot)
  const hasTaskCue =
    matchesAny(ADD_TASK_PATTERNS) ||
    triggerSpec?.id === "remind_me" ||
    triggerSpec?.id === "asap" ||
    triggerSpec?.id === "lock_it_in" ||
    triggerSpec?.id === "tbc";

  const hasEventCue = matchesAny(EVENT_CONTEXT_PATTERNS);

  if (extractedTimeText && !slots.includes("PROVIDE_RECALL")) {
    addSlot("CREATE_CALENDAR_EVENT");
  }

  // 4. Check List intent
  if (matchesAny(ADD_TO_LIST_PATTERNS)) {
    addSlot("ADD_TO_LIST");
  }

  // 5. Check Event Context ("court case", "hearing", "meeting", "deadline")
  if (hasEventCue) {
    addSlot("PROVIDE_EVENT_CONTEXT");
  }

  // 6. Check Task / Action item ("go make me some cheeseburgers", "don't forget about your court case")
  if (hasTaskCue && !slots.includes("PROVIDE_RECALL")) {
    addSlot("ADD_TASK");
  }

  // 7. Check Person Context
  if (matchesAny(PERSON_CONTEXT_PATTERNS)) {
    addSlot("PROVIDE_PERSON_CONTEXT");
  }

  // 8. Check Create Doc / Deep Research / Photos / Browsing
  if (matchesAny(CREATE_DOC_PATTERNS)) {
    addSlot("CREATE_DOC");
  }
  if (matchesAny(DEEP_RESEARCH_PATTERNS)) {
    addSlot("DEEP_RESEARCH");
  }
  if (matchesAny(QUERY_PHOTOS_PATTERNS)) {
    addSlot("QUERY_PHOTOS");
  }
  if (matchesAny(BROWSING_AGENT_PATTERNS)) {
    addSlot("BROWSING_AGENT");
  }

  // 9. Fallback: Any explicitly triggered utterance is at minimum interesting enough for ADD_TO_MEMORY
  // (Conformer head 0: isInteresting -> add_to_memory) or ADD_TASK if imperative.
  if (slots.length === 0) {
    addSlot("ADD_TO_MEMORY");
  } else if (!slots.includes("PROVIDE_RECALL") && !slots.includes("ADD_TO_MEMORY")) {
    addSlot("ADD_TO_MEMORY");
  }

  const primarySlot = slots[0]!;
  const isTimeBoundCommitment =
    !slots.includes("PROVIDE_RECALL") &&
    (Boolean(extractedTimeText) ||
      slots.includes("CREATE_CALENDAR_EVENT") ||
      slots.includes("ADD_TIMER") ||
      hasEventCue ||
      triggerSpec?.id === "asap" ||
      triggerSpec?.id === "tbc");

  return {
    primarySlot,
    allSlots: slots,
    ...(extractedTimeText ? { extractedTimeText } : {}),
    isTimeBoundCommitment,
  };
}

function safeParseJson(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Finds the closest screen OCR snapshot (±60s) and clipboard snapshot (±120s)
 * around `timestampMs` so spoken notes like "FYI, don't forget this court case"
 * or "Note to self, reply to this email by Friday" automatically carry the visual context.
 */
export function buildContextSnapshotAt(
  timestampMs: number,
  recentEvents: readonly EpisodicEvent[],
  fallbackWorkspacePath?: string,
): SpokenSlotContextSnapshot {
  let bestScreen: EpisodicEvent | undefined;
  let bestScreenDelta = Infinity;
  let bestClipboard: EpisodicEvent | undefined;
  let bestClipDelta = Infinity;

  for (const ev of recentEvents) {
    const delta = Math.abs(ev.timestampMs - timestampMs);
    if (ev.source === "screen" && delta <= 60_000 && delta < bestScreenDelta) {
      bestScreen = ev;
      bestScreenDelta = delta;
    } else if (ev.source === "clipboard" && delta <= 120_000 && delta < bestClipDelta) {
      bestClipboard = ev;
      bestClipDelta = delta;
    }
  }

  const snapshot: SpokenSlotContextSnapshot = {};
  if (fallbackWorkspacePath) {
    snapshot.workspacePath = fallbackWorkspacePath;
  }

  if (bestScreen) {
    const meta = safeParseJson(bestScreen.metadataJson);
    snapshot.screenEventId = bestScreen.eventId;
    if (typeof meta.app === "string" && meta.app.trim()) {
      snapshot.activeApp = meta.app.trim();
    }
    if (typeof meta.windowTitle === "string" && meta.windowTitle.trim()) {
      snapshot.windowTitle = meta.windowTitle.trim();
    }
    if (!snapshot.workspacePath && bestScreen.workspacePath) {
      snapshot.workspacePath = bestScreen.workspacePath;
    }
    const cleanScreen = bestScreen.contentText.replace(/\s+/g, " ").trim();
    if (cleanScreen) {
      snapshot.screenSnippet = cleanScreen.slice(0, 280);
    }
  }

  if (bestClipboard) {
    snapshot.clipboardEventId = bestClipboard.eventId;
    const cleanClip = bestClipboard.contentText.replace(/\s+/g, " ").trim();
    if (cleanClip) {
      snapshot.clipboardSnippet = cleanClip.slice(0, 200);
    }
  }

  return snapshot;
}

/**
 * Evaluates a single `EpisodicEvent` (typically `audio`, `keyboard`, or `zsh_hook`)
 * and returns a `SpokenSlotRecord` if it begins with a configured trigger prefix.
 */
export function extractSpokenSlotFromEvent(
  event: EpisodicEvent,
  recentEvents: readonly EpisodicEvent[] = [],
): SpokenSlotRecord | null {
  if (
    event.source !== "audio" &&
    event.source !== "keyboard" &&
    event.source !== "zsh_hook" &&
    event.source !== "zsh"
  ) {
    return null;
  }

  // Strip source prefixes like "[audio transcript]" or "[keyboard input]" if present
  const rawContent = event.contentText
    .replace(/^\[(?:audio transcript|keyboard input|voice note)\]\s*/i, "")
    .trim();

  const match = matchSpokenTriggerPrefix(rawContent);
  if (!match) return null;

  const classification = classifyCosmoSlots(match.bodyText, match.spec);
  const context = buildContextSnapshotAt(event.timestampMs, recentEvents, event.workspacePath);

  const slotId = createHash("sha256")
    .update(`spoken_slot\0${event.eventId}\0${match.spec.id}\0${match.bodyText}`)
    .digest("hex")
    .slice(0, 24);

  return {
    slotId,
    eventId: event.eventId,
    source: event.source,
    timestampMs: event.timestampMs,
    triggerId: match.spec.id,
    triggerPrefix: match.spec.canonicalLabel,
    socialMode: match.spec.socialMode,
    primarySlot: classification.primarySlot,
    allSlots: classification.allSlots,
    rawText: rawContent,
    bodyText: match.bodyText,
    ...(classification.extractedTimeText ? { extractedTimeText: classification.extractedTimeText } : {}),
    isTimeBoundCommitment: classification.isTimeBoundCommitment,
    context,
    status: "ACTIVE",
  };
}

/**
 * Extracts all spoken/typed slot records from a sorted list of events.
 */
export function extractAllSpokenSlots(events: readonly EpisodicEvent[]): SpokenSlotRecord[] {
  const results: SpokenSlotRecord[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (
      ev.source !== "audio" &&
      ev.source !== "keyboard" &&
      ev.source !== "zsh_hook" &&
      ev.source !== "zsh"
    ) {
      continue;
    }
    const windowStart = Math.max(0, i - 30);
    const windowEnd = Math.min(events.length, i + 10);
    const nearby = events.slice(windowStart, windowEnd);
    const rec = extractSpokenSlotFromEvent(ev, nearby);
    if (rec) {
      results.push(rec);
    }
  }
  return results;
}
