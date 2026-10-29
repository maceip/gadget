// Ported from erty3244/dsh-self-trigger:
// - lib/rules.js
// - lib/index.js
//
// Pure rule engine and state tracker for autonomous self-triggers with:
// 1. Active time window (supporting both daytime 09:00..23:00 and overnight 22:00..06:00).
// 2. Minimum user idle duration (minIdleMs).
// 3. Daily trigger cap (dailyMax) with automatic date rollover.
// 4. Consecutive unanswered outreach circuit breaker (silenceStop).
// 5. Linear miss-ramp probability p = min(1, max(0, (consecutiveCheckFails * failStepPct) / 100)).
// 6. Judge deferral (shouldDeferJudge) when user is not idle, a run is in-flight, or a cycle recently finished.
// 7. Human-only activity tracking that ignores ":selftrigger-" and ":sched-" session keys.

export function parseHm(str: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || "").trim());
  if (!m) throw new Error(`Invalid HH:MM time: ${str}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) {
    throw new Error(`Out-of-range HH:MM time: ${str}`);
  }
  return { h, m: min };
}

export function inActiveWindow(nowDate: Date, fromStr: string, toStr: string): boolean {
  const from = parseHm(fromStr);
  const to = parseHm(toStr);
  const cur = nowDate.getHours() * 60 + nowDate.getMinutes();
  const a = from.h * 60 + from.m;
  const b = to.h * 60 + to.m;
  if (a <= b) return cur >= a && cur <= b;
  // Overnight wrap-around window (e.g. 22:00 -> 06:00)
  return cur >= a || cur <= b;
}

export interface DecideSelfTriggerInput {
  nowDate: Date;
  activeFrom: string;
  activeTo: string;
  idleMs: number;
  minIdleMs: number;
  consecutiveCheckFails: number;
  failStepPct?: number;
  dailyCount: number;
  dailyMax: number;
  consecutiveSilences: number;
  silenceStop: number;
  rand?: number;
}

export type SelfTriggerRejectReason =
  | "outside_active_hours"
  | "recently_active"
  | "daily_cap"
  | "silence_stop"
  | "prob_miss";

export type DecideSelfTriggerResult =
  | { ok: true; reason: "prob_pass"; p: number }
  | { ok: false; reason: SelfTriggerRejectReason; p?: number };

export function decideSelfTrigger({
  nowDate,
  activeFrom,
  activeTo,
  idleMs,
  minIdleMs,
  consecutiveCheckFails,
  failStepPct = 20,
  dailyCount,
  dailyMax,
  consecutiveSilences,
  silenceStop,
  rand = Math.random(),
}: DecideSelfTriggerInput): DecideSelfTriggerResult {
  if (!inActiveWindow(nowDate, activeFrom, activeTo)) {
    return { ok: false, reason: "outside_active_hours" };
  }
  if (idleMs < minIdleMs) {
    return { ok: false, reason: "recently_active" };
  }
  if (dailyCount >= dailyMax) {
    return { ok: false, reason: "daily_cap" };
  }
  if (consecutiveSilences >= silenceStop) {
    return { ok: false, reason: "silence_stop" };
  }

  const p = Math.min(1, Math.max(0, (consecutiveCheckFails * failStepPct) / 100));
  if (rand < p) {
    return { ok: true, reason: "prob_pass", p };
  }
  return { ok: false, reason: "prob_miss", p };
}

export interface DeferJudgeInput {
  idleOk: boolean;
  inFlight: boolean;
  hasRecentDone: boolean;
}

export type DeferJudgeResult =
  | { defer: true; reason: "not_idle" | "in_flight" | "recent_cycle_done" }
  | { defer: false; reason: "ready" };

export function shouldDeferJudge({ idleOk, inFlight, hasRecentDone }: DeferJudgeInput): DeferJudgeResult {
  if (!idleOk) return { defer: true, reason: "not_idle" };
  if (inFlight) return { defer: true, reason: "in_flight" };
  if (hasRecentDone) return { defer: true, reason: "recent_cycle_done" };
  return { defer: false, reason: "ready" };
}

export interface ActionMixWeights {
  [actionName: string]: number;
}

export function pickWeightedAction(weights: ActionMixWeights, rand = Math.random()): string {
  const entries = Object.entries(weights).filter(([, w]) => Number.isFinite(w) && w > 0);
  if (entries.length === 0) return "share";
  const total = entries.reduce((acc, [, w]) => acc + w, 0);
  let cursor = Math.max(0, Math.min(0.999999, rand)) * total;
  for (const [name, w] of entries) {
    if (cursor < w) return name;
    cursor -= w;
  }
  return entries.at(-1)![0];
}

export function enforceMaxCharsBudget(text: string, maxChars = 650): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export interface SelfTriggerPolicyConfig {
  activeFrom: string;
  activeTo: string;
  idleMinutes: number;
  failStepPct: number;
  dailyMax: number;
  silenceStop: number;
  recentDoneCooldownMs: number;
  maxChars: number;
  actionMix: ActionMixWeights;
}

export const DEFAULT_SELF_TRIGGER_CONFIG: SelfTriggerPolicyConfig = {
  activeFrom: "09:00",
  activeTo: "23:00",
  idleMinutes: 30,
  failStepPct: 20,
  dailyMax: 6,
  silenceStop: 2,
  recentDoneCooldownMs: 10 * 60 * 1000,
  maxChars: 650,
  actionMix: {
    share: 40,
    reflect: 25,
    explore: 20,
    care: 15,
  },
};

function formatDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isSyntheticSessionKey(sessionKey: string): boolean {
  const k = String(sessionKey || "");
  return k.includes(":selftrigger-") || k.includes(":sched-");
}

export class SelfTriggerStateTracker {
  readonly cfg: SelfTriggerPolicyConfig;
  lastHumanActivityAtMs: number;
  consecutiveCheckFails = 0;
  consecutiveSilences = 0;
  awaitingHumanReplySinceTrigger = false;
  dailyDateKey: string;
  dailyCount = 0;
  inFlight = false;
  lastCycleDoneAtMs: number | null = null;

  constructor(cfg: Partial<SelfTriggerPolicyConfig> = {}, initialNowMs = Date.now()) {
    this.cfg = { ...DEFAULT_SELF_TRIGGER_CONFIG, ...cfg };
    this.lastHumanActivityAtMs = initialNowMs;
    this.dailyDateKey = formatDateKey(new Date(initialNowMs));
  }

  // Records an event on a session key. Self-trigger and scheduled background sessions
  // are ignored so the agent never resets its own user-idle timer.
  recordActivity(sessionKey: string, nowMs = Date.now()): boolean {
    if (isSyntheticSessionKey(sessionKey)) {
      return false;
    }
    this.lastHumanActivityAtMs = nowMs;
    this.consecutiveCheckFails = 0;
    this.consecutiveSilences = 0;
    this.awaitingHumanReplySinceTrigger = false;
    return true;
  }

  private syncDailyCounter(nowDate: Date): void {
    const key = formatDateKey(nowDate);
    if (key !== this.dailyDateKey) {
      this.dailyDateKey = key;
      this.dailyCount = 0;
    }
  }

  // Evaluates one check tick and updates consecutiveCheckFails / consecutiveSilences / dailyCount.
  evaluateTick(
    nowMs = Date.now(),
    rand = Math.random(),
    actionRand = Math.random(),
  ): {
    triggered: boolean;
    decision: DecideSelfTriggerResult;
    deferral?: DeferJudgeResult;
    selectedAction?: string;
    sessionKey?: string;
  } {
    const nowDate = new Date(nowMs);
    this.syncDailyCounter(nowDate);

    // If a previous self-trigger went out and the human still hasn't replied, count it as a silence
    // before evaluating the next candidate outreach.
    const effectiveSilences =
      this.consecutiveSilences + (this.awaitingHumanReplySinceTrigger ? 1 : 0);

    const idleMs = Math.max(0, nowMs - this.lastHumanActivityAtMs);
    const minIdleMs = this.cfg.idleMinutes * 60 * 1000;

    const deferral = shouldDeferJudge({
      idleOk: idleMs >= minIdleMs,
      inFlight: this.inFlight,
      hasRecentDone:
        this.lastCycleDoneAtMs !== null &&
        nowMs - this.lastCycleDoneAtMs < this.cfg.recentDoneCooldownMs,
    });

    const decision = decideSelfTrigger({
      nowDate,
      activeFrom: this.cfg.activeFrom,
      activeTo: this.cfg.activeTo,
      idleMs,
      minIdleMs,
      consecutiveCheckFails: this.consecutiveCheckFails,
      failStepPct: this.cfg.failStepPct,
      dailyCount: this.dailyCount,
      dailyMax: this.cfg.dailyMax,
      consecutiveSilences: effectiveSilences,
      silenceStop: this.cfg.silenceStop,
      rand,
    });

    if (!decision.ok) {
      // Only increment consecutiveCheckFails when the user IS idle and inside active hours
      // and not blocked by caps/silence, i.e., when we missed on probability.
      if (decision.reason === "prob_miss") {
        this.consecutiveCheckFails++;
      }
      return { triggered: false, decision, deferral };
    }

    if (deferral.defer) {
      return { triggered: false, decision, deferral };
    }

    // Trigger fires!
    if (this.awaitingHumanReplySinceTrigger) {
      this.consecutiveSilences++;
    }
    this.awaitingHumanReplySinceTrigger = true;
    this.consecutiveCheckFails = 0;
    this.dailyCount++;
    this.lastCycleDoneAtMs = nowMs;

    const selectedAction = pickWeightedAction(this.cfg.actionMix, actionRand);
    const sessionKey = `agent:main:selftrigger-${nowMs}`;

    return {
      triggered: true,
      decision,
      deferral,
      selectedAction,
      sessionKey,
    };
  }
}
