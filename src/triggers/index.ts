export * from "./prosophor_active_manager.js";
export * from "./dsh_self_trigger.js";
export * from "./soul_agency_pipeline.js";
export * from "./memoir_saliency_guard.js";
export * from "./desktop_activity_commitments.js";
export * from "./governed_loop_cadence.js";
export * from "./tgl_proactmem_eval.js";

import type { EventStore } from "../miner/store.js";
import { FtsEventsSearcher } from "../runtime/searchers.js";
import { VerifiedSurfacer } from "../runtime/surfacer.js";
import type { ContextWindow, Hit } from "../runtime/types.js";
import { hitToClaim, verifyClaim } from "../runtime/verify.js";
import {
  detectCrossAppShuttle,
  detectInFlightCommitments,
  type RawActivityEvent,
} from "./desktop_activity_commitments.js";
import { verifyEntitiesAgainstSources } from "./memoir_saliency_guard.js";
import { TemporalEventEntityGraph } from "./tgl_proactmem_eval.js";

export interface UnifiedProactiveResult {
  triggered: boolean;
  triggerSources: string[];
  proposedQueries: string[];
  verifiedHits: Hit[];
  entityFaithfulness: number;
}

// End-to-end proactive pipeline combining general-life commitment detection,
// cross-app shuttle detection, and TGL temporal event-entity routing over EventStore,
// strictly gated by VerifiedSurfacer, verifyClaim, and MemoirAI entity verification.
export async function evaluateUnifiedProactiveWindow(params: {
  store: EventStore;
  ctx: ContextWindow;
  liveText?: string;
  activityEvents?: ReadonlyArray<RawActivityEvent>;
}): Promise<UnifiedProactiveResult> {
  const { store, ctx, liveText = "", activityEvents = [] } = params;
  const triggerSources: string[] = [];
  const proposedQueries: string[] = [];
  const addQuery = (q: string) => {
    const clean = q.trim();
    if (clean.length >= 3 && !proposedQueries.includes(clean)) {
      proposedQueries.push(clean);
    }
  };

  // 1. In-flight commitment & numbered-list detector (ProMemAgent / MineContext / ideation.md)
  const commitments = detectInFlightCommitments(liveText);
  if (commitments.length > 0) {
    triggerSources.push("in_flight_commitment");
    for (const c of commitments) {
      addQuery(c.prefetchQuery);
    }
  }

  // 2. Cross-app shuttle oscillation detector (ProactiveAgent / TGL)
  const shuttle = detectCrossAppShuttle(activityEvents);
  if (shuttle?.triggered) {
    triggerSources.push(`cross_app_shuttle(${shuttle.appA}<->${shuttle.appB})`);
    for (const ent of shuttle.extractedEntities) {
      addQuery(ent);
    }
  }

  // 3. TGL Temporal Event-Entity Graph router strictly before ctx.endMs
  const allHistorical = store
    .allEventsSorted()
    .filter((e) => e.timestampMs <= ctx.endMs)
    .map((e) => store.getEventById(e.eventId)!)
    .filter(Boolean);
  const tgl = new TemporalEventEntityGraph(allHistorical, ctx.endMs);
  const tglPred = tgl.predictAndRoute(ctx.eventIds);
  if (tglPred.shouldTrigger) {
    triggerSources.push("tgl_entity_router");
    for (const r of tglPred.routedEntities.slice(0, 3)) {
      addQuery(r.value);
    }
  }

  if (proposedQueries.length === 0) {
    return {
      triggered: false,
      triggerSources,
      proposedQueries: [],
      verifiedHits: [],
      entityFaithfulness: 1.0,
    };
  }

  // 4. Search EventStore strictly before ctx.endMs and verify with VerifiedSurfacer + verifyClaim + HallucinationGuard
  const searcher = new FtsEventsSearcher(store, ctx.workspacePath);
  const candidateHits: Hit[] = [];
  for (const q of proposedQueries) {
    const hits = await searcher.search(q, ctx.endMs);
    candidateHits.push(...hits);
  }

  const surfacer = new VerifiedSurfacer(store);
  const decision = surfacer.decide(ctx, candidateHits);
  if (decision.action !== "SURFACE") {
    return {
      triggered: false,
      triggerSources,
      proposedQueries,
      verifiedHits: [],
      entityFaithfulness: 1.0,
    };
  }

  const { accepted } = surfacer.filterSurfacableHits(ctx, candidateHits);
  const sourceTexts: string[] = [];
  const strictlyVerified: Hit[] = [];

  for (const hit of accepted) {
    if (hit.eventId) {
      const ev = store.getEventById(hit.eventId);
      if (!ev) continue;
      const { claim, freshnessByEventId } = hitToClaim(hit, store);
      const check = verifyClaim(claim, store, { asOfMs: ctx.endMs, freshnessByEventId });
      if (!check.passed) continue;
      sourceTexts.push(ev.contentText);
      strictlyVerified.push(hit);
    }
  }

  const combinedQuotes = strictlyVerified.map((h) => h.quote).join("\n");
  const entityGuard = verifyEntitiesAgainstSources(combinedQuotes, sourceTexts);

  return {
    triggered: strictlyVerified.length > 0 && entityGuard.passed,
    triggerSources,
    proposedQueries,
    verifiedHits: entityGuard.passed ? strictlyVerified : [],
    entityFaithfulness: entityGuard.faithfulnessScore,
  };
}
