// Deterministic claim verification (AGENTS.md section 7).
// Anything surfaced or written to the brief must pass verifyClaim. No LLM in this path.

import type { EventStore } from "../miner/store.js";
import type { Claim, Evidence, Hit } from "./types.js";

const STOPWORD_PROPER = new Set([
  "The", "This", "That", "These", "Those", "When", "Where", "What", "Why", "How",
  "If", "In", "On", "At", "For", "To", "From", "With", "By", "And", "But", "Or",
  "Note", "Warning", "Error", "Source", "Recall", "Monday", "Tuesday", "Wednesday",
  "Thursday", "Friday", "Saturday", "Sunday",
]);

function extractStructuredEntities(text: string): string[] {
  const entities = new Set<string>();
  for (const m of text.match(/--[a-zA-Z0-9][a-zA-Z0-9_=-]*/g) ?? []) entities.add(m);
  for (const m of text.matchAll(/["`']([^"`'\r\n]{3,80})["`']/g)) {
    if (m[1]) entities.add(m[1].trim());
  }
  for (const m of text.match(/(?:https?:\/\/[^\s)"'`]+|(?:\/|src\/|test\/|lib\/)[a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)/g) ?? []) {
    entities.add(m);
  }
  for (const m of text.match(/\b[A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*\b/g) ?? []) {
    if (!STOPWORD_PROPER.has(m) && m.length >= 3) entities.add(m);
  }
  for (const m of text.match(/(?:\$\d[\d,.]*|\b\d{4}-\d{2}-\d{2}\b|\b\d+(?:\.\d+)?%)/g) ?? []) {
    entities.add(m);
  }
  return [...entities];
}

function verifyEntitiesAgainstSources(
  generatedText: string,
  sourceTexts: ReadonlyArray<string>,
): { passed: boolean; hallucinatedEntities: string[] } {
  const extractedEntities = extractStructuredEntities(generatedText);
  if (extractedEntities.length === 0) return { passed: true, hallucinatedEntities: [] };
  const combinedLower = sourceTexts.join("\n").toLowerCase();
  const hallucinatedEntities = extractedEntities.filter((e) => !combinedLower.includes(e.toLowerCase()));
  return { passed: hallucinatedEntities.length === 0, hallucinatedEntities };
}

const CODE_OR_STATE_PATTERN =
  /`[^`]+`|--[a-z0-9_-]+|\b(src\/|test\/|lib\/|[a-z0-9_-]+\.(ts|js|mjs|py|rs|go|swift|sh|json|toml|yaml|yml))\b|\b(commit|branch|HEAD|flag|config|env|port)\b/i;

export interface VerifyOptions {
  asOfMs?: number;
  freshnessByEventId?: ReadonlyMap<string, { freshness: "CURRENT" | "SUPERSEDED" | "UNKNOWN"; freshnessCheck: string }>;
}

export function verifyClaim(
  c: Claim,
  store: EventStore,
  opts: VerifyOptions = {},
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  const asOfMs = opts.asOfMs ?? Date.now();

  if (!c.text || !c.text.trim()) {
    failures.push("claim text is empty");
  }
  if (!Array.isArray(c.evidence) || c.evidence.length === 0) {
    failures.push("evidence is empty; cannot be surfaced");
    return { passed: false, failures };
  }

  const sourceTexts: string[] = [];
  for (let i = 0; i < c.evidence.length; i++) {
    const ev: Evidence = c.evidence[i]!;
    if (!ev.sourceEventId) {
      failures.push(`evidence[${i}]: missing sourceEventId`);
      continue;
    }
    const sourceEvent = store.getEventById(ev.sourceEventId);
    if (!sourceEvent) {
      failures.push(`evidence[${i}]: source event ${ev.sourceEventId} does not exist`);
      continue;
    }
    sourceTexts.push(sourceEvent.contentText);
    if (!(sourceEvent.timestampMs < asOfMs)) {
      failures.push(
        `evidence[${i}]: source event ${ev.sourceEventId} (${sourceEvent.timestampMs}) is not strictly older than surfacing time (${asOfMs})`,
      );
    }
    if (
      typeof ev.charStart !== "number" ||
      typeof ev.charEnd !== "number" ||
      !Number.isInteger(ev.charStart) ||
      !Number.isInteger(ev.charEnd) ||
      ev.charStart < 0 ||
      ev.charEnd <= ev.charStart ||
      ev.charEnd > sourceEvent.contentText.length
    ) {
      failures.push(
        `evidence[${i}]: invalid span [${ev.charStart}, ${ev.charEnd}) for content length ${sourceEvent.contentText.length}`,
      );
      continue;
    }
    const actualSlice = sourceEvent.contentText.slice(ev.charStart, ev.charEnd);
    if (ev.quote !== actualSlice) {
      failures.push(
        `evidence[${i}]: quote mismatch against sourceEvent ${ev.sourceEventId} at [${ev.charStart}, ${ev.charEnd})`,
      );
    }

    const needsFreshness =
      sourceEvent.source === "git" ||
      sourceEvent.source === "zsh" ||
      sourceEvent.source === "zsh_hook" ||
      CODE_OR_STATE_PATTERN.test(c.text) ||
      CODE_OR_STATE_PATTERN.test(ev.quote);

    if (needsFreshness) {
      const f = opts.freshnessByEventId?.get(ev.sourceEventId);
      if (!f || !f.freshnessCheck.trim()) {
        failures.push(`evidence[${i}]: missing freshness check for code or state claim (${ev.sourceEventId})`);
      } else if (f.freshness !== "CURRENT") {
        failures.push(`evidence[${i}]: freshness is ${f.freshness}, expected CURRENT (${f.freshnessCheck})`);
      }
    }
  }

  if (failures.length === 0 && sourceTexts.length > 0) {
    const entityCheck = verifyEntitiesAgainstSources(c.text, sourceTexts);
    if (!entityCheck.passed) {
      failures.push(`unverified entities in claim: ${entityCheck.hallucinatedEntities.join(", ")}`);
    }
  }

  return { passed: failures.length === 0, failures };
}

// Builds a verifiable Claim from a Hit backed by an EventStore event.
export function hitToClaim(hit: Hit, store: EventStore): {
  claim: Claim;
  freshnessByEventId: Map<string, { freshness: "CURRENT" | "SUPERSEDED" | "UNKNOWN"; freshnessCheck: string }>;
} {
  const freshnessByEventId = new Map<
    string,
    { freshness: "CURRENT" | "SUPERSEDED" | "UNKNOWN"; freshnessCheck: string }
  >();
  if (!hit.eventId || !hit.quote) {
    return { claim: { text: hit.quote, evidence: [] }, freshnessByEventId };
  }
  const ev = store.getEventById(hit.eventId);
  if (!ev) {
    return { claim: { text: hit.quote, evidence: [] }, freshnessByEventId };
  }
  let charStart = hit.charStart;
  let charEnd = hit.charEnd;
  if (charStart === undefined || charEnd === undefined) {
    const idx = ev.contentText.indexOf(hit.quote);
    if (idx >= 0) {
      charStart = idx;
      charEnd = idx + hit.quote.length;
    } else {
      charStart = -1;
      charEnd = -1;
    }
  }
  freshnessByEventId.set(hit.eventId, {
    freshness: hit.freshness,
    freshnessCheck: hit.freshnessCheck,
  });
  return {
    claim: {
      text: hit.quote,
      evidence: [
        {
          sourceEventId: hit.eventId,
          quote: hit.quote,
          charStart,
          charEnd,
        },
      ],
    },
    freshnessByEventId,
  };
}
