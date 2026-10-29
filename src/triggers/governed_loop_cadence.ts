// Ported from:
// 1. AFK-surf/Comma:
//    - Deterministic state-predicate watcher ("Loop") that runs at zero LLM token cost
//      and wakes the agent only when a concrete state transition predicate fires.
// 2. refixai/proactivity-sdk:
//    - Standing Goals + living Scratchpad diffing + Adaptive Wake Cadence (min..max backoff
//      when quiet, tightening when active) + idempotent governed() action envelope with audit trail.
// 3. openclaw/openclaw & CopilotKit/OpenDuet:
//    - Monitor constraints (activeHours, idleOnly, persistent scratch, and NO_REPLY suppression).
// 4. ideation.md Rule 1:
//    - Permission policy per (actionKind, target): ALLOW_ONCE | ALWAYS_ALLOW | REFUSE.

import { createHash } from "node:crypto";
import { inActiveWindow } from "./dsh_self_trigger.js";

// ---------------------------------------------------------------------------
// 1. AFK-surf/Comma Deterministic State-Predicate Loop
// ---------------------------------------------------------------------------

export interface LoopPredicateResult<TPayload> {
  wake: boolean;
  reason: string;
  payload?: TPayload;
}

export class DeterministicLoop<TState, TPayload = Record<string, unknown>> {
  private lastState: TState | undefined;
  private evaluations = 0;
  private wakeCount = 0;

  constructor(
    readonly id: string,
    private readonly readState: () => TState,
    private readonly predicate: (prev: TState | undefined, curr: TState) => LoopPredicateResult<TPayload>,
  ) {}

  poll(): LoopPredicateResult<TPayload> & { evaluations: number; wakeCount: number } {
    this.evaluations++;
    const curr = this.readState();
    const res = this.predicate(this.lastState, curr);
    this.lastState = structuredClone(curr);
    if (res.wake) {
      this.wakeCount++;
    }
    return {
      ...res,
      evaluations: this.evaluations,
      wakeCount: this.wakeCount,
    };
  }
}

// ---------------------------------------------------------------------------
// 2. refixai/proactivity-sdk + openclaw Standing Goals, Scratchpad Diff & Adaptive Cadence
// ---------------------------------------------------------------------------

export interface StandingGoal {
  id: string;
  description: string;
  priority: "low" | "normal" | "high" | "critical";
  active: boolean;
}

export interface CadenceConfig {
  minMs: number; // e.g. 15_000 (15s)
  maxMs: number; // e.g. 900_000 (15m)
  backoffFactor?: number; // default 2.0
  tightenFactor?: number; // default 0.5
  activeHours?: { from: string; to: string };
  idleOnly?: boolean;
  minUserIdleMs?: number;
}

export interface ScratchpadDiff {
  changed: boolean;
  addedKeys: string[];
  updatedKeys: string[];
  removedKeys: string[];
  digest: string;
}

export function computeScratchpadDiff(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): ScratchpadDiff {
  const addedKeys: string[] = [];
  const updatedKeys: string[] = [];
  const removedKeys: string[] = [];

  const prevKeys = new Set(Object.keys(prev));
  const nextKeys = new Set(Object.keys(next));

  for (const k of nextKeys) {
    if (!prevKeys.has(k)) {
      addedKeys.push(k);
    } else if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) {
      updatedKeys.push(k);
    }
  }
  for (const k of prevKeys) {
    if (!nextKeys.has(k)) {
      removedKeys.push(k);
    }
  }

  addedKeys.sort();
  updatedKeys.sort();
  removedKeys.sort();

  const sortedEntries = [...nextKeys].sort().map((k) => [k, next[k]]);
  const digest = createHash("sha256").update(JSON.stringify(sortedEntries)).digest("hex").slice(0, 16);

  return {
    changed: addedKeys.length > 0 || updatedKeys.length > 0 || removedKeys.length > 0,
    addedKeys,
    updatedKeys,
    removedKeys,
    digest,
  };
}

// Computes the next wake interval in [minMs, maxMs]:
// - If scratchpad changed or high-urgency goal fired, tightens toward minMs.
// - If NO_REPLY / no state diff, backs off toward maxMs.
export function computeAdaptiveCadenceMs(
  currentIntervalMs: number,
  cfg: CadenceConfig,
  tickOutcome: { stateChanged: boolean; urgent: boolean; replied: boolean },
): number {
  const minMs = Math.max(100, cfg.minMs);
  const maxMs = Math.max(minMs, cfg.maxMs);
  const backoff = cfg.backoffFactor ?? 2.0;
  const tighten = cfg.tightenFactor ?? 0.5;

  if (tickOutcome.urgent) {
    return minMs;
  }
  if (tickOutcome.stateChanged || tickOutcome.replied) {
    return Math.max(minMs, Math.min(maxMs, Math.round(currentIntervalMs * tighten)));
  }
  return Math.max(minMs, Math.min(maxMs, Math.round(currentIntervalMs * backoff)));
}

export interface MonitorTickInput {
  nowMs: number;
  userIdleMs: number;
  nextScratchpad: Record<string, unknown>;
  candidateReply: string | "NO_REPLY";
  urgent?: boolean;
}

export interface MonitorTickResult {
  action: "SURFACE" | "NO_REPLY";
  reason:
    | "outside_active_hours"
    | "user_not_idle"
    | "no_active_goals"
    | "explicit_no_reply"
    | "scratchpad_unchanged"
    | "duplicate_reply_suppressed"
    | "surfaced";
  diff: ScratchpadDiff;
  nextIntervalMs: number;
  surfacedText?: string;
}

export class ProactiveMonitorRuntime {
  private scratchpad: Record<string, unknown> = {};
  private lastSurfacedDigest = "";
  private currentIntervalMs: number;
  private readonly goals = new Map<string, StandingGoal>();

  constructor(private readonly cfg: CadenceConfig, initialGoals: StandingGoal[] = []) {
    this.currentIntervalMs = cfg.minMs;
    for (const g of initialGoals) {
      this.goals.set(g.id, { ...g });
    }
  }

  upsertGoal(goal: StandingGoal): void {
    this.goals.set(goal.id, { ...goal });
  }

  getScratchpad(): Record<string, unknown> {
    return structuredClone(this.scratchpad);
  }

  getCurrentIntervalMs(): number {
    return this.currentIntervalMs;
  }

  evaluateMonitorTick(input: MonitorTickInput): MonitorTickResult {
    const diff = computeScratchpadDiff(this.scratchpad, input.nextScratchpad);
    this.scratchpad = structuredClone(input.nextScratchpad);

    if (this.cfg.activeHours) {
      const inside = inActiveWindow(
        new Date(input.nowMs),
        this.cfg.activeHours.from,
        this.cfg.activeHours.to,
      );
      if (!inside) {
        this.currentIntervalMs = computeAdaptiveCadenceMs(this.currentIntervalMs, this.cfg, {
          stateChanged: false,
          urgent: false,
          replied: false,
        });
        return { action: "NO_REPLY", reason: "outside_active_hours", diff, nextIntervalMs: this.currentIntervalMs };
      }
    }

    if (this.cfg.idleOnly && input.userIdleMs < (this.cfg.minUserIdleMs ?? 60_000)) {
      this.currentIntervalMs = computeAdaptiveCadenceMs(this.currentIntervalMs, this.cfg, {
        stateChanged: false,
        urgent: false,
        replied: false,
      });
      return { action: "NO_REPLY", reason: "user_not_idle", diff, nextIntervalMs: this.currentIntervalMs };
    }

    const activeGoals = [...this.goals.values()].filter((g) => g.active);
    if (activeGoals.length === 0) {
      this.currentIntervalMs = computeAdaptiveCadenceMs(this.currentIntervalMs, this.cfg, {
        stateChanged: false,
        urgent: false,
        replied: false,
      });
      return { action: "NO_REPLY", reason: "no_active_goals", diff, nextIntervalMs: this.currentIntervalMs };
    }

    const trimmed = input.candidateReply.trim();
    if (!trimmed || trimmed === "NO_REPLY") {
      this.currentIntervalMs = computeAdaptiveCadenceMs(this.currentIntervalMs, this.cfg, {
        stateChanged: diff.changed,
        urgent: Boolean(input.urgent),
        replied: false,
      });
      return { action: "NO_REPLY", reason: "explicit_no_reply", diff, nextIntervalMs: this.currentIntervalMs };
    }

    if (!diff.changed && !input.urgent) {
      this.currentIntervalMs = computeAdaptiveCadenceMs(this.currentIntervalMs, this.cfg, {
        stateChanged: false,
        urgent: false,
        replied: false,
      });
      return { action: "NO_REPLY", reason: "scratchpad_unchanged", diff, nextIntervalMs: this.currentIntervalMs };
    }

    const replyDigest = createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
    if (replyDigest === this.lastSurfacedDigest) {
      this.currentIntervalMs = computeAdaptiveCadenceMs(this.currentIntervalMs, this.cfg, {
        stateChanged: false,
        urgent: false,
        replied: false,
      });
      return {
        action: "NO_REPLY",
        reason: "duplicate_reply_suppressed",
        diff,
        nextIntervalMs: this.currentIntervalMs,
      };
    }

    this.lastSurfacedDigest = replyDigest;
    this.currentIntervalMs = computeAdaptiveCadenceMs(this.currentIntervalMs, this.cfg, {
      stateChanged: true,
      urgent: Boolean(input.urgent),
      replied: true,
    });

    return {
      action: "SURFACE",
      reason: "surfaced",
      diff,
      nextIntervalMs: this.currentIntervalMs,
      surfacedText: trimmed,
    };
  }
}

// ---------------------------------------------------------------------------
// 3. Idempotent governed() Action Envelope + Permission Policy (ideation.md Rule 1)
// ---------------------------------------------------------------------------

export type PermissionPolicyMode = "ALLOW_ONCE" | "ALWAYS_ALLOW" | "REFUSE";

export interface GovernedAuditEntry<TResult = unknown> {
  idempotencyKey: string;
  actionKind: string;
  target: string;
  timestampMs: number;
  status: "EXECUTED" | "DEDUPLICATED" | "REFUSED_BY_POLICY" | "NEEDS_PERMISSION";
  policyApplied: PermissionPolicyMode | "UNSET";
  result?: TResult;
}

export class GovernedActionLedger {
  private readonly permissions = new Map<string, PermissionPolicyMode>();
  private readonly executedByKey = new Map<string, unknown>();
  private readonly auditTrail: GovernedAuditEntry[] = [];

  private permKey(actionKind: string, target: string): string {
    return `${actionKind}::${target}`;
  }

  setPermission(actionKind: string, target: string, mode: PermissionPolicyMode): void {
    this.permissions.set(this.permKey(actionKind, target), mode);
  }

  getPermission(actionKind: string, target: string): PermissionPolicyMode | "UNSET" {
    return this.permissions.get(this.permKey(actionKind, target)) ?? "UNSET";
  }

  getAuditTrail(): ReadonlyArray<GovernedAuditEntry> {
    return this.auditTrail;
  }

  // Executes fn at most once per idempotencyKey and enforces (actionKind, target) permissions.
  // ALLOW_ONCE consumes the permission after 1 execution and reverts to UNSET.
  governed<TResult>(params: {
    idempotencyKey: string;
    actionKind: string;
    target: string;
    nowMs?: number;
    execute: () => TResult;
  }): GovernedAuditEntry<TResult> {
    const nowMs = params.nowMs ?? Date.now();
    const policy = this.getPermission(params.actionKind, params.target);

    if (this.executedByKey.has(params.idempotencyKey)) {
      const cached = this.executedByKey.get(params.idempotencyKey) as TResult;
      const entry: GovernedAuditEntry<TResult> = {
        idempotencyKey: params.idempotencyKey,
        actionKind: params.actionKind,
        target: params.target,
        timestampMs: nowMs,
        status: "DEDUPLICATED",
        policyApplied: policy,
        result: cached,
      };
      this.auditTrail.push(entry);
      return entry;
    }

    if (policy === "REFUSE") {
      const entry: GovernedAuditEntry<TResult> = {
        idempotencyKey: params.idempotencyKey,
        actionKind: params.actionKind,
        target: params.target,
        timestampMs: nowMs,
        status: "REFUSED_BY_POLICY",
        policyApplied: "REFUSE",
      };
      this.auditTrail.push(entry);
      return entry;
    }

    if (policy === "UNSET") {
      const entry: GovernedAuditEntry<TResult> = {
        idempotencyKey: params.idempotencyKey,
        actionKind: params.actionKind,
        target: params.target,
        timestampMs: nowMs,
        status: "NEEDS_PERMISSION",
        policyApplied: "UNSET",
      };
      this.auditTrail.push(entry);
      return entry;
    }

    // ALLOW_ONCE or ALWAYS_ALLOW
    if (policy === "ALLOW_ONCE") {
      this.permissions.delete(this.permKey(params.actionKind, params.target));
    }

    const result = params.execute();
    this.executedByKey.set(params.idempotencyKey, result);
    const entry: GovernedAuditEntry<TResult> = {
      idempotencyKey: params.idempotencyKey,
      actionKind: params.actionKind,
      target: params.target,
      timestampMs: nowMs,
      status: "EXECUTED",
      policyApplied: policy,
      result,
    };
    this.auditTrail.push(entry);
    return entry;
  }
}
