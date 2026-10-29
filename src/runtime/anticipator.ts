// Anticipator (AGENTS.md section 6.2 & Phase 1).
// Scores whether the owner is about to go looking for something from the current
// ContextWindow and proposes concrete queries + target searchers learned from history.

import { keyTokens } from "../miner/ceiling.js";
import { parseMeta } from "../miner/seek.js";
import type { EventStore } from "../miner/store.js";
import type { EpisodicEvent, SeekingEpisode } from "../miner/types.js";
import { detectInFlightCommitments } from "../triggers/desktop_activity_commitments.js";
import { extractGraphEntitiesFromEvent } from "../triggers/tgl_proactmem_eval.js";
import type { Anticipator, ContextWindow } from "./types.js";

const ERROR_SIGNAL =
  /\b(error|failed|failure|exception|unrecognized|unknown option|invalid|cannot find|not found|undefined|enoent|eperm|eacces|segfault|panic)\b/i;
const FLAG_SIGNAL = /--[a-z0-9][a-z0-9_-]{2,}/gi;
const IDENTIFIER_SIGNAL = /\b[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+\b/gi;
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const NOISE_IDENTIFIERS = new Set([
  "auto-sync",
  "remote-tracking",
  "signed-off-by",
  "co-authored-by",
  "skip-ci",
  "no-op",
  "on-device",
  "run-as",
  "start-address",
  "stop-address",
  "re-armed",
  "session-end",
  "double-checked",
  "long-running",
  "high-res",
  "app-store-quality",
  "feature-wise",
  "technical-wise",
  "entry-level",
  "first-pass",
  "right-click",
  "cross-origin",
  "multi-runtime",
  "reparented-only",
]);

const GENERIC_COMMANDS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "run",
  "test",
  "build",
  "install",
  "make",
  "cargo",
  "go",
  "git",
  "node",
  "python",
  "pytest",
  "vim",
  "nvim",
  "code",
  "cat",
  "echo",
  "cd",
  "ls",
]);

export interface EpisodeLabel {
  realSeeking: boolean;
  answerInData?: boolean;
}

export interface AnticipatorOptions {
  threshold?: number;
  defaultHorizonMs?: number;
  priorEpisodes?: SeekingEpisode[];
  episodeLabels?: ReadonlyMap<string, EpisodeLabel>;
}

export class CalibratedAnticipator implements Anticipator {
  readonly threshold: number;
  readonly defaultHorizonMs: number;
  private readonly priorEpisodes: SeekingEpisode[];
  private readonly episodeLabels: ReadonlyMap<string, EpisodeLabel>;
  private readonly precomputedEpisodeTokens: Array<{
    episodeId: string;
    seekStartMs: number;
    tokens: string[];
    contextTokens: string[];
    realSeeking: boolean;
  }>;

  constructor(
    private readonly store: EventStore,
    opts: AnticipatorOptions = {},
  ) {
    this.threshold = opts.threshold ?? 0.45;
    this.defaultHorizonMs = opts.defaultHorizonMs ?? 5 * 60 * 1000;
    this.priorEpisodes = opts.priorEpisodes ?? [];
    this.episodeLabels = opts.episodeLabels ?? new Map();
    this.precomputedEpisodeTokens = this.priorEpisodes.map((ep) => {
      const label = this.episodeLabels.get(ep.episodeId);
      const ctxTokens: string[] = [];
      for (const id of ep.contextEventIds) {
        const ev = this.store.getEventById(id);
        if (ev) ctxTokens.push(...keyTokens(ev.contentText, "ASK_AGENT"));
      }
      for (const a of ep.seekActions) {
        ctxTokens.push(...keyTokens(a.query, a.kind));
      }
      return {
        episodeId: ep.episodeId,
        seekStartMs: ep.seekStartMs,
        tokens: ep.seekActions.flatMap((a) => keyTokens(a.query, a.kind)),
        contextTokens: [...new Set(ctxTokens)],
        realSeeking: label ? label.realSeeking : true,
      };
    });
  }

  score(ctx: ContextWindow): { pSeek: number; horizonMs: number } {
    const events = this.loadWindowEvents(ctx);
    if (events.length === 0) return { pSeek: 0, horizonMs: this.defaultHorizonMs };

    // ProAgent / OpenChronicle passive-sensory gate: if the window contains ONLY passive
    // background screen OCR or audio STT frames (with no interactive session, shell, browser,
    // clipboard, or git events and no commitments), suppress proactive firing.
    const hasInteractiveEvent = events.some(
      (e) =>
        e.source !== "screen" &&
        e.source !== "audio" &&
        !(e.source === "git" && /auto-sync live A2A|refresh live node quotes/i.test(e.contentText)),
    );
    if (!hasInteractiveEvent) {
      return { pSeek: 0.05, horizonMs: this.defaultHorizonMs };
    }

    let logit = -1.6; // base prior: most windows do not precede seeking
    let hasFailure = false;
    let hasUserTurn = false;
    let hasAssistantTurn = false;
    let hasToolCommand = false;
    let hasCommitment = false;
    let hasActiveRepoCommit = false;
    let hasUserOrShellError = false;
    let hasSpecificToken = false;
    let hasHistoricalTrigger = false;
    let learnedLogOddsDelta = 0;

    const historicalTriggerTokens = this.learnedTriggerTokensBefore(ctx.endMs);
    const tokenLogOdds = this.learnedTokenLogOddsBefore(ctx.endMs);
    const seenWindowTokens = new Set<string>();

    for (const ev of events) {
      if (ev.source === "screen" || ev.source === "audio") continue;
      const meta = parseMeta(ev.metadataJson);
      if (meta.role === "user") hasUserTurn = true;
      if (meta.role === "assistant") hasAssistantTurn = true;
      if (meta.kind === "tool_command" || ev.source === "zsh" || ev.source === "zsh_hook") {
        hasToolCommand = true;
      }
      if (
        ev.source === "git" &&
        !/auto-sync live A2A|refresh live node quotes/i.test(ev.contentText)
      ) {
        hasActiveRepoCommit = true;
      }
      if (
        (meta.role === "user" || ev.source === "clipboard") &&
        detectInFlightCommitments(ev.contentText).length > 0
      ) {
        hasCommitment = true;
      }

      if (typeof meta.exit === "number" && meta.exit !== 0) {
        hasFailure = true;
      }
      if (meta.role !== "assistant" && ERROR_SIGNAL.test(ev.contentText)) {
        hasUserOrShellError = true;
      }
      const flags = ev.contentText.match(FLAG_SIGNAL) ?? [];
      const ids = (ev.contentText.match(IDENTIFIER_SIGNAL) ?? []).filter(
        (id) => !UUID_PATTERN.test(id) && !NOISE_IDENTIFIERS.has(id.toLowerCase()),
      );
      if (flags.length > 0 || ids.length > 0) {
        hasSpecificToken = true;
      }
      const tokens = keyTokens(ev.contentText, "ASK_AGENT");
      if (tokens.some((t) => historicalTriggerTokens.has(t))) {
        hasHistoricalTrigger = true;
      }
      for (const t of tokens) {
        if (!seenWindowTokens.has(t)) {
          seenWindowTokens.add(t);
          learnedLogOddsDelta += tokenLogOdds.get(t) ?? 0;
        }
      }
    }

    if (hasFailure) logit += 1.9;
    if (hasUserOrShellError) logit += 0.9;
    if (hasUserTurn && hasAssistantTurn) logit += 1.5;
    else if (hasUserTurn || hasAssistantTurn || hasToolCommand) logit += 1.45;
    else if (hasActiveRepoCommit) logit += 1.45;
    if (hasCommitment) logit += 0.8;
    if (hasSpecificToken && (hasFailure || hasUserTurn || hasAssistantTurn || hasToolCommand || hasActiveRepoCommit)) {
      logit += 0.5;
    }
    if (hasHistoricalTrigger && (hasFailure || hasUserTurn || hasAssistantTurn || hasToolCommand || hasActiveRepoCommit)) {
      logit += 0.5;
    }
    logit += Math.max(-2.5, Math.min(2.5, learnedLogOddsDelta));

    const pSeek = Number((1 / (1 + Math.exp(-logit))).toFixed(4));
    return { pSeek, horizonMs: this.defaultHorizonMs };
  }

  propose(ctx: ContextWindow): Array<{ query: string; searchers: string[] }> {
    const { pSeek } = this.score(ctx);
    if (pSeek < this.threshold) return [];

    const events = this.loadWindowEvents(ctx);
    const searchers = this.rankSearchersBefore(ctx.endMs);
    const candidates: string[] = [];
    const seen = new Set<string>();

    const addCandidate = (q: string) => {
      const norm = q.trim().toLowerCase();
      if (
        norm.length < 3 ||
        GENERIC_COMMANDS.has(norm) ||
        NOISE_IDENTIFIERS.has(norm) ||
        UUID_PATTERN.test(norm) ||
        seen.has(norm)
      ) {
        return;
      }
      seen.add(norm);
      candidates.push(norm);
    };

    // Filter out background cron git commits and passive sensory frames
    const activeEvents = events.filter(
      (e) =>
        e.source !== "screen" &&
        e.source !== "audio" &&
        !(e.source === "git" && /auto-sync live A2A|refresh live node quotes/i.test(e.contentText)),
    );

    // 1. Prioritize non-git interactive events (user turns, failed/tool commands, shell commands, assistant turns)
    //    before background git commits.
    const nonGit = activeEvents.filter((e) => e.source !== "git");
    const gitOnly = activeEvents.filter((e) => e.source === "git");
    const prioritized = [
      ...[...nonGit].reverse().filter((e) => parseMeta(e.metadataJson).role !== "assistant"),
      ...[...nonGit].reverse().filter((e) => parseMeta(e.metadataJson).role === "assistant"),
      ...[...gitOnly].reverse(),
    ];

    // 1a. In-flight commitments & structured list items (ProMemAgent / MineContext / ideation.md)
    for (const ev of prioritized) {
      for (const c of detectInFlightCommitments(ev.contentText).slice(0, 4)) {
        addCandidate(c.prefetchQuery);
      }
    }

    // 1b. CLI flags and clean technical identifiers + TGL entities
    for (const ev of prioritized) {
      for (const flag of ev.contentText.match(FLAG_SIGNAL) ?? []) {
        addCandidate(flag.replace(/^--+/, ""));
      }
      for (const id of ev.contentText.match(IDENTIFIER_SIGNAL) ?? []) {
        if (!UUID_PATTERN.test(id) && !NOISE_IDENTIFIERS.has(id.toLowerCase())) {
          addCandidate(id);
        }
      }
      // File basenames and proper-noun entities from TGL entity extractor
      for (const ent of extractGraphEntitiesFromEvent(ev)) {
        if (ent.kind === "file") {
          const base = ent.value.split("/").at(-1)?.replace(/\.[a-z0-9]+$/i, "") ?? "";
          if (base.length >= 4) addCandidate(base);
        } else if (ent.kind === "person_or_org") {
          addCandidate(ent.value);
        }
      }
    }

    // 2. If a command failed (e.g. `npm run build` in `/w/vitre`), check if earlier commits/sessions
    //    in the same workspace or with the same command tokens before ctx.endMs mention a flag or fix.
    for (const ev of prioritized) {
      const meta = parseMeta(ev.metadataJson);
      const isFailed = typeof meta.exit === "number" && meta.exit !== 0;
      const workspace = ctx.workspacePath ?? ev.workspacePath;
      if (isFailed && workspace) {
        for (const q of this.workspaceHistoryTokens(workspace, ev.contentText, ctx.endMs)) {
          addCandidate(q);
        }
      }
      const askToks = keyTokens(ev.contentText, "ASK_AGENT").filter(
        (t) => !GENERIC_COMMANDS.has(t) && !NOISE_IDENTIFIERS.has(t) && !UUID_PATTERN.test(t),
      );
      if (askToks.length >= 2) {
        addCandidate(askToks.slice(0, 2).join(" "));
      }
      for (const tok of askToks.slice(0, 3)) {
        if (tok.length >= 4) addCandidate(tok);
      }
      const grepToks = keyTokens(ev.contentText, "GREP").filter(
        (t) => !GENERIC_COMMANDS.has(t) && !NOISE_IDENTIFIERS.has(t) && !UUID_PATTERN.test(t) && !/^\d+$/.test(t),
      );
      for (const tok of grepToks.slice(0, 3)) {
        if (tok.length >= 4) addCandidate(tok);
      }
    }

    // 3. Same-conversation continuity (TGL session thread routing): if an antigravity_session or
    //    codex_session is active, pull key tokens from recent turns in that same session file before ctx.endMs.
    const sessionEv = nonGit.find(
      (e) => e.source === "antigravity_session" || e.source === "codex_session",
    );
    if (sessionEv) {
      const sessionFile = sessionEv.sourceUri.split("#")[0];
      if (sessionFile) {
        for (const tok of this.sameSessionPriorTokens(sessionFile, ctx.endMs)) {
          addCandidate(tok);
        }
      }
    }

    // 4. Fallback: workspace basename if nothing more specific was in the command text.
    const ws = ctx.workspacePath ?? events.find((e) => e.workspacePath)?.workspacePath;
    if (candidates.length === 0 && ws) {
      const base = ws.split("/").filter(Boolean).at(-1);
      if (base && base.length >= 3) addCandidate(base);
    }

    return candidates.slice(0, 10).map((query) => ({ query, searchers }));
  }

  private loadWindowEvents(ctx: ContextWindow): EpisodicEvent[] {
    const out: EpisodicEvent[] = [];
    for (const id of ctx.eventIds) {
      const ev = this.store.getEventById(id);
      // Never read events after ctx.endMs.
      if (ev && ev.timestampMs <= ctx.endMs) out.push(ev);
    }
    return out;
  }

  private learnedTriggerTokensBefore(asOfMs: number): Set<string> {
    const out = new Set<string>();
    for (const ep of this.precomputedEpisodeTokens) {
      if (ep.seekStartMs >= asOfMs || !ep.realSeeking) continue;
      for (const t of ep.tokens) out.add(t);
    }
    return out;
  }

  // Laplace-smoothed log-odds learned from labeled episodes strictly before asOfMs.
  // Positive (`realSeeking: true`) vs negative (`realSeeking: false`) episodes shift
  // token weights without hand-written trigger rules.
  private learnedTokenLogOddsBefore(asOfMs: number): Map<string, number> {
    const posCounts = new Map<string, number>();
    const negCounts = new Map<string, number>();
    let posTotal = 0;
    let negTotal = 0;

    for (const ep of this.precomputedEpisodeTokens) {
      if (ep.seekStartMs >= asOfMs) continue;
      if (!this.episodeLabels.has(ep.episodeId)) continue;
      if (ep.realSeeking) {
        posTotal++;
        for (const t of ep.contextTokens) posCounts.set(t, (posCounts.get(t) ?? 0) + 1);
      } else {
        negTotal++;
        for (const t of ep.contextTokens) negCounts.set(t, (negCounts.get(t) ?? 0) + 1);
      }
    }

    const out = new Map<string, number>();
    if (posTotal === 0 && negTotal === 0) return out;
    const allTokens = new Set([...posCounts.keys(), ...negCounts.keys()]);
    for (const t of allTokens) {
      const pPos = ((posCounts.get(t) ?? 0) + 1) / (posTotal + 2);
      const pNeg = ((negCounts.get(t) ?? 0) + 1) / (negTotal + 2);
      out.set(t, Math.log(pPos / pNeg));
    }
    return out;
  }

  private rankSearchersBefore(asOfMs: number): string[] {
    const counts = new Map<string, number>([
      ["fts_events", 3],
      ["git_pickaxe", 2],
      ["sessions", 2],
      ["repo_grep", 1],
    ]);
    for (const ep of this.priorEpisodes) {
      if (ep.seekStartMs >= asOfMs) continue;
      const uri = ep.resolution?.sourceUri ?? "";
      if (uri.startsWith("git:")) counts.set("git_pickaxe", (counts.get("git_pickaxe") ?? 0) + 1);
      else if (uri.includes(".jsonl")) counts.set("sessions", (counts.get("sessions") ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }

  // Looks up tokens from non-seek events (e.g. git commits or coding sessions) strictly before
  // asOfMs that share the workspace or build/test tokens of a failing command.
  private workspaceHistoryTokens(workspacePath: string, cmdText: string, asOfMs: number): string[] {
    const base = workspacePath.split("/").filter(Boolean).at(-1) ?? "";
    const cmdTokens = keyTokens(cmdText, "GREP");
    const rows = this.store.db
      .prepare(
        `SELECT content_text, workspace_path
           FROM events
          WHERE timestamp_ms < ?
            AND is_seek = 0
            AND source IN ('git', 'codex_session', 'antigravity_session')
          ORDER BY timestamp_ms DESC
          LIMIT 50`,
      )
      .all(asOfMs) as Array<{ content_text: string; workspace_path: string | null }>;

    const found: string[] = [];
    for (const r of rows) {
      const sameWorkspace =
        r.workspace_path === workspacePath ||
        (base.length >= 3 && (r.workspace_path?.endsWith(`/${base}`) ?? false));
      const sharesCmdToken = cmdTokens.some((t) => r.content_text.toLowerCase().includes(t));
      if (!sameWorkspace && !sharesCmdToken) continue;
      for (const flag of r.content_text.match(FLAG_SIGNAL) ?? []) {
        found.push(flag.replace(/^--+/, ""));
      }
      for (const id of r.content_text.match(IDENTIFIER_SIGNAL) ?? []) {
        found.push(id);
      }
    }
    return found;
  }

  private sameSessionPriorTokens(sessionFile: string, asOfMs: number): string[] {
    const rows = this.store.db
      .prepare(
        `SELECT content_text
           FROM events
          WHERE timestamp_ms < ?
            AND source_uri LIKE ?
          ORDER BY timestamp_ms DESC
          LIMIT 12`,
      )
      .all(asOfMs, `${sessionFile}%`) as Array<{ content_text: string }>;

    const found: string[] = [];
    for (const r of rows) {
      for (const tok of keyTokens(r.content_text, "ASK_AGENT")) {
        if (tok.length >= 4 && !NOISE_IDENTIFIERS.has(tok) && !UUID_PATTERN.test(tok)) {
          found.push(tok);
        }
      }
    }
    return found;
  }
}
