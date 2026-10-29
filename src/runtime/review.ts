// Review Queue (AGENTS.md section 9).
// Records owner verdicts on surfacings, opens rework items that close only when replay
// and verifyClaim both pass, and proposes a one-line scoped rule for non-GOOD verdicts.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertOutsideRepo } from "../miner/paths.js";
import type { EventStore } from "../miner/store.js";
import type { Claim, ContextWindow, Hit, Verdict } from "./types.js";
import { verifyClaim, type VerifyOptions } from "./verify.js";

export interface LockedFixture {
  fixtureId: string;
  contextWindow: ContextWindow;
  surfacedHits: Hit[];
  verdict: Verdict;
  createdAtMs: number;
}

export interface ReworkItem {
  reworkId: string;
  fixtureId: string;
  verdict: Verdict;
  proposedRuleOneLine: string;
  status: "OPEN" | "CLOSED";
  openedAtMs: number;
  closedAtMs?: number;
}

export interface ReviewRecord {
  reviewId: string;
  verdict: Verdict;
  createdAtMs: number;
  fixture?: LockedFixture;
  rework?: ReworkItem;
  proposedRuleOneLine?: string;
}

// Produces a deterministic one-line scoped rule for any non-GOOD verdict (AGENTS.md section 9.3).
export function proposeScopedRule(ctx: ContextWindow, hits: Hit[], verdict: Verdict): string {
  if (verdict.kind === "GOOD") return "";
  const ws = ctx.workspacePath ?? "*";
  const src = hits[0]?.sourceUri ?? "*";
  const note = verdict.note.replace(/\s+/g, " ").trim();
  const raw = (() => {
    switch (verdict.kind) {
      case "WRONG_FACT":
        return `WHEN workspace=${ws} AND source=${src} REQUIRE verifyClaim+freshness=CURRENT (${note})`;
      case "STALE":
        return `WHEN workspace=${ws} AND source=${src} DROP hits superseded before context.endMs (${note})`;
      case "SHOULD_STAY_SILENT":
        return `WHEN workspace=${ws} SUPPRESS surfacing matching source=${src} (${note})`;
      case "MISSED":
        return `WHEN workspace=${ws} ADD trigger proposal for missed seek (${note})`;
    }
  })();
  return raw.replace(/[\r\n]+/g, " ").trim();
}

export class ReviewQueue {
  private readonly items: ReviewRecord[] = [];

  constructor(private readonly statePath: string) {
    assertOutsideRepo(statePath, "the review queue");
    if (existsSync(statePath)) {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as ReviewRecord[];
      if (Array.isArray(parsed)) this.items.push(...parsed);
    }
  }

  recordVerdict(
    ctx: ContextWindow,
    surfacedHits: Hit[],
    verdict: Verdict,
    nowMs = Date.now(),
  ): ReviewRecord {
    const reviewId = createHash("sha256")
      .update(JSON.stringify({ ctx, surfacedHits, verdict, nowMs }))
      .digest("hex")
      .slice(0, 16);

    if (verdict.kind === "GOOD") {
      const rec: ReviewRecord = { reviewId, verdict, createdAtMs: nowMs };
      this.items.push(rec);
      this.persist();
      return rec;
    }

    const fixtureId = `fixture-${reviewId}`;
    const fixture: LockedFixture = {
      fixtureId,
      contextWindow: ctx,
      surfacedHits,
      verdict,
      createdAtMs: nowMs,
    };
    const proposedRuleOneLine = proposeScopedRule(ctx, surfacedHits, verdict);
    const rework: ReworkItem = {
      reworkId: `rework-${reviewId}`,
      fixtureId,
      verdict,
      proposedRuleOneLine,
      status: "OPEN",
      openedAtMs: nowMs,
    };
    const rec: ReviewRecord = {
      reviewId,
      verdict,
      createdAtMs: nowMs,
      fixture,
      rework,
      proposedRuleOneLine,
    };
    this.items.push(rec);
    this.persist();
    return rec;
  }

  // Closes a rework item ONLY when replay of its fixture passes AND verifyClaim passes.
  closeRework(
    reworkId: string,
    opts: {
      replayPassed: boolean;
      claim: Claim;
      store: EventStore;
      verifyOpts?: VerifyOptions;
      closedAtMs?: number;
    },
  ): { closed: boolean; reason: string } {
    const rec = this.items.find((r) => r.rework?.reworkId === reworkId);
    if (!rec?.rework) {
      return { closed: false, reason: `rework item ${reworkId} not found` };
    }
    if (!opts.replayPassed) {
      return { closed: false, reason: "replay of locked fixture did not pass" };
    }
    const check = verifyClaim(opts.claim, opts.store, opts.verifyOpts);
    if (!check.passed) {
      return { closed: false, reason: `verifyClaim failed: ${check.failures.join("; ")}` };
    }
    rec.rework.status = "CLOSED";
    rec.rework.closedAtMs = opts.closedAtMs ?? Date.now();
    this.persist();
    return { closed: true, reason: "replay and verifyClaim passed" };
  }

  allRecords(): ReadonlyArray<ReviewRecord> {
    return this.items;
  }

  openReworkItems(): ReworkItem[] {
    return this.items.map((r) => r.rework).filter((rw): rw is ReworkItem => rw?.status === "OPEN");
  }

  private persist(): void {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.statePath, JSON.stringify(this.items, null, 2) + "\n", { mode: 0o600 });
    chmodSync(this.statePath, 0o600);
  }
}
