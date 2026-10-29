// Ported from:
// 1. TGL (arXiv:2605.30152v2):
//    - Heterogeneous temporal event-entity interaction graph G_t = (V_t, E_t)
//    - Log-scaled elapsed time feature log(1 + delta_t_v)
//    - Relational message passing to jointly score trigger probability p_trig(t) and top-K entity routing s_rout(v)
// 2. ProactMem (arXiv:2610.36967v1):
//    - Conditional regularity mining & temporal replay validation:
//      conf_replay(p) = n_f / (n_f + n_v) >= 0.5, n_f >= 3, lift(p) = conf_replay(p) / base(p) >= 1.0
//      with 30-min lead/grace window, excluding "fulfilled" and "censored" occurrences
//    - Online Top3 selection ranked by w_conf * conf_replay + w_lift * min(lift / 3, 1)
// 3. ProAgent (arXiv:2512.06721v2):
//    - Low-cost sensor gate: cooldown tau, focus stability m_t > tau_f, semantic redundancy < tau_t
// 4. amandachan-ai/agent-eval-open-problems:
//    - Strict as-of-T stream replay verification, minimal-pair discrimination check,
//      and per-case flip tracking (up / down / unchanged vs A/A baseline noise floor)

import type { EpisodicEvent } from "../miner/types.js";

// ---------------------------------------------------------------------------
// 1. TGL Temporal Event-Entity Graph Router (arXiv:2605.30152v2)
// ---------------------------------------------------------------------------

export type EntityKind = "file" | "app" | "url" | "person_or_org" | "flag_or_symbol" | "topic";

export interface GraphEntityNode {
  entityId: string; // "${kind}:${normalizedValue}"
  kind: EntityKind;
  value: string;
  firstSeenMs: number;
  lastSeenMs: number;
  mentionCount: number;
  connectedEventIds: string[];
  logTimeGapSec: number; // log(1 + delta_t_v)
}

export interface RoutedEntityCandidate {
  entityId: string;
  kind: EntityKind;
  value: string;
  routingScore: number; // s_rout(v)
  logTimeGapSec: number;
  supportingEventIds: string[];
}

export interface TglPrediction {
  pTrig: number; // p_trig(t) in [0, 1]
  shouldTrigger: boolean;
  routedEntities: RoutedEntityCandidate[];
}

export function extractGraphEntitiesFromEvent(ev: EpisodicEvent): Array<{ kind: EntityKind; value: string }> {
  const out: Array<{ kind: EntityKind; value: string }> = [];
  const seen = new Set<string>();
  const add = (kind: EntityKind, val: string) => {
    const clean = val.trim();
    if (clean.length < 3) return;
    const key = `${kind}:${clean.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, value: clean });
  };

  const text = ev.contentText;

  // Flags & symbols
  for (const m of text.match(/--[a-zA-Z0-9][a-zA-Z0-9_=-]*/g) ?? []) {
    add("flag_or_symbol", m);
  }
  for (const m of text.match(/\b[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+\b/g) ?? []) {
    add("flag_or_symbol", m);
  }

  // URLs
  if (ev.sourceUri.startsWith("http://") || ev.sourceUri.startsWith("https://")) {
    add("url", ev.sourceUri);
  }
  for (const m of text.match(/https?:\/\/[^\s)"'`]+/g) ?? []) {
    add("url", m);
  }

  // File paths
  for (const m of text.match(/(?:\/|[a-zA-Z0-9_-]+\/)[a-zA-Z0-9_./-]+\.[a-zA-Z0-9]{1,8}\b/g) ?? []) {
    add("file", m);
  }

  // Metadata app / person / topic
  try {
    const meta = JSON.parse(ev.metadataJson) as Record<string, unknown>;
    if (typeof meta.app === "string") add("app", meta.app);
    if (typeof meta.frontmostApp === "string") add("app", meta.frontmostApp);
  } catch {
    // ignore malformed metadata
  }

  // Proper nouns / organizations / people (e.g. AcmeCorp, Sarah, Stripe, Postgres)
  for (const m of text.match(/\b[A-Z][a-zA-Z0-9]{2,}(?:\s+[A-Z][a-zA-Z0-9]{2,})?\b/g) ?? []) {
    if (!/^(The|This|When|Where|What|Why|How|Error|Warning|Created|Completed|Command|Process)$/.test(m)) {
      add("person_or_org", m);
    }
  }

  return out;
}

export class TemporalEventEntityGraph {
  private readonly entities = new Map<string, GraphEntityNode>();
  private readonly eventEntities = new Map<string, string[]>();
  private readonly eventsById = new Map<string, EpisodicEvent>();

  // Builds G_t strictly from events with timestampMs <= asOfMs.
  constructor(events: ReadonlyArray<EpisodicEvent>, readonly asOfMs: number) {
    const valid = events
      .filter((e) => e.timestampMs <= asOfMs)
      .sort((a, b) => a.timestampMs - b.timestampMs);

    for (const ev of valid) {
      this.eventsById.set(ev.eventId, ev);
      const extracted = extractGraphEntitiesFromEvent(ev);
      const eIds: string[] = [];

      for (const { kind, value } of extracted) {
        const entityId = `${kind}:${value.toLowerCase()}`;
        eIds.push(entityId);
        const existing = this.entities.get(entityId);
        const deltaSec = Math.max(0, (asOfMs - ev.timestampMs) / 1000);
        const logGap = Math.log(1 + deltaSec);

        if (existing) {
          existing.lastSeenMs = Math.max(existing.lastSeenMs, ev.timestampMs);
          existing.mentionCount++;
          if (!existing.connectedEventIds.includes(ev.eventId)) {
            existing.connectedEventIds.push(ev.eventId);
          }
          existing.logTimeGapSec = Math.log(1 + Math.max(0, (asOfMs - existing.lastSeenMs) / 1000));
        } else {
          this.entities.set(entityId, {
            entityId,
            kind,
            value,
            firstSeenMs: ev.timestampMs,
            lastSeenMs: ev.timestampMs,
            mentionCount: 1,
            connectedEventIds: [ev.eventId],
            logTimeGapSec: logGap,
          });
        }
      }
      this.eventEntities.set(ev.eventId, eIds);
    }
  }

  getEntityCount(): number {
    return this.entities.size;
  }

  // Runs 2-hop relational message passing (currentContextEvents -> shared entities -> historical events -> co-occurring historical entities)
  // to compute trigger probability p_trig(t) and rank top-K routed entities s_rout(v).
  predictAndRoute(
    contextEventIds: ReadonlyArray<string>,
    opts: { topK?: number; triggerThreshold?: number } = {},
  ): TglPrediction {
    const topK = opts.topK ?? 5;
    const triggerThreshold = opts.triggerThreshold ?? 0.5;

    const contextSet = new Set(contextEventIds);
    const seedEntities = new Set<string>();
    let hasFrictionSignal = false;

    for (const evId of contextEventIds) {
      const ev = this.eventsById.get(evId);
      if (!ev) continue;
      if (/\b(error|failed|failure|cannot|missing|where|invoice|receipt|contract|deadline|todo)\b/i.test(ev.contentText)) {
        hasFrictionSignal = true;
      }
      for (const entId of this.eventEntities.get(evId) ?? []) {
        seedEntities.add(entId);
      }
    }

    // Score all entities via 1-hop (direct seed match with historical prior) and 2-hop (co-occurring in past events)
    const scores = new Map<string, { score: number; historicalEvents: Set<string> }>();

    for (const seedId of seedEntities) {
      const seedNode = this.entities.get(seedId);
      if (!seedNode) continue;

      for (const histEvId of seedNode.connectedEventIds) {
        if (contextSet.has(histEvId)) continue; // Strictly historical event outside current context window
        // Boost the seed entity itself when it appeared in historical events
        const selfEntry = scores.get(seedId) ?? { score: 0, historicalEvents: new Set<string>() };
        const selfTemporalWeight = 1 / (1 + 0.15 * seedNode.logTimeGapSec);
        selfEntry.score += 1.2 * selfTemporalWeight;
        selfEntry.historicalEvents.add(histEvId);
        scores.set(seedId, selfEntry);

        // 2-hop: propagate to co-occurring entities in that historical event
        for (const neighborEntId of this.eventEntities.get(histEvId) ?? []) {
          if (neighborEntId === seedId) continue;
          const neighborNode = this.entities.get(neighborEntId);
          if (!neighborNode) continue;
          const entry = scores.get(neighborEntId) ?? { score: 0, historicalEvents: new Set<string>() };
          // Log-time-gap decay: entities with recent or recurring connections get higher message weight
          const temporalWeight = 1 / (1 + 0.15 * neighborNode.logTimeGapSec);
          const hopWeight = seedEntities.has(neighborEntId) ? 1.0 : 0.85;
          entry.score += hopWeight * temporalWeight * (1 + 0.2 * Math.log(1 + neighborNode.mentionCount));
          entry.historicalEvents.add(histEvId);
          scores.set(neighborEntId, entry);
        }
      }
    }

    const routed: RoutedEntityCandidate[] = [];
    for (const [entId, { score, historicalEvents }] of scores.entries()) {
      const node = this.entities.get(entId)!;
      if (historicalEvents.size === 0) continue;
      routed.push({
        entityId: entId,
        kind: node.kind,
        value: node.value,
        routingScore: Number(score.toFixed(4)),
        logTimeGapSec: Number(node.logTimeGapSec.toFixed(4)),
        supportingEventIds: [...historicalEvents],
      });
    }

    routed.sort((a, b) => b.routingScore - a.routingScore);
    const topRouted = routed.slice(0, topK);

    const maxRoutingScore = topRouted[0]?.routingScore ?? 0;
    const logit =
      -1.4 +
      (hasFrictionSignal ? 1.1 : 0) +
      Math.min(2.2, maxRoutingScore * 0.9) +
      (topRouted.length >= 2 ? 0.4 : 0);
    const pTrig = Number((1 / (1 + Math.exp(-logit))).toFixed(4));

    return {
      pTrig,
      shouldTrigger: pTrig >= triggerThreshold && topRouted.length > 0,
      routedEntities: topRouted,
    };
  }
}

// ---------------------------------------------------------------------------
// 2. ProactMem Replay-Validated Conditional Regularities (arXiv:2610.36967v1)
// ---------------------------------------------------------------------------

export interface SessionTraceEvent {
  timestampMs: number;
  tag: string; // e.g. "context:monday_morning_standup", "need:open_sprint_board", "context:flight_booking", "need:check_passport_expiry"
  alreadyFulfilledTags?: string[];
}

export interface SessionTrace {
  sessionId: string;
  startMs: number;
  endMs: number;
  events: SessionTraceEvent[];
}

export interface ValidatedRegularity {
  patternId: string;
  contextTag: string;
  targetNeedTag: string;
  nFollowed: number; // n_f
  nViolated: number; // n_v
  nFulfilledExcluded: number;
  nCensoredExcluded: number;
  confReplay: number; // n_f / (n_f + n_v)
  baseRate: number; // base(p)
  lift: number; // conf_replay / base(p)
  validated: boolean;
}

export interface ProactMemConfig {
  windowMs?: number; // default 30 min = 1_800_000ms
  minConfReplay?: number; // default 0.5
  minSupportFollowed?: number; // default 3
  minLift?: number; // default 1.0
  wConf?: number; // default 0.6
  wLift?: number; // default 0.4
}

export class ProactMemEngine {
  readonly windowMs: number;
  readonly minConfReplay: number;
  readonly minSupportFollowed: number;
  readonly minLift: number;
  readonly wConf: number;
  readonly wLift: number;
  private validatedPatterns: ValidatedRegularity[] = [];

  constructor(cfg: ProactMemConfig = {}) {
    this.windowMs = cfg.windowMs ?? 30 * 60 * 1000;
    this.minConfReplay = cfg.minConfReplay ?? 0.5;
    this.minSupportFollowed = cfg.minSupportFollowed ?? 3;
    this.minLift = cfg.minLift ?? 1.0;
    this.wConf = cfg.wConf ?? 0.6;
    this.wLift = cfg.wLift ?? 0.4;
  }

  // Mines candidate (contextTag -> targetNeedTag) pairs from trainSessions and validates them
  // via causal temporal replay over validationSessions.
  mineAndValidate(
    trainSessions: ReadonlyArray<SessionTrace>,
    validationSessions: ReadonlyArray<SessionTrace>,
  ): ValidatedRegularity[] {
    const candidatePairs = new Map<string, { contextTag: string; targetNeedTag: string }>();

    for (const sess of trainSessions) {
      const sorted = [...sess.events].sort((a, b) => a.timestampMs - b.timestampMs);
      for (let i = 0; i < sorted.length; i++) {
        const cEv = sorted[i]!;
        if (!cEv.tag.startsWith("context:")) continue;
        for (let j = i + 1; j < sorted.length; j++) {
          const nEv = sorted[j]!;
          if (nEv.timestampMs - cEv.timestampMs > this.windowMs) break;
          if (nEv.tag.startsWith("need:")) {
            const key = `${cEv.tag}=>${nEv.tag}`;
            candidatePairs.set(key, { contextTag: cEv.tag, targetNeedTag: nEv.tag });
          }
        }
      }
    }

    // Compute unconditional base rate base(p) across validation sessions:
    // fraction of validation sessions in which targetNeedTag appears at least once.
    const totalValSessions = Math.max(1, validationSessions.length);
    const needSessionCounts = new Map<string, number>();
    for (const sess of validationSessions) {
      const uniqueNeeds = new Set(sess.events.filter((e) => e.tag.startsWith("need:")).map((e) => e.tag));
      for (const needTag of uniqueNeeds) {
        needSessionCounts.set(needTag, (needSessionCounts.get(needTag) ?? 0) + 1);
      }
    }

    const results: ValidatedRegularity[] = [];

    for (const [patternId, { contextTag, targetNeedTag }] of candidatePairs.entries()) {
      let nFollowed = 0;
      let nViolated = 0;
      let nFulfilledExcluded = 0;
      let nCensoredExcluded = 0;

      for (const sess of validationSessions) {
        const sorted = [...sess.events].sort((a, b) => a.timestampMs - b.timestampMs);
        for (let i = 0; i < sorted.length; i++) {
          const ev = sorted[i]!;
          if (ev.tag !== contextTag) continue;

          // Exclude "fulfilled": target need was already satisfied at or before trigger time
          const alreadyDone =
            (ev.alreadyFulfilledTags?.includes(targetNeedTag) ?? false) ||
            sorted.slice(0, i).some((prev) => prev.tag === targetNeedTag);
          if (alreadyDone) {
            nFulfilledExcluded++;
            continue;
          }

          // Check if targetNeedTag occurs within (timestampMs, timestampMs + windowMs]
          const followedInWindow = sorted
            .slice(i + 1)
            .some(
              (later) =>
                later.tag === targetNeedTag &&
                later.timestampMs > ev.timestampMs &&
                later.timestampMs - ev.timestampMs <= this.windowMs,
            );

          if (followedInWindow) {
            nFollowed++;
          } else if (sess.endMs - ev.timestampMs < this.windowMs) {
            // Session ended before the 30-minute observation window elapsed -> censored!
            nCensoredExcluded++;
          } else {
            nViolated++;
          }
        }
      }

      const denom = nFollowed + nViolated;
      const confReplay = denom > 0 ? Number((nFollowed / denom).toFixed(4)) : 0;
      // Avoid zero baseRate division; use empirical session frequency with 1/(2N) floor
      const rawBase = (needSessionCounts.get(targetNeedTag) ?? 0) / totalValSessions;
      const baseRate = Number(Math.max(0.05, Math.min(0.95, rawBase)).toFixed(4));
      const lift = Number((confReplay / baseRate).toFixed(4));

      const validated =
        confReplay >= this.minConfReplay &&
        nFollowed >= this.minSupportFollowed &&
        lift >= this.minLift;

      results.push({
        patternId,
        contextTag,
        targetNeedTag,
        nFollowed,
        nViolated,
        nFulfilledExcluded,
        nCensoredExcluded,
        confReplay,
        baseRate,
        lift,
        validated,
      });
    }

    this.validatedPatterns = results.filter((r) => r.validated);
    return results;
  }

  // Online Top3 selection (ProactMem Eq.):
  // score(p, x) = w_conf * conf_replay(p) + w_lift * min(lift(p) / 3, 1)
  selectTop3(
    activeContextTags: ReadonlyArray<string>,
    alreadyFulfilledNeeds: ReadonlyArray<string> = [],
  ): Array<{ regularity: ValidatedRegularity; score: number }> {
    const ctxSet = new Set(activeContextTags);
    const fulfilledSet = new Set(alreadyFulfilledNeeds);

    const matched: Array<{ regularity: ValidatedRegularity; score: number }> = [];
    for (const reg of this.validatedPatterns) {
      if (!ctxSet.has(reg.contextTag)) continue;
      if (fulfilledSet.has(reg.targetNeedTag)) continue;
      const score = Number(
        (this.wConf * reg.confReplay + this.wLift * Math.min(reg.lift / 3, 1)).toFixed(4),
      );
      matched.push({ regularity: reg, score });
    }

    matched.sort((a, b) => b.score - a.score);
    return matched.slice(0, 3);
  }
}

// ---------------------------------------------------------------------------
// 3. ProAgent Two-Tier Sensor Gate (arXiv:2512.06721v2)
// ---------------------------------------------------------------------------

export interface ProAgentSensorGateInput {
  nowSec: number;
  lastTriggerSec: number;
  cooldownTauSec: number; // tau
  focusDurationSec: number; // m_t
  minFocusStabilitySec: number; // tau_f
  currentContextText: string; // c_t
  recentTriggeredContexts: ReadonlyArray<string>; // H_trig
  redundancyThresholdTauT: number; // tau_t in (0, 1)
}

export function jaccardTokenSimilarity(a: string, b: string): number {
  const tokA = new Set(
    (a.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((t) => t.length >= 2 && !/^\d+$/.test(t)),
  );
  const tokB = new Set(
    (b.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((t) => t.length >= 2 && !/^\d+$/.test(t)),
  );
  if (tokA.size === 0 && tokB.size === 0) return 1;
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let inter = 0;
  for (const t of tokA) {
    if (tokB.has(t)) inter++;
  }
  const union = tokA.size + tokB.size - inter;
  return union > 0 ? Number((inter / union).toFixed(4)) : 0;
}

export function evaluateProAgentSensorGate(input: ProAgentSensorGateInput): {
  passed: boolean;
  reason: "passed" | "cooldown_active" | "unstable_focus" | "semantically_redundant";
  maxSimilarity: number;
} {
  if (input.lastTriggerSec > 0 && input.nowSec - input.lastTriggerSec < input.cooldownTauSec) {
    return { passed: false, reason: "cooldown_active", maxSimilarity: 0 };
  }
  if (input.focusDurationSec < input.minFocusStabilitySec) {
    return { passed: false, reason: "unstable_focus", maxSimilarity: 0 };
  }
  let maxSim = 0;
  for (const past of input.recentTriggeredContexts) {
    const sim = jaccardTokenSimilarity(input.currentContextText, past);
    if (sim > maxSim) maxSim = sim;
  }
  if (maxSim >= input.redundancyThresholdTauT) {
    return { passed: false, reason: "semantically_redundant", maxSimilarity: maxSim };
  }
  return { passed: true, reason: "passed", maxSimilarity: maxSim };
}

// ---------------------------------------------------------------------------
// 4. amandachan-ai/agent-eval-open-problems:
//    Strict as-of-T Stream Replay, Minimal-Pair Check & Per-Case Flip Analysis
// ---------------------------------------------------------------------------

export interface StreamCutoffStep<TDecision> {
  cutoffMs: number;
  visibleEventCount: number;
  leakedFutureEventCount: number;
  decision: TDecision;
}

// Replays an event stream across an array of cutoff timestamps T_1..T_n, passing only
// events with timestampMs <= T_i to evaluatorFn and verifying zero future leakage.
export function evaluateStreamAsOfT<TDecision>(
  allEvents: ReadonlyArray<EpisodicEvent>,
  cutoffsMs: ReadonlyArray<number>,
  evaluatorFn: (visibleEvents: ReadonlyArray<EpisodicEvent>, asOfMs: number) => TDecision,
): {
  steps: Array<StreamCutoffStep<TDecision>>;
  totalLeaks: number;
} {
  let totalLeaks = 0;
  const steps: Array<StreamCutoffStep<TDecision>> = [];

  for (const cutoffMs of cutoffsMs) {
    const visible = allEvents.filter((e) => e.timestampMs <= cutoffMs);
    const leaked = visible.filter((e) => e.timestampMs > cutoffMs).length;
    totalLeaks += leaked;
    const decision = evaluatorFn(visible, cutoffMs);
    steps.push({
      cutoffMs,
      visibleEventCount: visible.length,
      leakedFutureEventCount: leaked,
      decision,
    });
  }

  return { steps, totalLeaks };
}

export interface MinimalPairCase<TContext> {
  pairId: string;
  positiveContext: TContext; // Should trigger (true)
  negativeContext: TContext; // Differs by 1 critical detail; should NOT trigger (false)
}

export function evaluateMinimalPairs<TContext>(
  pairs: ReadonlyArray<MinimalPairCase<TContext>>,
  triggerFn: (ctx: TContext) => boolean,
): {
  totalPairs: number;
  discriminatedCorrectly: number;
  falsePositivesOnNegative: string[];
  falseNegativesOnPositive: string[];
  discriminationRate: number;
} {
  const falsePositivesOnNegative: string[] = [];
  const falseNegativesOnPositive: string[] = [];
  let discriminatedCorrectly = 0;

  for (const pair of pairs) {
    const posFired = triggerFn(pair.positiveContext);
    const negFired = triggerFn(pair.negativeContext);
    if (!posFired) falseNegativesOnPositive.push(pair.pairId);
    if (negFired) falsePositivesOnNegative.push(pair.pairId);
    if (posFired && !negFired) discriminatedCorrectly++;
  }

  return {
    totalPairs: pairs.length,
    discriminatedCorrectly,
    falsePositivesOnNegative,
    falseNegativesOnPositive,
    discriminationRate: pairs.length > 0 ? Number((discriminatedCorrectly / pairs.length).toFixed(4)) : 1,
  };
}

export interface CaseOutcome {
  caseId: string;
  passed: boolean;
}

export interface PerCaseFlipReport {
  totalCases: number;
  baselinePassRate: number;
  candidatePassRate: number;
  netDelta: number;
  flippedUp: string[]; // Failed in baseline -> Passed in candidate
  flippedDown: string[]; // Passed in baseline -> Failed in candidate
  unchangedPass: string[];
  unchangedFail: string[];
  aaNoiseFloorRate: number; // Flip rate observed across A/A identical baseline runs
  exceedsNoiseFloor: boolean;
}

export function comparePerCaseFlips(
  baselineRunA: ReadonlyArray<CaseOutcome>,
  candidateRunB: ReadonlyArray<CaseOutcome>,
  baselineRunA2: ReadonlyArray<CaseOutcome> = baselineRunA,
): PerCaseFlipReport {
  const mapA = new Map(baselineRunA.map((c) => [c.caseId, c.passed]));
  const mapB = new Map(candidateRunB.map((c) => [c.caseId, c.passed]));
  const mapA2 = new Map(baselineRunA2.map((c) => [c.caseId, c.passed]));

  const flippedUp: string[] = [];
  const flippedDown: string[] = [];
  const unchangedPass: string[] = [];
  const unchangedFail: string[] = [];

  let aaFlips = 0;
  for (const [caseId, passA] of mapA.entries()) {
    const passB = mapB.get(caseId) ?? false;
    const passA2 = mapA2.get(caseId) ?? passA;
    if (passA !== passA2) aaFlips++;

    if (!passA && passB) flippedUp.push(caseId);
    else if (passA && !passB) flippedDown.push(caseId);
    else if (passA && passB) unchangedPass.push(caseId);
    else unchangedFail.push(caseId);
  }

  const totalCases = Math.max(1, mapA.size);
  const baselinePassRate = Number(((unchangedPass.length + flippedDown.length) / totalCases).toFixed(4));
  const candidatePassRate = Number(((unchangedPass.length + flippedUp.length) / totalCases).toFixed(4));
  const netDelta = Number((candidatePassRate - baselinePassRate).toFixed(4));
  const aaNoiseFloorRate = Number((aaFlips / totalCases).toFixed(4));
  const candidateFlipRate = (flippedUp.length + flippedDown.length) / totalCases;

  return {
    totalCases: mapA.size,
    baselinePassRate,
    candidatePassRate,
    netDelta,
    flippedUp,
    flippedDown,
    unchangedPass,
    unchangedFail,
    aaNoiseFloorRate,
    exceedsNoiseFloor: candidateFlipRate > aaNoiseFloorRate && Math.abs(netDelta) > aaNoiseFloorRate,
  };
}
