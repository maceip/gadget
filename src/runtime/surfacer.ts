// Surfacer (AGENTS.md section 6.2).
// Enforces novelty (not already in current context), freshness (only CURRENT hits),
// deterministic claim verification (verifyClaim), and the interruption-cost gate.

import type { EventStore } from "../miner/store.js";
import type { ContextWindow, Hit, Surfacer } from "./types.js";
import { hitToClaim, verifyClaim } from "./verify.js";

export interface SurfacerOptions {
  interruptionCost?: number;
  defaultLeadTimeWeight?: number;
  scopedSilenceRules?: ReadonlyArray<(ctx: ContextWindow, hit: Hit) => boolean>;
}

export class VerifiedSurfacer implements Surfacer {
  readonly interruptionCost: number;
  readonly defaultLeadTimeWeight: number;
  private readonly scopedSilenceRules: ReadonlyArray<(ctx: ContextWindow, hit: Hit) => boolean>;

  constructor(
    private readonly store: EventStore,
    opts: SurfacerOptions = {},
  ) {
    this.interruptionCost = opts.interruptionCost ?? 0.35;
    this.defaultLeadTimeWeight = opts.defaultLeadTimeWeight ?? 1.0;
    this.scopedSilenceRules = opts.scopedSilenceRules ?? [];
  }

  // Filters hits down to those that are novel, CURRENT, not blocked by a scoped rule,
  // and pass deterministic verifyClaim.
  filterSurfacableHits(ctx: ContextWindow, hits: Hit[]): { accepted: Hit[]; rejectedReasons: string[] } {
    const contextSet = new Set(ctx.eventIds);
    const contextTexts: string[] = [];
    const contextUris = new Set<string>();
    for (const id of ctx.eventIds) {
      const ev = this.store.getEventById(id);
      if (ev) {
        contextTexts.push(ev.contentText);
        contextUris.add(ev.sourceUri);
      }
    }

    const accepted: Hit[] = [];
    const rejectedReasons: string[] = [];
    const seenQuotes = new Set<string>();

    for (const hit of hits) {
      if (!hit.quote.trim()) {
        rejectedReasons.push("empty quote");
        continue;
      }
      if (hit.freshness !== "CURRENT" || !hit.freshnessCheck.trim()) {
        rejectedReasons.push(`freshness=${hit.freshness}`);
        continue;
      }
      if ((hit.eventId && contextSet.has(hit.eventId)) || contextUris.has(hit.sourceUri)) {
        rejectedReasons.push("already in current context window");
        continue;
      }
      if (contextTexts.some((t) => t.includes(hit.quote))) {
        rejectedReasons.push("quote already visible in context window");
        continue;
      }
      if (this.scopedSilenceRules.some((rule) => rule(ctx, hit))) {
        rejectedReasons.push("blocked by scoped silence rule");
        continue;
      }
      if (hit.eventId) {
        const { claim, freshnessByEventId } = hitToClaim(hit, this.store);
        const check = verifyClaim(claim, this.store, {
          asOfMs: ctx.endMs,
          freshnessByEventId,
        });
        if (!check.passed) {
          rejectedReasons.push(`verifyClaim failed: ${check.failures.join("; ")}`);
          continue;
        }
      }
      const dedupeKey = `${hit.sourceUri}::${hit.quote}`;
      if (seenQuotes.has(dedupeKey)) continue;
      seenQuotes.add(dedupeKey);
      accepted.push(hit);
    }

    return { accepted, rejectedReasons };
  }

  decide(ctx: ContextWindow, hits: Hit[]): { action: "SURFACE" | "HOLD" | "SILENT"; reason: string } {
    if (hits.length === 0) {
      return { action: "SILENT", reason: "no candidate hits" };
    }
    const { accepted, rejectedReasons } = this.filterSurfacableHits(ctx, hits);
    if (accepted.length === 0) {
      return {
        action: "SILENT",
        reason: `0 hits passed novelty/freshness/verification (${rejectedReasons.slice(0, 3).join(", ")})`,
      };
    }

    // value = relevance x novelty x lead_time - interruption_cost
    const relevance = Math.min(1, 0.7 + 0.1 * Math.min(accepted.length, 3));
    const novelty = 1.0;
    const leadTime = this.defaultLeadTimeWeight;
    const value = relevance * novelty * leadTime - this.interruptionCost;

    if (value <= 0) {
      return {
        action: "HOLD",
        reason: `value ${value.toFixed(2)} <= 0 (interruptionCost=${this.interruptionCost})`,
      };
    }

    return {
      action: "SURFACE",
      reason: `surfaced ${accepted.length} verified CURRENT hit(s), value=${value.toFixed(2)}`,
    };
  }
}
