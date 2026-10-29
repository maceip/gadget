// Ported from:
// 1. 030603-ccf/MemoirAI:
//    - backend/core/agent_memory.py (MemoirTrace, SemanticMemory, importance/recency decay,
//      cross-session confidence reinforcement, build_triggers with access_count < 15 retirement cap)
//    - backend/core/hallucination_guard.py (deterministic entity extraction & faithfulness verification)
// 2. xybruceliu/thoughtful-agents (CHI 2025):
//    - thoughtful_agents/utils/saliency.py (turn-decayed saliency max(b*sim_interp, c*sim_text)*w*gamma^dt)
//    - thoughtful_agents/utils/thinking_engine.py (5-factor intrinsic motivation gate 1..5)

const DAY_MS = 24 * 60 * 60 * 1000;

export type MemoryCategory =
  | "people"
  | "places"
  | "events"
  | "preferences"
  | "Themes"
  | "commitments"
  | "workflows";

export interface MemoirTrace {
  key: string; // "${category}:${content}"
  category: MemoryCategory;
  content: string;
  confidence: number; // 0..1
  accessCount: number;
  createdAtMs: number;
  lastAccessedAtMs: number;
  sourceSessions: string[];
  emotionalWeight: number; // 0..1
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// MemoirAI exact importance formula:
// importance = confidence * (0.5 + 0.5 * sigmoid(access_count / 5))
export function computeMemoirImportance(trace: Pick<MemoirTrace, "confidence" | "accessCount">): number {
  const accessFactor = sigmoid(trace.accessCount / 5);
  return trace.confidence * (0.5 + 0.5 * accessFactor);
}

// MemoirAI exact recency formula:
// recency = exp(-days_ago / 30)
export function computeMemoirRecency(lastAccessedAtMs: number, nowMs = Date.now()): number {
  const daysAgo = Math.max(0, (nowMs - lastAccessedAtMs) / DAY_MS);
  return Math.exp(-daysAgo / 30);
}

// MemoirAI exact composite relevance score:
// score = 0.7 * importance + 0.3 * recency
export function computeMemoirScore(trace: MemoirTrace, nowMs = Date.now()): number {
  return 0.7 * computeMemoirImportance(trace) + 0.3 * computeMemoirRecency(trace.lastAccessedAtMs, nowMs);
}

export class SemanticMemoryStore {
  private readonly traces = new Map<string, MemoirTrace>();

  upsert(params: {
    category: MemoryCategory;
    content: string;
    sessionId: string;
    initialConfidence?: number;
    emotionalWeight?: number;
    nowMs?: number;
  }): MemoirTrace {
    const nowMs = params.nowMs ?? Date.now();
    const cleanContent = params.content.trim();
    const key = `${params.category}:${cleanContent}`;
    const existing = this.traces.get(key);

    if (existing) {
      // Cross-session confidence reinforcement (+0.08 when observed in a new session, capped at 1.0)
      if (!existing.sourceSessions.includes(params.sessionId)) {
        existing.sourceSessions.push(params.sessionId);
        existing.confidence = Math.min(1.0, Number((existing.confidence + 0.08).toFixed(4)));
      }
      existing.lastAccessedAtMs = nowMs;
      if (typeof params.emotionalWeight === "number") {
        existing.emotionalWeight = Math.max(existing.emotionalWeight, params.emotionalWeight);
      }
      return { ...existing, sourceSessions: [...existing.sourceSessions] };
    }

    const trace: MemoirTrace = {
      key,
      category: params.category,
      content: cleanContent,
      confidence: params.initialConfidence ?? 0.65,
      accessCount: 0,
      createdAtMs: nowMs,
      lastAccessedAtMs: nowMs,
      sourceSessions: [params.sessionId],
      emotionalWeight: params.emotionalWeight ?? 0.5,
    };
    this.traces.set(key, trace);
    return { ...trace, sourceSessions: [...trace.sourceSessions] };
  }

  getTrace(category: MemoryCategory, content: string): MemoirTrace | undefined {
    const t = this.traces.get(`${category}:${content.trim()}`);
    return t ? { ...t, sourceSessions: [...t.sourceSessions] } : undefined;
  }

  allTraces(): MemoirTrace[] {
    return [...this.traces.values()].map((t) => ({ ...t, sourceSessions: [...t.sourceSessions] }));
  }

  // Hybrid retrieval: combines lexical overlap with MemoirAI's (0.7*importance + 0.3*recency) prior.
  retrieveRelevant(query: string, nowMs = Date.now(), topK = 8): Array<{ trace: MemoirTrace; score: number }> {
    const qTokens = (query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((t) => t.length >= 2);
    const scored: Array<{ trace: MemoirTrace; score: number }> = [];

    for (const trace of this.traces.values()) {
      const prior = computeMemoirScore(trace, nowMs);
      let lexical = 0;
      if (qTokens.length > 0) {
        const lower = trace.content.toLowerCase();
        const hits = qTokens.filter((t) => lower.includes(t)).length;
        lexical = hits / qTokens.length;
      }
      const combined = qTokens.length > 0 ? 0.55 * lexical + 0.45 * prior : prior;
      scored.push({
        trace: { ...trace, sourceSessions: [...trace.sourceSessions] },
        score: Number(combined.toFixed(4)),
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const selected = scored.slice(0, topK);
    for (const item of selected) {
      const ref = this.traces.get(item.trace.key);
      if (ref) {
        ref.accessCount++;
        ref.lastAccessedAtMs = nowMs;
      }
    }
    return selected;
  }

  // Port of MemoirAI's AgentMemory.build_triggers:
  // Surfaces up to maxTriggers high-importance memories (importance >= minImportance)
  // that are NOT already mentioned in currentContextText and have accessCount < maxAccessCap (default 15).
  buildProactiveTriggers(
    currentContextText: string,
    nowMs = Date.now(),
    opts: { maxTriggers?: number; minImportance?: number; maxAccessCap?: number } = {},
  ): Array<{ trace: MemoirTrace; importance: number; score: number; promptHint: string }> {
    const maxTriggers = opts.maxTriggers ?? 2;
    const minImportance = opts.minImportance ?? 0.6;
    const maxAccessCap = opts.maxAccessCap ?? 15;
    const lowerCtx = currentContextText.toLowerCase();

    const candidates: Array<{ trace: MemoirTrace; importance: number; score: number }> = [];
    for (const trace of this.traces.values()) {
      // Hard retirement cap: never proactively nag about a memory accessed >= 15 times
      if (trace.accessCount >= maxAccessCap) continue;
      // Skip if already mentioned in current context (literal substring or >=50% significant token overlap)
      const lowerContent = trace.content.toLowerCase();
      if (lowerCtx.includes(lowerContent)) continue;
      const sigTokens = (lowerContent.match(/[\p{L}\p{N}_#-]{4,}/gu) ?? []).filter(
        (t) => !["before", "after", "about", "their", "there", "where", "which"].includes(t),
      );
      if (sigTokens.length > 0) {
        const matchedCount = sigTokens.filter((t) => lowerCtx.includes(t)).length;
        if (matchedCount / sigTokens.length >= 0.5) continue;
      }

      const importance = computeMemoirImportance(trace);
      if (importance < minImportance) continue;
      const score = computeMemoirScore(trace, nowMs);
      candidates.push({ trace, importance, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    const chosen = candidates.slice(0, maxTriggers);

    return chosen.map(({ trace, importance, score }) => {
      trace.accessCount++;
      trace.lastAccessedAtMs = nowMs;
      return {
        trace: { ...trace, sourceSessions: [...trace.sourceSessions] },
        importance: Number(importance.toFixed(4)),
        score: Number(score.toFixed(4)),
        promptHint: `[Proactive Recall (${trace.category})]: "${trace.content}" (confidence=${trace.confidence.toFixed(2)}, importance=${importance.toFixed(2)})`,
      };
    });
  }
}

// Port of xybruceliu/thoughtful-agents/thoughtful_agents/utils/saliency.py:
// Saliency(k) = max(b * sim_interp, c * sim_text) * w * gamma^(deltaTurns)
export interface TurnSaliencyInput {
  interpretationSimilarity: number; // 0..1
  verbatimTextSimilarity: number; // 0..1
  importanceWeight: number; // w (e.g. 0..1 or 1..10 normalized)
  turnsElapsed: number; // delta t >= 0
  b?: number; // default 0.45
  c?: number; // default 0.55
  gamma?: number; // default 0.90
}

export function computeTurnDecayedSaliency({
  interpretationSimilarity,
  verbatimTextSimilarity,
  importanceWeight,
  turnsElapsed,
  b = 0.45,
  c = 0.55,
  gamma = 0.9,
}: TurnSaliencyInput): number {
  const simTerm = Math.max(b * interpretationSimilarity, c * verbatimTextSimilarity);
  const decay = Math.pow(gamma, Math.max(0, turnsElapsed));
  return Number((simTerm * importanceWeight * decay).toFixed(6));
}

// Port of xybruceliu/thoughtful-agents 5-factor intrinsic motivation gate (1.0 .. 5.0 scale):
export interface IntrinsicMotivationFactors {
  relevance: number; // 1..5: how relevant is the thought/recall to the current context
  informationGap: number; // 1..5: does it fill a genuine gap the user doesn't currently see
  impact: number; // 1..5: how much time/effort does it save
  urgency: number; // 1..5: is it time-sensitive right now
  coherence: number; // 1..5: does it fit naturally without derailing the user's flow
}

export function evaluateIntrinsicMotivation(
  factors: IntrinsicMotivationFactors,
  threshold = 3.5,
): { shouldProact: boolean; score: number; reason: string } {
  const clamp = (v: number) => Math.max(1, Math.min(5, v));
  const r = clamp(factors.relevance);
  const g = clamp(factors.informationGap);
  const i = clamp(factors.impact);
  const u = clamp(factors.urgency);
  const c = clamp(factors.coherence);

  const score = Number(((r * 0.25 + g * 0.25 + i * 0.2 + u * 0.15 + c * 0.15)).toFixed(3));
  const shouldProact = score >= threshold && r >= 3 && g >= 3;
  return {
    shouldProact,
    score,
    reason: shouldProact
      ? `intrinsic motivation ${score} >= ${threshold}`
      : `suppressed: score=${score} (threshold=${threshold}, relevance=${r}, gap=${g})`,
  };
}

// Port of 030603-ccf/MemoirAI/backend/core/hallucination_guard.py:
// Deterministic entity extractor and faithfulness verifier against source texts.
export interface EntityVerificationResult {
  passed: boolean;
  faithfulnessScore: number; // 1.0 when all extracted entities exist in sources
  extractedEntities: string[];
  verifiedEntities: string[];
  hallucinatedEntities: string[];
}

const STOPWORD_PROPER = new Set([
  "The",
  "This",
  "That",
  "These",
  "Those",
  "When",
  "Where",
  "What",
  "Why",
  "How",
  "If",
  "In",
  "On",
  "At",
  "For",
  "To",
  "From",
  "With",
  "By",
  "And",
  "But",
  "Or",
  "Note",
  "Warning",
  "Error",
  "Source",
  "Recall",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]);

export function extractStructuredEntities(text: string): string[] {
  const entities = new Set<string>();

  // 1. CLI flags (e.g. --wasm-tier-up=false, --jitless)
  for (const m of text.match(/--[a-zA-Z0-9][a-zA-Z0-9_=-]*/g) ?? []) {
    entities.add(m);
  }

  // 2. Quoted literals ("..." or `...`) at least 3 chars
  for (const m of text.matchAll(/["`']([^"`'\r\n]{3,80})["`']/g)) {
    if (m[1]) entities.add(m[1].trim());
  }

  // 3. File paths and URLs
  for (const m of text.match(/(?:https?:\/\/[^\s)"'`]+|(?:\/|src\/|test\/|lib\/)[a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)/g) ?? []) {
    entities.add(m);
  }

  // 4. Capitalized multi-word proper nouns or camelCase/PascalCase identifiers
  for (const m of text.match(/\b[A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*\b/g) ?? []) {
    if (!STOPWORD_PROPER.has(m) && m.length >= 3) {
      entities.add(m);
    }
  }

  // 5. Specific numeric figures with units/currency/dates (e.g. $450, 2026-10-28, 91.28%)
  for (const m of text.match(/(?:\$\d[\d,.]*|\b\d{4}-\d{2}-\d{2}\b|\b\d+(?:\.\d+)?%)/g) ?? []) {
    entities.add(m);
  }

  return [...entities];
}

export function verifyEntitiesAgainstSources(
  generatedText: string,
  sourceTexts: ReadonlyArray<string>,
): EntityVerificationResult {
  const extractedEntities = extractStructuredEntities(generatedText);
  if (extractedEntities.length === 0) {
    return {
      passed: true,
      faithfulnessScore: 1.0,
      extractedEntities: [],
      verifiedEntities: [],
      hallucinatedEntities: [],
    };
  }

  const combinedLower = sourceTexts.join("\n").toLowerCase();
  const verifiedEntities: string[] = [];
  const hallucinatedEntities: string[] = [];

  for (const entity of extractedEntities) {
    if (combinedLower.includes(entity.toLowerCase())) {
      verifiedEntities.push(entity);
    } else {
      hallucinatedEntities.push(entity);
    }
  }

  const faithfulnessScore = Number((verifiedEntities.length / extractedEntities.length).toFixed(4));
  return {
    passed: hallucinatedEntities.length === 0,
    faithfulnessScore,
    extractedEntities,
    verifiedEntities,
    hallucinatedEntities,
  };
}
