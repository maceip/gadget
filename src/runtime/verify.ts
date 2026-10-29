// Deterministic claim verification (AGENTS.md section 7).
// Anything surfaced or written to the brief must pass verifyClaim. No LLM in this path.

import type { EventStore } from "../miner/store.js";
import { verifyEntitiesAgainstSources } from "../triggers/memoir_saliency_guard.js";
import type { Claim, Evidence, Hit } from "./types.js";

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
