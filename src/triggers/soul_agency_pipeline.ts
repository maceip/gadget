// Ported from bryanchen3777/soul-os-harness:
// - src/agency/trigger.py
// - src/agency/trigger_handler.py
// - src/agency/inner_life_gate.py
// - src/agency/stages.py
// - src/agency/agency.py
// - src/heartbeat/engine.py
//
// Implements:
// 1. TriggerEnvelope (scheduler/router metadata) strictly separated from Perception (neutral cognitive input).
// 2. Producer-side gateProactive trace gate (EMITTED | GATED | UNAVAILABLE | FAILURE).
// 3. Per-agent isolated AgencyState.
// 4. 4-Stage Pure Agency Pipeline (checkEligibility -> makeDecision -> selectAction -> execute) with full AgencyTraceEntry audit trail.
// 5. HeartbeatEngine with TTL expiration (preventing catch-up storms after sleep) and globalSilenceSecs cooldown.

export type TriggerType = "USER_MESSAGE" | "SYSTEM_TICK" | "PROACTIVE" | "SCHEDULED";

export const TriggerPriority = {
  CRITICAL: 0,
  HIGH: 10,
  NORMAL: 20,
  LOW: 30,
} as const;

export type TriggerPriorityValue = (typeof TriggerPriority)[keyof typeof TriggerPriority] | number;

export interface TriggerEnvelope {
  triggerType: TriggerType;
  sourceId: string;
  targetAgentId: string;
  timestamp: number; // epoch seconds
  priority: TriggerPriorityValue;
  ttlSeconds: number | null;
  correlationId: string;
  payload: Record<string, unknown>;
}

// Neutral cognitive input stripped of routing, priority, TTL, and scheduler metadata.
export interface Perception {
  content: string;
  modality: string;
  timestamp: number;
  metadata: Record<string, unknown>;
}

export function envelopeToPerception(envelope: TriggerEnvelope): Perception {
  const rawContent = envelope.payload.content ?? envelope.payload.message ?? envelope.payload.task ?? "";
  const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);
  const modality = typeof envelope.payload.modality === "string" ? envelope.payload.modality : "text";
  const safeMeta: Record<string, unknown> = {};
  if (typeof envelope.payload.workspacePath === "string") {
    safeMeta.workspacePath = envelope.payload.workspacePath;
  }
  if (typeof envelope.payload.salience === "number") {
    safeMeta.salience = envelope.payload.salience;
  }
  return {
    content,
    modality,
    timestamp: envelope.timestamp,
    metadata: safeMeta,
  };
}

export type ProactiveGateStatus = "EMITTED" | "GATED" | "UNAVAILABLE" | "FAILURE";

export interface ProactiveTrace {
  status: ProactiveGateStatus;
  reason: string;
  source: string;
  timestamp: number;
  envelope: TriggerEnvelope | null;
}

// Producer-side gate (src/agency/inner_life_gate.py): gates proactive triggers before they
// reach the agency pipeline and emits an explicit audit trace.
export function gateProactive(
  envelope: TriggerEnvelope | null | undefined,
  enabled: boolean,
  nowSec = Date.now() / 1000,
): ProactiveTrace {
  if (!envelope) {
    return {
      status: "UNAVAILABLE",
      reason: "proactive producer returned null envelope",
      source: "unknown",
      timestamp: nowSec,
      envelope: null,
    };
  }
  if (envelope.triggerType !== "PROACTIVE") {
    return {
      status: "FAILURE",
      reason: `expected PROACTIVE triggerType, got ${envelope.triggerType}`,
      source: envelope.sourceId,
      timestamp: nowSec,
      envelope: null,
    };
  }
  if (!enabled) {
    return {
      status: "GATED",
      reason: "proactive emission disabled by producer gate",
      source: envelope.sourceId,
      timestamp: nowSec,
      envelope: null,
    };
  }
  return {
    status: "EMITTED",
    reason: "proactive trigger passed producer gate",
    source: envelope.sourceId,
    timestamp: nowSec,
    envelope,
  };
}

export interface AgencyState {
  agentId: string;
  silenceUntil: number; // epoch seconds
  lastTickProcessed: number; // epoch seconds
  activeTriggerCount: number;
  maxConcurrentTriggers: number;
  cooldownSecs: number;
  tickMinIntervalSecs: number;
  salienceThreshold: number;
}

export function createAgencyState(
  agentId: string,
  overrides: Partial<Omit<AgencyState, "agentId">> = {},
): AgencyState {
  return {
    agentId,
    silenceUntil: 0,
    lastTickProcessed: 0,
    activeTriggerCount: 0,
    maxConcurrentTriggers: 3,
    cooldownSecs: 60,
    tickMinIntervalSecs: 10,
    salienceThreshold: 0.5,
    ...overrides,
  };
}

export interface EligibilityResult {
  eligible: boolean;
  reason: string;
}

export type DecisionKind = "ENGAGE" | "IGNORE" | "DEFER" | "SILENCE";

export interface DecisionResult {
  decision: DecisionKind;
  reason: string;
  confidence: number;
  silenceDurationSecs?: number;
}

export type ActionType =
  | "NO_OP"
  | "DEFER"
  | "ENTER_SILENCE"
  | "PROCESS_INPUT"
  | "EMIT_PROACTIVE"
  | "RUN_MAINTENANCE";

export interface ActionSelectionResult {
  action: ActionType;
  params: Record<string, unknown>;
}

export interface StageTraceRecord {
  stage: "check_eligibility" | "make_decision" | "select_action" | "execute";
  passed: boolean;
  detail: string;
}

export interface AgencyTraceEntry {
  correlationId: string;
  agentId: string;
  triggerType: TriggerType;
  timestamp: number;
  stageResults: StageTraceRecord[];
  finalAction: ActionType;
  perception: Perception | null;
  durationMs: number;
}

// Stage 1: Pure eligibility check (concurrency, silence window, tick min interval).
export function checkEligibility(
  envelope: TriggerEnvelope,
  state: AgencyState,
  nowSec = envelope.timestamp,
): EligibilityResult {
  if (state.activeTriggerCount >= state.maxConcurrentTriggers) {
    return {
      eligible: false,
      reason: `max_concurrent_reached (${state.activeTriggerCount}/${state.maxConcurrentTriggers})`,
    };
  }
  if (
    (envelope.triggerType === "PROACTIVE" || envelope.triggerType === "SYSTEM_TICK") &&
    nowSec < state.silenceUntil
  ) {
    return {
      eligible: false,
      reason: `agent_in_silence_until_${state.silenceUntil.toFixed(1)}`,
    };
  }
  if (
    envelope.triggerType === "SYSTEM_TICK" &&
    state.lastTickProcessed > 0 &&
    nowSec - state.lastTickProcessed < state.tickMinIntervalSecs
  ) {
    return {
      eligible: false,
      reason: `tick_min_interval_not_elapsed (${(nowSec - state.lastTickProcessed).toFixed(1)}s < ${state.tickMinIntervalSecs}s)`,
    };
  }
  return { eligible: true, reason: "eligible" };
}

// Stage 2: Pure decision evaluation.
export function makeDecision(envelope: TriggerEnvelope, state: AgencyState): DecisionResult {
  if (envelope.payload.requestSilence === true) {
    const duration =
      typeof envelope.payload.silenceDurationSecs === "number"
        ? envelope.payload.silenceDurationSecs
        : state.cooldownSecs;
    return {
      decision: "SILENCE",
      reason: "explicit_silence_requested",
      confidence: 1.0,
      silenceDurationSecs: duration,
    };
  }

  switch (envelope.triggerType) {
    case "USER_MESSAGE":
      return { decision: "ENGAGE", reason: "direct_user_message", confidence: 1.0 };
    case "SCHEDULED":
      return { decision: "ENGAGE", reason: "scheduled_job_due", confidence: 0.9 };
    case "PROACTIVE": {
      const salience = typeof envelope.payload.salience === "number" ? envelope.payload.salience : 0;
      if (salience >= state.salienceThreshold) {
        return {
          decision: "ENGAGE",
          reason: `salience_above_threshold (${salience.toFixed(2)} >= ${state.salienceThreshold.toFixed(2)})`,
          confidence: salience,
        };
      }
      return {
        decision: "DEFER",
        reason: `salience_below_threshold (${salience.toFixed(2)} < ${state.salienceThreshold.toFixed(2)})`,
        confidence: salience,
      };
    }
    case "SYSTEM_TICK": {
      const pending = Array.isArray(envelope.payload.pendingTasks) ? envelope.payload.pendingTasks : [];
      if (pending.length > 0) {
        return {
          decision: "ENGAGE",
          reason: `system_tick_has_pending_tasks (${pending.length})`,
          confidence: 0.8,
        };
      }
      return {
        decision: "IGNORE",
        reason: "system_tick_no_pending_tasks",
        confidence: 1.0,
      };
    }
  }
}

// Stage 3: Pure action selection.
export function selectAction(envelope: TriggerEnvelope, decision: DecisionResult): ActionSelectionResult {
  if (decision.decision === "IGNORE") {
    return { action: "NO_OP", params: { reason: decision.reason } };
  }
  if (decision.decision === "DEFER") {
    return { action: "DEFER", params: { reason: decision.reason } };
  }
  if (decision.decision === "SILENCE") {
    return {
      action: "ENTER_SILENCE",
      params: { durationSecs: decision.silenceDurationSecs ?? 60, reason: decision.reason },
    };
  }
  // decision === "ENGAGE"
  if (envelope.triggerType === "USER_MESSAGE" || envelope.triggerType === "SCHEDULED") {
    return { action: "PROCESS_INPUT", params: { priority: envelope.priority } };
  }
  if (envelope.triggerType === "PROACTIVE") {
    return { action: "EMIT_PROACTIVE", params: { confidence: decision.confidence } };
  }
  return {
    action: "RUN_MAINTENANCE",
    params: { pendingTasks: envelope.payload.pendingTasks ?? [] },
  };
}

// Stage 4: Pure execution & state transition returning updated cloned state + trace entry.
export function runAgencyPipeline(
  envelope: TriggerEnvelope,
  state: AgencyState,
  nowSec = envelope.timestamp,
): { nextState: AgencyState; trace: AgencyTraceEntry } {
  const startedNs = process.hrtime.bigint();
  const nextState: AgencyState = { ...state };
  const stageResults: StageTraceRecord[] = [];

  // Stage 1
  const elig = checkEligibility(envelope, nextState, nowSec);
  stageResults.push({
    stage: "check_eligibility",
    passed: elig.eligible,
    detail: elig.reason,
  });

  if (!elig.eligible) {
    const durationMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
    return {
      nextState,
      trace: {
        correlationId: envelope.correlationId,
        agentId: state.agentId,
        triggerType: envelope.triggerType,
        timestamp: nowSec,
        stageResults,
        finalAction: "NO_OP",
        perception: null,
        durationMs,
      },
    };
  }

  // Stage 2
  const dec = makeDecision(envelope, nextState);
  stageResults.push({
    stage: "make_decision",
    passed: dec.decision === "ENGAGE" || dec.decision === "SILENCE",
    detail: `${dec.decision}: ${dec.reason}`,
  });

  // Stage 3
  const sel = selectAction(envelope, dec);
  stageResults.push({
    stage: "select_action",
    passed: sel.action !== "NO_OP" && sel.action !== "DEFER",
    detail: sel.action,
  });

  // Stage 4
  let perception: Perception | null = null;
  if (sel.action === "ENTER_SILENCE") {
    const dur = typeof sel.params.durationSecs === "number" ? sel.params.durationSecs : nextState.cooldownSecs;
    nextState.silenceUntil = nowSec + dur;
  } else if (sel.action === "EMIT_PROACTIVE") {
    nextState.silenceUntil = nowSec + nextState.cooldownSecs;
    perception = envelopeToPerception(envelope);
  } else if (sel.action === "PROCESS_INPUT") {
    perception = envelopeToPerception(envelope);
  } else if (sel.action === "RUN_MAINTENANCE") {
    nextState.lastTickProcessed = nowSec;
    perception = envelopeToPerception(envelope);
  } else if (envelope.triggerType === "SYSTEM_TICK") {
    nextState.lastTickProcessed = nowSec;
  }

  stageResults.push({
    stage: "execute",
    passed: true,
    detail: `executed ${sel.action}`,
  });

  const durationMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
  return {
    nextState,
    trace: {
      correlationId: envelope.correlationId,
      agentId: state.agentId,
      triggerType: envelope.triggerType,
      timestamp: nowSec,
      stageResults,
      finalAction: sel.action,
      perception,
      durationMs,
    },
  };
}

// Multi-agent TriggerHandler + HeartbeatEngine with TTL anti-storm protection and global silence.
export class SoulTriggerRouter {
  private readonly agentStates = new Map<string, AgencyState>();
  private readonly traces: AgencyTraceEntry[] = [];
  private lastGlobalTriggerSec = 0;

  constructor(private readonly globalSilenceSecs = 0) {}

  registerAgent(state: AgencyState): void {
    this.agentStates.set(state.agentId, { ...state });
  }

  getAgentState(agentId: string): AgencyState | undefined {
    const s = this.agentStates.get(agentId);
    return s ? { ...s } : undefined;
  }

  getTraces(): ReadonlyArray<AgencyTraceEntry> {
    return this.traces;
  }

  // Handles an incoming TriggerEnvelope, checking TTL expiration and global silence first.
  dispatch(
    envelope: TriggerEnvelope,
    nowSec = Date.now() / 1000,
  ): {
    accepted: boolean;
    droppedReason?: "ttl_expired" | "global_silence" | "unknown_agent";
    trace?: AgencyTraceEntry;
  } {
    // 1. TTL check (prevents thundering-herd catch-up storms after sleep)
    if (envelope.ttlSeconds !== null && envelope.ttlSeconds >= 0) {
      const ageSec = nowSec - envelope.timestamp;
      if (ageSec > envelope.ttlSeconds) {
        return { accepted: false, droppedReason: "ttl_expired" };
      }
    }

    // 2. Global silence check for non-user triggers
    if (
      envelope.triggerType !== "USER_MESSAGE" &&
      this.globalSilenceSecs > 0 &&
      this.lastGlobalTriggerSec > 0 &&
      nowSec - this.lastGlobalTriggerSec < this.globalSilenceSecs
    ) {
      return { accepted: false, droppedReason: "global_silence" };
    }

    const current = this.agentStates.get(envelope.targetAgentId);
    if (!current) {
      return { accepted: false, droppedReason: "unknown_agent" };
    }

    const { nextState, trace } = runAgencyPipeline(envelope, current, nowSec);
    this.agentStates.set(envelope.targetAgentId, nextState);
    this.traces.push(trace);

    if (trace.finalAction !== "NO_OP" && trace.finalAction !== "DEFER") {
      this.lastGlobalTriggerSec = nowSec;
    }

    return {
      accepted: trace.finalAction !== "NO_OP" && trace.finalAction !== "DEFER",
      trace,
    };
  }
}
