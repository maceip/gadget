import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/miner/config.js";
import { buildEpisodes } from "../src/miner/episodes.js";
import { makeEvent } from "../src/miner/event.js";
import { withSeeks } from "../src/miner/seek.js";
import { EventStore } from "../src/miner/store.js";
import { CalibratedAnticipator } from "../src/runtime/anticipator.js";
import { hitMatchesEpisode } from "../src/runtime/replay.js";
import { FtsEventsSearcher } from "../src/runtime/searchers.js";
import { VerifiedSurfacer } from "../src/runtime/surfacer.js";
import type { Hit } from "../src/runtime/types.js";
import {
  ActiveTriggerManager,
  comparePerCaseFlips,
  computeAdaptiveCadenceMs,
  computeBurstinessScore,
  computeMemoirImportance,
  computeMemoirRecency,
  computeScratchpadDiff,
  computeTurnDecayedSaliency,
  consolidateActivityStream,
  createAgencyState,
  decideSelfTrigger,
  detectCrossAppShuttle,
  detectInFlightCommitments,
  DeterministicLoop,
  enforceMaxCharsBudget,
  envelopeToPerception,
  evaluateIntrinsicMotivation,
  evaluateMinimalPairs,
  evaluateProAgentSensorGate,
  evaluateStreamAsOfT,
  evaluateUnifiedProactiveWindow,
  fileOrganizerProbe,
  filterVisibleViewportElements,
  gateProactive,
  GovernedActionLedger,
  inActiveWindow,
  OpenChronicleEventDispatcher,
  parseTriggerModeCfg,
  pickWeightedAction,
  ProactiveMonitorRuntime,
  ProactMemEngine,
  runExecutableProbe,
  SelfTriggerStateTracker,
  SemanticMemoryStore,
  shouldDeferJudge,
  shouldTriggerInlineCompletion,
  skillCreatorProbe,
  SoulTriggerRouter,
  TemporalEventEntityGraph,
  TriggerPriority,
  verifyEntitiesAgainstSources,
} from "../src/triggers/index.js";
import { DAY, MIN, T0, tmp } from "./helpers.js";

test("1. Swair/prosophor: trigger_mode.cfg parser, 3-state Idle/IdleOnce/Periodic manager, priority order, real executable probe, file_organizer & skill_creator probes", () => {
  const root = tmp();

  // 1a. Real file_organizer probe on a real directory
  const downloadsDir = join(root, "Downloads");
  mkdirSync(downloadsDir, { recursive: true });
  writeFileSync(join(downloadsDir, ".DS_Store"), "hidden");
  for (let i = 1; i <= 10; i++) {
    writeFileSync(join(downloadsDir, `invoice_${i}.pdf`), `PDF content ${i}`);
  }
  // At 10 non-hidden files (<= threshold 10), probe stays silent (exit code 1)
  assert.equal(fileOrganizerProbe(downloadsDir, 10).exitCode, 1);

  // Add 11th item -> exceeds threshold 10 -> triggers (exit code 0) with structured JSON
  writeFileSync(join(downloadsDir, "receipt_11.txt"), "Receipt 11");
  const orgRes = fileOrganizerProbe(downloadsDir, 10);
  assert.equal(orgRes.exitCode, 0);
  const orgPayload = JSON.parse(orgRes.stdout) as { totalCount: number; fileCount: number; byExtension: Record<string, number> };
  assert.equal(orgPayload.totalCount, 11);
  assert.equal(orgPayload.fileCount, 11);
  assert.equal(orgPayload.byExtension[".pdf"], 10);
  assert.equal(orgPayload.byExtension[".txt"], 1);

  // 1b. Real skill_creator probe on a consolidated history directory with .last_check persistence
  const historyDir = join(root, "history");
  mkdirSync(historyDir, { recursive: true });
  const lastCheckFile = join(historyDir, ".last_check");
  const workflowFile = join(historyDir, "2026-10-28_expense_reimbursement.md");
  writeFileSync(
    workflowFile,
    [
      "1. Export monthly statement CSV from bank portal",
      "2. Filter rows where category == Travel or Meals",
      "3. Match each row against PDF receipts in ~/Downloads",
      "4. Upload combined bundle to reimbursement portal",
    ].join("\n"),
  );
  const skillRes1 = skillCreatorProbe(historyDir, lastCheckFile, Date.now() + 5000);
  assert.equal(skillRes1.exitCode, 0);
  const skillPayload = JSON.parse(skillRes1.stdout) as { newFilesCount: number };
  assert.equal(skillPayload.newFilesCount, 1);

  // Running skillCreatorProbe again without newer file modifications stays silent (exit code 1)
  const skillRes2 = skillCreatorProbe(historyDir, lastCheckFile, Date.now() + 10000);
  assert.equal(skillRes2.exitCode, 1);

  // 1c. Real OS executable script probe + ActiveTriggerManager state machine (periodic, idle, idle_once)
  const pluginsRoot = join(root, "active_plugins");
  const pIdleOnceDir = join(pluginsRoot, "organizer_once");
  const pIdleRepeatDir = join(pluginsRoot, "idle_repeater");
  const pPeriodicDir = join(pluginsRoot, "periodic_high_pri");
  mkdirSync(pIdleOnceDir, { recursive: true });
  mkdirSync(pIdleRepeatDir, { recursive: true });
  mkdirSync(pPeriodicDir, { recursive: true });

  writeFileSync(
    join(pIdleOnceDir, "trigger_mode.cfg"),
    "mode = idle_once\nidle_seconds = 120\ntimeout_seconds = 5\npriority = 20\nenabled = true\nentry_point = trigger.mjs\n",
  );
  writeFileSync(
    join(pIdleOnceDir, "trigger.mjs"),
    `import { fileOrganizerProbe } from ${JSON.stringify(join(process.cwd(), "dist/src/triggers/prosophor_active_manager.js"))};\n` +
      `const r = fileOrganizerProbe(${JSON.stringify(downloadsDir)}, 10);\n` +
      `if (r.stdout) process.stdout.write(r.stdout);\n` +
      `process.exit(r.exitCode);\n`,
  );
  chmodSync(join(pIdleOnceDir, "trigger.mjs"), 0o755);

  writeFileSync(
    join(pIdleRepeatDir, "trigger_mode.cfg"),
    "mode = idle\nidle_seconds = 120\ntimeout_seconds = 5\npriority = 30\nenabled = true\n",
  );
  writeFileSync(
    join(pPeriodicDir, "trigger_mode.cfg"),
    "mode = periodic\ninterval_seconds = 60\ntimeout_seconds = 5\npriority = 5\nenabled = true\n",
  );

  // Verify real OS process execution via runExecutableProbe
  const cfgOnce = parseTriggerModeCfg(
    readFileSync(join(pIdleOnceDir, "trigger_mode.cfg"), "utf8"),
    "organizer_once",
    pIdleOnceDir,
  );
  const execRes = runExecutableProbe(cfgOnce);
  assert.equal(execRes.exitCode, 0);
  assert.match(execRes.stdout, /"trigger":"file_organizer"/);

  const mgr = new ActiveTriggerManager();
  mgr.registerPlugin(cfgOnce); // uses real runExecutableProbe!
  mgr.registerPlugin(
    parseTriggerModeCfg(readFileSync(join(pIdleRepeatDir, "trigger_mode.cfg"), "utf8"), "idle_repeater", pIdleRepeatDir),
    () => ({ exitCode: 0, stdout: JSON.stringify({ msg: "idle_repeat_fired" }) }),
    T0,
  );
  mgr.registerPlugin(
    parseTriggerModeCfg(readFileSync(join(pPeriodicDir, "trigger_mode.cfg"), "utf8"), "periodic_high_pri", pPeriodicDir),
    () => ({ exitCode: 0, stdout: JSON.stringify({ msg: "periodic_fired" }) }),
    T0,
  );

  // At T0 + 30s, userIdleSeconds = 30s: nothing meets threshold yet
  assert.equal(mgr.checkAndRunTriggers(30, T0 + 30_000).length, 0);

  // At T0 + 65s, userIdleSeconds = 130s: all 3 are due, sorted by priority (5 -> 20 -> 30)
  const fired1 = mgr.checkAndRunTriggers(130, T0 + 65_000);
  assert.deepEqual(
    fired1.map((f) => f.pluginName),
    ["periodic_high_pri", "organizer_once", "idle_repeater"],
  );
  assert.equal(mgr.getPluginState("organizer_once")?.idleState, "Triggering");
  assert.equal(mgr.getPluginState("organizer_once")?.hasTriggeredInCurrentIdle, true);

  // At T0 + 200s, user still idle (userIdleSeconds = 265s):
  // - periodic_high_pri fires (135s >= 60s)
  // - organizer_once (idle_once) does NOT fire again during the same idle period
  // - idle_repeater (idle) DOES fire again because 135s >= 120s idle_seconds
  const fired2 = mgr.checkAndRunTriggers(265, T0 + 200_000);
  assert.deepEqual(
    fired2.map((f) => f.pluginName),
    ["periodic_high_pri", "idle_repeater"],
  );

  // User becomes active (userIdleSeconds = 5s) -> resets idleState to Monitoring and hasTriggeredInCurrentIdle to false
  mgr.checkAndRunTriggers(5, T0 + 210_000);
  assert.equal(mgr.getPluginState("organizer_once")?.idleState, "Monitoring");
  assert.equal(mgr.getPluginState("organizer_once")?.hasTriggeredInCurrentIdle, false);

  // User goes idle again (userIdleSeconds = 150s) -> organizer_once can fire again!
  const fired3 = mgr.checkAndRunTriggers(150, T0 + 220_000);
  assert.ok(fired3.some((f) => f.pluginName === "organizer_once"));
  void utimesSync;
});

test("2. erty3244/dsh-self-trigger: active windows, linear fail-ramp probability, silenceStop circuit breaker, dailyMax cap, and synthetic session key filtering", () => {
  // Daytime window 09:00..23:00
  assert.equal(inActiveWindow(new Date("2026-10-28T10:30:00"), "09:00", "23:00"), true);
  assert.equal(inActiveWindow(new Date("2026-10-28T03:15:00"), "09:00", "23:00"), false);

  // Overnight window 22:00..06:00
  assert.equal(inActiveWindow(new Date("2026-10-28T23:30:00"), "22:00", "06:00"), true);
  assert.equal(inActiveWindow(new Date("2026-10-28T04:30:00"), "22:00", "06:00"), true);
  assert.equal(inActiveWindow(new Date("2026-10-28T14:00:00"), "22:00", "06:00"), false);

  // Linear probability ramp: p = min(1, consecutiveCheckFails * 20 / 100)
  const baseInput = {
    nowDate: new Date("2026-10-28T14:00:00"),
    activeFrom: "09:00",
    activeTo: "23:00",
    idleMs: 35 * MIN,
    minIdleMs: 30 * MIN,
    consecutiveCheckFails: 0,
    failStepPct: 20,
    dailyCount: 0,
    dailyMax: 6,
    consecutiveSilences: 0,
    silenceStop: 2,
    rand: 0.35,
  };

  // 0 fails -> p = 0 -> prob_miss
  const d0 = decideSelfTrigger({ ...baseInput, consecutiveCheckFails: 0 });
  assert.deepEqual(d0, { ok: false, reason: "prob_miss", p: 0 });

  // 1 fail -> p = 0.2 -> rand 0.35 >= 0.2 -> prob_miss
  const d1 = decideSelfTrigger({ ...baseInput, consecutiveCheckFails: 1 });
  assert.deepEqual(d1, { ok: false, reason: "prob_miss", p: 0.2 });

  // 2 fails -> p = 0.4 -> rand 0.35 < 0.4 -> prob_pass!
  const d2 = decideSelfTrigger({ ...baseInput, consecutiveCheckFails: 2 });
  assert.deepEqual(d2, { ok: true, reason: "prob_pass", p: 0.4 });

  // Silence stop and daily cap gates
  assert.equal(decideSelfTrigger({ ...baseInput, consecutiveSilences: 2 }).reason, "silence_stop");
  assert.equal(decideSelfTrigger({ ...baseInput, dailyCount: 6 }).reason, "daily_cap");
  assert.equal(decideSelfTrigger({ ...baseInput, idleMs: 10 * MIN }).reason, "recently_active");

  // Judge deferral
  assert.deepEqual(shouldDeferJudge({ idleOk: true, inFlight: true, hasRecentDone: false }), {
    defer: true,
    reason: "in_flight",
  });
  assert.deepEqual(shouldDeferJudge({ idleOk: true, inFlight: false, hasRecentDone: false }), {
    defer: false,
    reason: "ready",
  });

  // SelfTriggerStateTracker: ignores ":selftrigger-" and ":sched-" session keys
  const startMs = new Date("2026-10-28T10:00:00").getTime();
  const tracker = new SelfTriggerStateTracker(
    { idleMinutes: 30, failStepPct: 50, silenceStop: 2, dailyMax: 5, recentDoneCooldownMs: 1000 },
    startMs,
  );
  assert.equal(tracker.recordActivity("agent:main:selftrigger-12345", startMs + 20 * MIN), false);
  assert.equal(tracker.recordActivity("agent:main:sched-cron", startMs + 25 * MIN), false);
  assert.equal(tracker.lastHumanActivityAtMs, startMs);

  // Tick 1 at +35 min: consecutiveCheckFails is 0 -> p = 0 -> misses and increments consecutiveCheckFails to 1
  const t1 = tracker.evaluateTick(startMs + 35 * MIN, 0.2, 0.1);
  assert.equal(t1.triggered, false);
  assert.equal(tracker.consecutiveCheckFails, 1);

  // Tick 2 at +40 min: consecutiveCheckFails is 1 -> p = 0.5 -> rand 0.2 < 0.5 -> triggers!
  const t2 = tracker.evaluateTick(startMs + 40 * MIN, 0.2, 0.1);
  assert.equal(t2.triggered, true);
  assert.equal(t2.selectedAction, "share");
  assert.equal(tracker.dailyCount, 1);

  // Tick 3 & 4 without human reply -> hits silenceStop after 2 unanswered triggers
  tracker.evaluateTick(startMs + 45 * MIN, 0.1); // miss (p=0 -> fails=1)
  const t3 = tracker.evaluateTick(startMs + 50 * MIN, 0.1); // triggers (#2 unanswered)
  assert.equal(t3.triggered, true);
  const t4 = tracker.evaluateTick(startMs + 55 * MIN, 0.1); // blocked by silence_stop!
  assert.equal(t4.triggered, false);
  assert.equal(t4.decision.reason, "silence_stop");

  // Real human activity resets consecutiveSilences so triggers can resume later
  assert.equal(tracker.recordActivity("agent:main:user-chat", startMs + 60 * MIN), true);
  assert.equal(tracker.consecutiveSilences, 0);

  // Weighted action selector & maxChars budget
  assert.equal(pickWeightedAction({ share: 40, reflect: 60 }, 0.9), "reflect");
  assert.equal(enforceMaxCharsBudget("a".repeat(700), 650).length, 650);
});

test("3. bryanchen3777/soul-os-harness: TriggerEnvelope vs Perception, gateProactive, 4-stage Agency pipeline, per-agent isolation, and Heartbeat TTL anti-storm", () => {
  const nowSec = 1_700_000_000;
  const proactiveEnv = {
    triggerType: "PROACTIVE" as const,
    sourceId: "inner_life",
    targetAgentId: "agent-alpha",
    timestamp: nowSec,
    priority: TriggerPriority.NORMAL,
    ttlSeconds: 30,
    correlationId: "corr-1",
    payload: {
      content: "User has an upcoming flight to Tokyo; check visa/passport notes.",
      salience: 0.82,
      workspacePath: "/Users/mac/trips",
      secretRouterFlag: "do-not-leak-to-cognition",
    },
  };

  // 1. Producer-side gateProactive
  assert.equal(gateProactive(null, true, nowSec).status, "UNAVAILABLE");
  assert.equal(gateProactive(proactiveEnv, false, nowSec).status, "GATED");
  const emitted = gateProactive(proactiveEnv, true, nowSec);
  assert.equal(emitted.status, "EMITTED");

  // 2. Perception strips scheduler/router metadata
  const perception = envelopeToPerception(proactiveEnv);
  assert.equal(perception.content, "User has an upcoming flight to Tokyo; check visa/passport notes.");
  assert.equal("secretRouterFlag" in perception.metadata, false);
  assert.equal("ttlSeconds" in perception, false);

  // 3. Multi-agent router with per-agent isolation & TTL check
  const router = new SoulTriggerRouter(5);
  router.registerAgent(createAgencyState("agent-alpha", { cooldownSecs: 120, salienceThreshold: 0.6 }));
  router.registerAgent(createAgencyState("agent-beta", { cooldownSecs: 120, salienceThreshold: 0.6 }));

  // Expired TTL (e.g. queued 45s ago with ttlSeconds=30 during laptop sleep) is dropped before pipeline
  const expiredRes = router.dispatch({ ...proactiveEnv, timestamp: nowSec - 45 }, nowSec);
  assert.equal(expiredRes.accepted, false);
  assert.equal(expiredRes.droppedReason, "ttl_expired");

  // Fresh proactive trigger on agent-alpha engages and enters 120s cooldown
  const alphaRes1 = router.dispatch(proactiveEnv, nowSec);
  assert.equal(alphaRes1.accepted, true);
  assert.equal(alphaRes1.trace?.finalAction, "EMIT_PROACTIVE");
  assert.equal(alphaRes1.trace?.stageResults.length, 4);

  // Second proactive trigger on agent-alpha 10s later is rejected by Stage 1 (agent_in_silence)
  const alphaRes2 = router.dispatch({ ...proactiveEnv, correlationId: "corr-2", timestamp: nowSec + 10 }, nowSec + 10);
  assert.equal(alphaRes2.accepted, false);
  assert.equal(alphaRes2.trace?.finalAction, "NO_OP");
  assert.match(alphaRes2.trace?.stageResults[0]?.detail ?? "", /agent_in_silence/);

  // Meanwhile, agent-beta is completely isolated and CAN accept a proactive trigger at nowSec + 10!
  const betaRes = router.dispatch(
    { ...proactiveEnv, targetAgentId: "agent-beta", correlationId: "corr-3", timestamp: nowSec + 10 },
    nowSec + 10,
  );
  assert.equal(betaRes.accepted, true);
  assert.equal(betaRes.trace?.finalAction, "EMIT_PROACTIVE");

  // Direct USER_MESSAGE bypasses agent-alpha's proactive silence cooldown
  const userMsgRes = router.dispatch(
    {
      triggerType: "USER_MESSAGE",
      sourceId: "chat",
      targetAgentId: "agent-alpha",
      timestamp: nowSec + 15,
      priority: TriggerPriority.CRITICAL,
      ttlSeconds: null,
      correlationId: "corr-user",
      payload: { content: "What terminal is my flight?" },
    },
    nowSec + 15,
  );
  assert.equal(userMsgRes.accepted, true);
  assert.equal(userMsgRes.trace?.finalAction, "PROCESS_INPUT");
});

test("4. 030603-ccf/MemoirAI & xybruceliu/thoughtful-agents: sigmoid importance, 30d exponential recency, cross-session reinforcement, access_count < 15 retirement cap, turn saliency, and HallucinationGuard", () => {
  const mem = new SemanticMemoryStore();
  const t1 = mem.upsert({
    category: "commitments",
    content: "Renew car insurance policy #AX-904 before November 15",
    sessionId: "sess-1",
    initialConfidence: 0.75,
    nowMs: T0 - 5 * DAY,
  });
  assert.equal(t1.confidence, 0.75);

  // Reinforce across a second and third session (+0.08 each)
  mem.upsert({
    category: "commitments",
    content: "Renew car insurance policy #AX-904 before November 15",
    sessionId: "sess-2",
    nowMs: T0 - 2 * DAY,
  });
  const reinforced = mem.upsert({
    category: "commitments",
    content: "Renew car insurance policy #AX-904 before November 15",
    sessionId: "sess-3",
    nowMs: T0 - DAY,
  });
  assert.equal(reinforced.confidence, 0.91);
  assert.ok(computeMemoirImportance(reinforced) > 0.68);
  assert.ok(computeMemoirRecency(T0 - 30 * DAY, T0) < 0.37 && computeMemoirRecency(T0 - 30 * DAY, T0) > 0.36);

  // Proactive trigger generation: skips if already in context, fires when absent, retires at accessCount === 15
  assert.equal(
    mem.buildProactiveTriggers("I am renewing car insurance policy #AX-904 right now", T0).length,
    0,
    "must not trigger when memory content is already in current context",
  );

  for (let i = 0; i < 15; i++) {
    const trig = mem.buildProactiveTriggers("Checking monthly household bills and admin tasks", T0);
    assert.equal(trig.length, 1, `should fire on iteration ${i + 1}/15`);
  }
  // 16th call: accessCount is now 15 -> retired from proactive triggers!
  assert.equal(
    mem.buildProactiveTriggers("Checking monthly household bills and admin tasks", T0).length,
    0,
    "must retire proactive trigger once accessCount reaches 15",
  );

  // thoughtful-agents turn-decayed saliency & 5-factor intrinsic motivation
  const sal0 = computeTurnDecayedSaliency({
    interpretationSimilarity: 0.8,
    verbatimTextSimilarity: 0.9,
    importanceWeight: 1.0,
    turnsElapsed: 0,
  });
  const sal5 = computeTurnDecayedSaliency({
    interpretationSimilarity: 0.8,
    verbatimTextSimilarity: 0.9,
    importanceWeight: 1.0,
    turnsElapsed: 5,
  });
  assert.ok(sal0 > sal5);
  assert.equal(sal0, Number((0.55 * 0.9).toFixed(6)));

  const motHigh = evaluateIntrinsicMotivation({
    relevance: 4.5,
    informationGap: 4.2,
    impact: 4.0,
    urgency: 3.8,
    coherence: 4.1,
  });
  assert.equal(motHigh.shouldProact, true);

  const motLow = evaluateIntrinsicMotivation({
    relevance: 2.0,
    informationGap: 2.5,
    impact: 2.0,
    urgency: 1.5,
    coherence: 3.0,
  });
  assert.equal(motLow.shouldProact, false);

  // MemoirAI deterministic HallucinationGuard
  const sources = [
    "Vendor AcmeCorp invoice total is $450 due on 2026-10-28. Use --wasm-tier-up=false in src/runtime/verify.ts.",
  ];
  const faithfulCheck = verifyEntitiesAgainstSources(
    'Recall: AcmeCorp invoice is $450 (2026-10-28) and uses "--wasm-tier-up=false" in src/runtime/verify.ts.',
    sources,
  );
  assert.equal(faithfulCheck.passed, true);
  assert.equal(faithfulCheck.faithfulnessScore, 1.0);

  const hallucinatedCheck = verifyEntitiesAgainstSources(
    "Recall: GlobexCorp invoice is $990 due on 2026-12-01 with --fake-flag.",
    sources,
  );
  assert.equal(hallucinatedCheck.passed, false);
  assert.ok(hallucinatedCheck.hallucinatedEntities.includes("GlobexCorp"));
  assert.ok(hallucinatedCheck.hallucinatedEntities.includes("$990"));
  assert.ok(hallucinatedCheck.hallucinatedEntities.includes("--fake-flag"));
});

test("5. OpenChronicle, screenpipe, ProactiveAgent, MineContext & ideation.md: 4-timer dispatcher, viewport intersection, stream consolidation, burstiness, in-flight commitments & cross-app shuttle", () => {
  // 5a. OpenChronicle 4-timer dispatcher + SHA-256 fingerprint dedup
  const disp = new OpenChronicleEventDispatcher();
  const r1 = disp.ingestNotification({
    kind: "AXFocusedWindowChanged",
    app: "Safari",
    windowTitle: "Statement - Chase",
    textContent: "Balance: $1,240.00",
    timestampMs: 10_000,
  });
  assert.equal(r1.accepted, true);

  // Duplicate within 1000ms -> dedup_interval
  assert.equal(
    disp.ingestNotification({
      kind: "AXFocusedWindowChanged",
      app: "Safari",
      windowTitle: "Statement - Chase",
      textContent: "Balance: $1,240.00",
      timestampMs: 10_500,
    }).reason,
    "dedup_interval",
  );

  // Different app within 2000ms minCaptureGap -> min_capture_gap
  assert.equal(
    disp.ingestNotification({
      kind: "didActivateApplicationNotification",
      app: "Notes",
      windowTitle: "Budget",
      textContent: "October expenses",
      timestampMs: 11_200,
    }).reason,
    "min_capture_gap",
  );

  // Same window at +3000ms (< 5000ms sameWindowDedupMs) -> same_window_dedup
  assert.equal(
    disp.ingestNotification({
      kind: "AXTitleChanged",
      app: "Safari",
      windowTitle: "Statement - Chase",
      textContent: "Balance: $1,240.00",
      timestampMs: 13_500,
    }).reason,
    "same_window_dedup",
  );

  // Identical content fingerprint at +6000ms -> identical_fingerprint
  assert.equal(
    disp.ingestNotification({
      kind: "AXFocusedWindowChanged",
      app: "Safari",
      windowTitle: "Statement - Chase",
      textContent: "Balance:   $1,240.00  ",
      timestampMs: 16_500,
    }).reason,
    "identical_fingerprint",
  );

  // 5b. screenpipe viewport bounding-box intersection
  const vp = filterVisibleViewportElements(
    [
      { role: "AXStaticText", text: "Visible paragraph", rect: { x: 100, y: 100, width: 300, height: 40 } },
      { role: "AXStaticText", text: "Offscreen scrolled away", rect: { x: 100, y: 2500, width: 300, height: 40 } },
    ],
    { x: 0, y: 0, width: 1440, height: 900 },
  );
  assert.equal(vp.visible.length, 1);
  assert.equal(vp.droppedOffscreen, 1);

  // 5c. ProactiveAgent + MineContext activity consolidation & burstiness
  const docPath = join(tmp(), "lease_addendum.md");
  writeFileSync(docPath, "Landlord: Oakridge Properties. Monthly rent: $2,850 due on the 1st.");
  const consolidated = consolidateActivityStream([
    { timestampMs: 1_000, stream: "window", app: "Chrome", title: "Gmail - Oakridge Lease" },
    { timestampMs: 1_200, stream: "window", app: "Chrome", title: " Oakridge Portal" },
    { timestampMs: 1_400, stream: "filesystem", filePath: docPath },
    { timestampMs: 25_000, stream: "window", app: "Notes", title: "Apartment Checklist" },
  ]);
  assert.equal(consolidated.windowSegments.length, 2, "consecutive Chrome events must merge into 1 segment");
  assert.deepEqual(consolidated.windowSegments[0]!.titles, ["Gmail - Oakridge Lease", " Oakridge Portal"]);
  assert.equal(consolidated.taskSwitchingCount, 1);
  assert.equal(consolidated.createdArtifacts.length, 1);
  assert.match(consolidated.createdArtifacts[0]!.previewText, /Oakridge Properties/);
  assert.ok(computeBurstinessScore([1000, 1050, 1100, 1150, 1200, 1250, 50_000]) > 0.35);

  // MineContext inline completion cursor trigger
  assert.equal(shouldTriggerInlineCompletion("const total = ", 14), false); // ends with space
  assert.equal(shouldTriggerInlineCompletion("const total = calc", 18), true);
  assert.equal(shouldTriggerInlineCompletion("const total = calc", 15), false); // mid-word

  // 5d. Non-developer in-flight commitments (ideation.md numbered list + 4 MineContext categories)
  const liveDraft = [
    "Hi Sarah,",
    "1) I'll send you the Q3 AcmeCorp tax invoice PDF",
    "2) We need to submit the insurance renewal by Friday",
  ].join("\n");
  const commitments = detectInFlightCommitments(liveDraft);
  assert.ok(commitments.some((c) => c.category === "NUMBERED_LIST_COMMITMENT" && c.prefetchQuery.includes("acmecorp")));
  assert.ok(commitments.some((c) => c.category === "PROACTIVE_COMMITMENT"));
  assert.ok(commitments.some((c) => c.category === "TIME_AGREEMENT"));

  // 5e. Cross-app copy-paste shuttle oscillation (Chrome <-> Google Sheets)
  const shuttle = detectCrossAppShuttle([
    { timestampMs: 1_000, stream: "window", app: "Chrome", title: "Stripe Payouts - INV-8821" },
    { timestampMs: 4_000, stream: "clipboard", textContent: "INV-8821 $1,420.00" },
    { timestampMs: 6_000, stream: "window", app: "Sheets", title: "2026 Bookkeeping" },
    { timestampMs: 10_000, stream: "window", app: "Chrome", title: "Stripe Payouts - INV-8822" },
    { timestampMs: 12_000, stream: "clipboard", textContent: "INV-8822 $890.00" },
    { timestampMs: 15_000, stream: "window", app: "Sheets", title: "2026 Bookkeeping" },
    { timestampMs: 19_000, stream: "window", app: "Chrome", title: "Stripe Payouts - INV-8823" },
  ]);
  assert.ok(shuttle);
  assert.equal(shuttle.triggered, true);
  assert.equal(shuttle.appA, "Chrome");
  assert.equal(shuttle.appB, "Sheets");
  assert.equal(shuttle.clipboardCopies, 2);
  assert.ok(shuttle.extractedEntities.includes("INV-8821"));
});

test("6. AFK-surf/Comma, refixai/proactivity-sdk, openclaw & ideation.md: DeterministicLoop, Scratchpad Diff, Adaptive Cadence, NO_REPLY suppression, and GovernedActionLedger", () => {
  // 6a. Comma DeterministicLoop: quiet ticks do not wake the agent
  let inboxCount = 3;
  const loop = new DeterministicLoop(
    "inbox-watcher",
    () => ({ unread: inboxCount }),
    (prev, curr) => {
      if (!prev || curr.unread <= prev.unread) return { wake: false, reason: "no_new_messages" };
      return { wake: true, reason: "unread_increased", payload: { delta: curr.unread - prev.unread } };
    },
  );
  assert.equal(loop.poll().wake, false);
  assert.equal(loop.poll().wake, false);
  inboxCount = 5;
  const woke = loop.poll();
  assert.equal(woke.wake, true);
  assert.deepEqual(woke.payload, { delta: 2 });
  assert.equal(woke.wakeCount, 1);

  // 6b. Scratchpad diff + Adaptive cadence + NO_REPLY & duplicate suppression
  const diff1 = computeScratchpadDiff({ a: 1 }, { a: 1, b: 2 });
  assert.equal(diff1.changed, true);
  assert.deepEqual(diff1.addedKeys, ["b"]);

  const monitor = new ProactiveMonitorRuntime(
    {
      minMs: 10_000,
      maxMs: 160_000,
      backoffFactor: 2,
      tightenFactor: 0.5,
      activeHours: { from: "08:00", to: "22:00" },
      idleOnly: true,
      minUserIdleMs: 30_000,
    },
    [{ id: "g1", description: "Track package deliveries and flight changes", priority: "high", active: true }],
  );

  const daytimeMs = new Date("2026-10-28T14:00:00").getTime();
  // First tick with state change -> surfaces and stays at minMs (10_000)
  const m1 = monitor.evaluateMonitorTick({
    nowMs: daytimeMs,
    userIdleMs: 45_000,
    nextScratchpad: { flightGate: "B12" },
    candidateReply: "Flight gate updated to B12.",
  });
  assert.equal(m1.action, "SURFACE");
  assert.equal(m1.nextIntervalMs, 10_000);

  // Second tick with unchanged scratchpad -> suppressed and backs off (10_000 -> 20_000)
  const m2 = monitor.evaluateMonitorTick({
    nowMs: daytimeMs + 10_000,
    userIdleMs: 55_000,
    nextScratchpad: { flightGate: "B12" },
    candidateReply: "Flight gate updated to B12.",
  });
  assert.equal(m2.action, "NO_REPLY");
  assert.equal(m2.reason, "scratchpad_unchanged");
  assert.equal(m2.nextIntervalMs, 20_000);

  // Third tick with explicit NO_REPLY -> backs off again (20_000 -> 40_000)
  const m3 = monitor.evaluateMonitorTick({
    nowMs: daytimeMs + 30_000,
    userIdleMs: 75_000,
    nextScratchpad: { flightGate: "B12" },
    candidateReply: "NO_REPLY",
  });
  assert.equal(m3.action, "NO_REPLY");
  assert.equal(m3.nextIntervalMs, 40_000);

  // Fourth tick with urgent state change -> tightens immediately back to minMs (10_000)
  const m4 = monitor.evaluateMonitorTick({
    nowMs: daytimeMs + 70_000,
    userIdleMs: 115_000,
    nextScratchpad: { flightGate: "C04" },
    candidateReply: "Gate changed to C04!",
    urgent: true,
  });
  assert.equal(m4.action, "SURFACE");
  assert.equal(m4.nextIntervalMs, 10_000);
  assert.equal(
    computeAdaptiveCadenceMs(40_000, { minMs: 10_000, maxMs: 160_000 }, { stateChanged: true, urgent: false, replied: true }),
    20_000,
  );

  // 6c. GovernedActionLedger: idempotency + ALLOW_ONCE / ALWAYS_ALLOW / REFUSE (ideation.md Rule 1)
  const ledger = new GovernedActionLedger();
  let sideEffectCounter = 0;

  // Unset policy -> NEEDS_PERMISSION
  assert.equal(
    ledger.governed({
      idempotencyKey: "k1",
      actionKind: "write_brief",
      target: "workspace_a",
      execute: () => ++sideEffectCounter,
    }).status,
    "NEEDS_PERMISSION",
  );
  assert.equal(sideEffectCounter, 0);

  // ALLOW_ONCE -> executes once, deduplicates same key, and reverts to UNSET for a new key
  ledger.setPermission("write_brief", "workspace_a", "ALLOW_ONCE");
  const exec1 = ledger.governed({
    idempotencyKey: "k1",
    actionKind: "write_brief",
    target: "workspace_a",
    execute: () => ++sideEffectCounter,
  });
  assert.equal(exec1.status, "EXECUTED");
  assert.equal(exec1.result, 1);

  const dedup1 = ledger.governed({
    idempotencyKey: "k1",
    actionKind: "write_brief",
    target: "workspace_a",
    execute: () => ++sideEffectCounter,
  });
  assert.equal(dedup1.status, "DEDUPLICATED");
  assert.equal(sideEffectCounter, 1);

  // Next distinct key k2 requires permission again because ALLOW_ONCE was consumed
  assert.equal(
    ledger.governed({
      idempotencyKey: "k2",
      actionKind: "write_brief",
      target: "workspace_a",
      execute: () => ++sideEffectCounter,
    }).status,
    "NEEDS_PERMISSION",
  );

  // REFUSE blocks execution
  ledger.setPermission("write_brief", "workspace_a", "REFUSE");
  assert.equal(
    ledger.governed({
      idempotencyKey: "k3",
      actionKind: "write_brief",
      target: "workspace_a",
      execute: () => ++sideEffectCounter,
    }).status,
    "REFUSED_BY_POLICY",
  );
});

test("7. TGL, ProactMem, ProAgent, agent-eval-open-problems & UnifiedProactiveWindow end-to-end against real SQLite EventStore", async () => {
  // 7a. ProactMem conditional regularity mining & temporal holdout replay validation
  const proactMem = new ProactMemEngine({
    windowMs: 30 * MIN,
    minConfReplay: 0.5,
    minSupportFollowed: 3,
    minLift: 1.0,
  });

  const trainSessions = [
    {
      sessionId: "train-1",
      startMs: T0 - 20 * DAY,
      endMs: T0 - 20 * DAY + 2 * 60 * MIN,
      events: [
        { timestampMs: T0 - 20 * DAY + 5 * MIN, tag: "context:flight_confirmation_opened" },
        { timestampMs: T0 - 20 * DAY + 15 * MIN, tag: "need:check_passport_and_baggage_policy" },
        { timestampMs: T0 - 20 * DAY + 40 * MIN, tag: "context:random_news_browse" },
        { timestampMs: T0 - 20 * DAY + 50 * MIN, tag: "need:one_off_lookup" },
      ],
    },
  ];

  // Validation sessions:
  // - flight_confirmation_opened -> check_passport_and_baggage_policy:
  //   followed 4 times within 30m, violated 1 time, 1 already fulfilled (excluded), 1 censored at session end (excluded)
  //   => n_f = 4, n_v = 1 => conf_replay = 4/5 = 0.80 >= 0.5, support = 4 >= 3, lift > 1.0 => VALIDATED!
  const valSessions = [1, 2, 3, 4].map((idx) => ({
    sessionId: `val-follow-${idx}`,
    startMs: T0 - (15 - idx) * DAY,
    endMs: T0 - (15 - idx) * DAY + 90 * MIN,
    events: [
      { timestampMs: T0 - (15 - idx) * DAY + 10 * MIN, tag: "context:flight_confirmation_opened" },
      { timestampMs: T0 - (15 - idx) * DAY + 22 * MIN, tag: "need:check_passport_and_baggage_policy" },
    ],
  }));
  // 1 violated occurrence (session lasts 90m, need never occurs)
  valSessions.push({
    sessionId: "val-violated",
    startMs: T0 - 9 * DAY,
    endMs: T0 - 9 * DAY + 90 * MIN,
    events: [
      { timestampMs: T0 - 9 * DAY + 10 * MIN, tag: "context:flight_confirmation_opened" },
      { timestampMs: T0 - 9 * DAY + 20 * MIN, tag: "context:random_news_browse" },
    ],
  });
  // 1 already-fulfilled occurrence (need occurred BEFORE context -> excluded!)
  valSessions.push({
    sessionId: "val-fulfilled",
    startMs: T0 - 8 * DAY,
    endMs: T0 - 8 * DAY + 90 * MIN,
    events: [
      { timestampMs: T0 - 8 * DAY + 2 * MIN, tag: "need:check_passport_and_baggage_policy" },
      { timestampMs: T0 - 8 * DAY + 10 * MIN, tag: "context:flight_confirmation_opened" },
    ],
  });
  // 1 censored occurrence (context occurs 5m before session ends -> excluded!)
  valSessions.push({
    sessionId: "val-censored",
    startMs: T0 - 7 * DAY,
    endMs: T0 - 7 * DAY + 15 * MIN,
    events: [{ timestampMs: T0 - 7 * DAY + 10 * MIN, tag: "context:flight_confirmation_opened" }],
  });

  const regularities = proactMem.mineAndValidate(trainSessions, valSessions);
  const flightReg = regularities.find((r) => r.contextTag === "context:flight_confirmation_opened")!;
  assert.equal(flightReg.nFollowed, 4);
  assert.equal(flightReg.nViolated, 1);
  assert.equal(flightReg.nFulfilledExcluded, 1);
  assert.equal(flightReg.nCensoredExcluded, 1);
  assert.equal(flightReg.confReplay, 0.8);
  assert.equal(flightReg.validated, true);

  const noiseReg = regularities.find((r) => r.contextTag === "context:random_news_browse")!;
  assert.equal(noiseReg.validated, false);

  const top3 = proactMem.selectTop3(["context:flight_confirmation_opened"]);
  assert.equal(top3.length, 1);
  assert.equal(top3[0]!.regularity.targetNeedTag, "need:check_passport_and_baggage_policy");

  // If already fulfilled in current session, selectTop3 excludes it
  assert.equal(
    proactMem.selectTop3(["context:flight_confirmation_opened"], ["need:check_passport_and_baggage_policy"]).length,
    0,
  );

  // 7b. ProAgent sensor gate
  assert.equal(
    evaluateProAgentSensorGate({
      nowSec: 100,
      lastTriggerSec: 80,
      cooldownTauSec: 60,
      focusDurationSec: 30,
      minFocusStabilitySec: 10,
      currentContextText: "Reconciling AcmeCorp Q3 invoice",
      recentTriggeredContexts: [],
      redundancyThresholdTauT: 0.7,
    }).reason,
    "cooldown_active",
  );
  assert.equal(
    evaluateProAgentSensorGate({
      nowSec: 200,
      lastTriggerSec: 80,
      cooldownTauSec: 60,
      focusDurationSec: 30,
      minFocusStabilitySec: 10,
      currentContextText: "Reconciling AcmeCorp Q3 invoice",
      recentTriggeredContexts: ["Reconciling AcmeCorp Q3 invoice today"],
      redundancyThresholdTauT: 0.6,
    }).reason,
    "semantically_redundant",
  );

  // 7c. amandachan-ai/agent-eval-open-problems: as-of-T stream replay, minimal pairs & per-case flips
  const storePath = join(tmp(), "unified.db");
  const store = new EventStore(storePath);

  const evPastInvoice = makeEvent({
    source: "chrome",
    timestampMs: T0 - 14 * DAY,
    workspacePath: "/Users/mac/finance",
    contentText: "AcmeCorp Q3 Tax Invoice #INV-2026-991: Wire routing account 8841-9902, total $4,250.00",
    sourceUri: "https://billing.acmecorp.example/invoices/INV-2026-991",
    metadataJson: JSON.stringify({ kind: "visit", app: "Chrome" }),
  });
  const evPastPassport = makeEvent({
    source: "antigravity_session",
    timestampMs: T0 - 10 * DAY,
    workspacePath: "/Users/mac/trips",
    contentText: "ANA Flight NH105 confirmation: Passport #P9928172, seat 14A, terminal 2 check-in.",
    sourceUri: "session:trips#1",
    metadataJson: JSON.stringify({ role: "assistant" }),
  });
  const evCurrentFriction = makeEvent({
    source: "chrome",
    timestampMs: T0 - 2 * MIN,
    workspacePath: "/Users/mac/finance",
    contentText: "Where is the wire routing account for AcmeCorp invoice?",
    sourceUri: "https://mail.example.com/compose",
    metadataJson: JSON.stringify({ kind: "visit", app: "Chrome" }),
  });
  const evFutureLeak = makeEvent({
    source: "chrome",
    timestampMs: T0 + 10 * MIN,
    workspacePath: "/Users/mac/finance",
    contentText: "Future secret event after cutoff T0",
    sourceUri: "https://future.example.com",
    metadataJson: "{}",
  });

  store.insert(withSeeks([evPastInvoice, evPastPassport, evCurrentFriction, evFutureLeak]));

  const streamEval = evaluateStreamAsOfT(
    [evPastInvoice, evPastPassport, evCurrentFriction, evFutureLeak],
    [T0 - 12 * DAY, T0],
    (visible, cutoff) => {
      const g = new TemporalEventEntityGraph(visible, cutoff);
      return g.getEntityCount();
    },
  );
  assert.equal(streamEval.totalLeaks, 0);
  assert.equal(streamEval.steps[0]!.visibleEventCount, 1); // only evPastInvoice existed at T0 - 12d
  assert.equal(streamEval.steps[1]!.visibleEventCount, 3); // evFutureLeak is strictly excluded at T0

  // Minimal pairs check: identical except for 1 detail (completed numbered commitment vs empty greeting)
  const minPairs = evaluateMinimalPairs(
    [
      {
        pairId: "commitment-vs-greeting",
        positiveContext: "Hi Sarah,\n1) I'll send you the AcmeCorp tax invoice PDF\n2) Talk soon",
        negativeContext: "Hi Sarah,\nHope you had a great weekend!\nTalk soon",
      },
    ],
    (text) => detectInFlightCommitments(text).length > 0,
  );
  assert.equal(minPairs.discriminationRate, 1.0);

  // Per-case flip report against A/A baseline
  const flipReport = comparePerCaseFlips(
    [
      { caseId: "c1", passed: true },
      { caseId: "c2", passed: false },
      { caseId: "c3", passed: false },
    ],
    [
      { caseId: "c1", passed: true },
      { caseId: "c2", passed: true }, // flipped UP
      { caseId: "c3", passed: false },
    ],
  );
  assert.deepEqual(flipReport.flippedUp, ["c2"]);
  assert.deepEqual(flipReport.flippedDown, []);
  assert.equal(flipReport.exceedsNoiseFloor, true);

  // 7d. End-to-End UnifiedProactiveWindow over real SQLite EventStore (non-developer workflow!)
  const unifiedRes = await evaluateUnifiedProactiveWindow({
    store,
    ctx: {
      endMs: T0,
      eventIds: [evCurrentFriction.eventId],
      workspacePath: "/Users/mac/finance",
    },
    liveText: "1) I'll send you the AcmeCorp invoice routing number\n2) Let's finalize Q3",
  });

  assert.equal(unifiedRes.triggered, true);
  assert.ok(unifiedRes.triggerSources.includes("in_flight_commitment"));
  assert.ok(unifiedRes.triggerSources.includes("tgl_entity_router"));
  assert.ok(unifiedRes.verifiedHits.length >= 1);
  assert.match(unifiedRes.verifiedHits[0]!.quote, /8841-9902/);
  assert.equal(unifiedRes.entityFaithfulness, 1.0);

  store.close();
});

test("8. Real Owner Session History (~/.gadget/miner.db): tests commitments, cross-app shuttles, activity consolidation, and per-case flip replay directly on real history", async (t) => {
  const cfg = loadConfig();
  if (!existsSync(cfg.dbPath)) {
    t.skip(`No local ~/.gadget/miner.db at ${cfg.dbPath}`);
    return;
  }

  const store = new EventStore(cfg.dbPath, { readOnly: true });
  try {
    // 8a. Real user turns -> detectInFlightCommitments
    const userTurns = store.db
      .prepare(
        `SELECT content_text
           FROM events
          WHERE source IN ('antigravity_session', 'codex_session')
            AND json_extract(metadata_json, '$.role') = 'user'
          ORDER BY timestamp_ms DESC`,
      )
      .all() as Array<{ content_text: string }>;

    let realCommitmentCount = 0;
    for (const r of userTurns) {
      realCommitmentCount += detectInFlightCommitments(r.content_text).length;
    }
    assert.ok(userTurns.length > 500, `expected >500 real user turns, got ${userTurns.length}`);
    assert.ok(realCommitmentCount >= 50, `expected >=50 real in-flight commitments in user history, got ${realCommitmentCount}`);

    // 8b. Real screen + clipboard capture -> consolidateActivityStream & detectCrossAppShuttle
    const sensoryRows = store.db
      .prepare(
        `SELECT source, timestamp_ms, content_text, metadata_json
           FROM events
          WHERE source IN ('screen', 'clipboard')
          ORDER BY timestamp_ms ASC`,
      )
      .all() as Array<{ source: string; timestamp_ms: number; content_text: string; metadata_json: string }>;

    if (sensoryRows.length > 50) {
      const rawActivity = sensoryRows.map((r) => {
        let meta: Record<string, unknown> = {};
        try {
          meta = JSON.parse(r.metadata_json) as Record<string, unknown>;
        } catch {
          // ignore
        }
        if (r.source === "clipboard") {
          return { timestampMs: r.timestamp_ms, stream: "clipboard" as const, textContent: r.content_text };
        }
        return {
          timestampMs: r.timestamp_ms,
          stream: "window" as const,
          app: String(meta.frontmostApp ?? meta.app ?? "Unknown"),
          title: String(meta.windowTitle ?? meta.title ?? ""),
          textContent: r.content_text,
        };
      });

      const obs = consolidateActivityStream(rawActivity);
      assert.ok(obs.windowSegments.length >= 20);
      assert.ok(obs.taskSwitchingCount >= 15);
      assert.ok(obs.burstinessScore > 0);

      let shuttlesDetected = 0;
      for (let i = 20; i < rawActivity.length; i += 15) {
        const sh = detectCrossAppShuttle(rawActivity.slice(Math.max(0, i - 40), i), {
          maxWindowMs: 5 * 60 * 1000,
          minAlternations: 4,
        });
        if (sh?.triggered) shuttlesDetected++;
      }
      assert.ok(shuttlesDetected >= 1, "expected at least 1 real cross-app shuttle in owner history");
    }

    // 8c. Real episodes replay & per-case flip comparison (Anticipator vs Realistic)
    const events = store.allEventsSorted();
    const episodes = buildEpisodes(events, cfg);
    assert.ok(episodes.length >= 200, `expected >=200 real episodes, got ${episodes.length}`);

    const fts = new FtsEventsSearcher(store);
    const surfacer = new VerifiedSurfacer(store);
    const anticipator = new CalibratedAnticipator(store, { priorEpisodes: episodes });

    // Evaluate across a representative slice of 60 real episodes for fast deterministic test execution
    const slice = episodes.slice(0, 60);
    const realisticCases = [];
    const anticipatorCases = [];

    for (const ep of slice) {
      const asOfMs = ep.seekStartMs;
      const oracleHits = [];
      for (const a of ep.seekActions) {
        oracleHits.push(...(await fts.search(a.query, asOfMs)));
      }
      const ctx = { endMs: asOfMs, eventIds: ep.contextEventIds };
      const { accepted: oracleAcc } = surfacer.filterSurfacableHits(ctx, oracleHits);
      const matching = oracleAcc.filter((h) => hitMatchesEpisode(h, ep, store));
      if (matching.length === 0) continue;
      const oracleIds = new Set(matching.map((h) => h.eventId).filter((id): id is string => Boolean(id)));

      let realHits: Hit[] = [];
      const lastId = ctx.eventIds.at(-1);
      const lastEv = lastId ? store.getEventById(lastId) : undefined;
      if (lastEv && lastEv.timestampMs < asOfMs) {
        const naive = (lastEv.contentText.match(/[\p{L}\p{N}_-]+/gu) ?? []).slice(0, 4);
        if (naive.length >= 2) realHits = await fts.search(naive.join(" "), asOfMs);
      }
      const realAcc =
        surfacer.decide(ctx, realHits).action === "SURFACE"
          ? surfacer.filterSurfacableHits(ctx, realHits).accepted
          : [];
      realisticCases.push({
        caseId: ep.episodeId,
        passed: realAcc.some((h) => hitMatchesEpisode(h, ep, store, oracleIds)),
      });

      const props = anticipator.propose(ctx);
      const antHits = [];
      for (const p of props) {
        antHits.push(...(await fts.search(p.query, asOfMs)));
      }
      const antAcc =
        surfacer.decide(ctx, antHits).action === "SURFACE"
          ? surfacer.filterSurfacableHits(ctx, antHits).accepted
          : [];
      anticipatorCases.push({
        caseId: ep.episodeId,
        passed: antAcc.some((h) => hitMatchesEpisode(h, ep, store, oracleIds)),
      });
    }

    const flips = comparePerCaseFlips(realisticCases, anticipatorCases);
    assert.ok(
      flips.candidatePassRate > flips.baselinePassRate,
      `expected anticipator pass rate (${flips.candidatePassRate}) > realistic (${flips.baselinePassRate}) on real history`,
    );
    assert.ok(flips.flippedUp.length > flips.flippedDown.length);
  } finally {
    store.close();
  }
});

