// Runtime Searchers (AGENTS.md sections 4, 6.2, and 8).
// Every searcher requires an explicit `asOfMs` cutoff so evaluations never leak future data.

import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ftsMatch, keyTokens } from "../miner/ceiling.js";
import { assertOutsideRepo } from "../miner/paths.js";
import { parseReflog } from "../miner/parsers/git.js";
import type { EventStore } from "../miner/store.js";
import type { EpisodicEvent, Source } from "../miner/types.js";
import type { FreshnessStatus, Hit, Searcher } from "./types.js";

export function assertValidAsOf(asOfMs: number): void {
  if (typeof asOfMs !== "number" || !Number.isFinite(asOfMs) || asOfMs <= 0) {
    throw new Error(`Searcher requires a finite positive asOfMs cutoff; got ${String(asOfMs)}`);
  }
}

// Finds a verbatim quote window around the first matching token inside contentText,
// returning exact [charStart, charEnd) character offsets so verifyClaim succeeds.
export function extractVerbatimQuote(
  contentText: string,
  tokens: string[],
  maxLen = 240,
): { quote: string; charStart: number; charEnd: number } {
  const lower = contentText.toLowerCase();
  let matchIdx = -1;
  for (const t of tokens) {
    const idx = lower.indexOf(t.toLowerCase());
    if (idx >= 0 && (matchIdx < 0 || idx < matchIdx)) {
      matchIdx = idx;
    }
  }
  if (matchIdx < 0) {
    const end = Math.min(contentText.length, maxLen);
    return { quote: contentText.slice(0, end), charStart: 0, charEnd: end };
  }
  const half = Math.floor(maxLen / 2);
  const start = Math.max(0, matchIdx - half);
  const end = Math.min(contentText.length, start + maxLen);
  return {
    quote: contentText.slice(start, end),
    charStart: start,
    charEnd: end,
  };
}

// Checks whether a hit from an event strictly before asOfMs is still CURRENT at asOfMs.
export function checkEventFreshness(
  ev: EpisodicEvent,
  _tokens: string[],
  _store: EventStore,
  asOfMs: number,
  workspacePath?: string,
): { freshness: FreshnessStatus; freshnessCheck: string } {
  const flagMatch = /--[a-z0-9][a-z0-9_-]*/i.exec(ev.contentText);

  if (flagMatch && workspacePath && existsSync(workspacePath)) {
    const flag = flagMatch[0]!;
    const commit = commitBefore(workspacePath, asOfMs);
    if (!commit) {
      // No HEAD reflog entry before asOfMs: the checkout at that moment is unknown, so
      // nothing was checked and the hit cannot be called CURRENT.
      return { freshness: "UNKNOWN", freshnessCheck: `no HEAD reflog entry before asOfMs=${asOfMs}: repo state unknown` };
    }
    const hits = gitGrepCount(workspacePath, commit, flag);
    const checkDesc = `git grep -- ${flag} ${commit.slice(0, 7)}: ${hits} hits`;
    return { freshness: "CURRENT", freshnessCheck: checkDesc };
  }

  return {
    freshness: "CURRENT",
    freshnessCheck: `store_cutoff_verified(ts=${ev.timestampMs} < asOfMs=${asOfMs}): CURRENT`,
  };
}

function searchStoreBySources(
  store: EventStore,
  query: string,
  asOfMs: number,
  sources: Source[] | null,
  limit = 5,
  workspacePath?: string,
): Hit[] {
  assertValidAsOf(asOfMs);
  const inferredKind = query.trim().split(/\s+/).length > 3 ? "ASK_AGENT" : "GREP";
  const tokens = keyTokens(query, inferredKind);
  if (tokens.length === 0) return [];
  const match = ftsMatch(tokens);
  if (!match) return [];

  const sourceClause =
    sources && sources.length > 0 ? `AND e.source IN (${sources.map(() => "?").join(", ")})` : "";
  const sql = `
    SELECT e.event_id AS event_id, e.source AS source, e.timestamp_ms AS timestamp_ms,
           e.workspace_path AS workspace_path, e.content_text AS content_text,
           e.source_uri AS source_uri, e.metadata_json AS metadata_json
      FROM events_fts
      JOIN events e ON e.event_id = events_fts.event_id
     WHERE events_fts MATCH ?
       AND e.timestamp_ms < ?
       AND e.is_seek = 0
       ${sourceClause}
     ORDER BY bm25(events_fts)
     LIMIT ?
  `;
  const params: Array<string | number> = [match, asOfMs, ...(sources ?? []), limit];
  const rows = store.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const ev: EpisodicEvent = {
      eventId: r.event_id as string,
      source: r.source as Source,
      timestampMs: r.timestamp_ms as number,
      workspacePath: typeof r.workspace_path === "string" ? r.workspace_path : undefined,
      contentText: r.content_text as string,
      sourceUri: r.source_uri as string,
      metadataJson: r.metadata_json as string,
    };
    const { quote, charStart, charEnd } = extractVerbatimQuote(ev.contentText, tokens);
    const { freshness, freshnessCheck } = checkEventFreshness(ev, tokens, store, asOfMs, workspacePath);
    return {
      quote,
      sourceUri: ev.sourceUri,
      eventId: ev.eventId,
      freshness,
      freshnessCheck,
      charStart,
      charEnd,
    };
  });
}

export class FtsEventsSearcher implements Searcher {
  readonly id = "fts_events";
  readonly external = false;

  constructor(
    private readonly store: EventStore,
    private readonly workspacePath?: string,
  ) {}

  async search(query: string, asOfMs: number): Promise<Hit[]> {
    return searchStoreBySources(this.store, query, asOfMs, null, 5, this.workspacePath);
  }
}

export class SessionsSearcher implements Searcher {
  readonly id = "sessions";
  readonly external = false;

  constructor(
    private readonly store: EventStore,
    private readonly workspacePath?: string,
  ) {}

  async search(query: string, asOfMs: number): Promise<Hit[]> {
    return searchStoreBySources(
      this.store,
      query,
      asOfMs,
      ["codex_session", "antigravity_session"],
      5,
      this.workspacePath,
    );
  }
}

export class GitPickaxeSearcher implements Searcher {
  readonly id = "git_pickaxe";
  readonly external = false;

  constructor(
    private readonly store: EventStore,
    private readonly workspacePath?: string,
  ) {}

  async search(query: string, asOfMs: number): Promise<Hit[]> {
    return searchStoreBySources(this.store, query, asOfMs, ["git"], 5, this.workspacePath);
  }
}

export class RepoGrepSearcher implements Searcher {
  readonly id = "repo_grep";
  readonly external = false;

  constructor(
    private readonly store: EventStore,
    private readonly workspacePath?: string,
  ) {}

  async search(query: string, asOfMs: number): Promise<Hit[]> {
    assertValidAsOf(asOfMs);
    if (!this.workspacePath || !existsSync(this.workspacePath)) return [];
    const tokens = keyTokens(query, "GREP");
    const primary = tokens[0] ?? query.trim().split(/\s+/)[0];
    if (!primary) return [];
    const commit = commitBefore(this.workspacePath, asOfMs);
    if (!commit) return [];
    const matches = gitGrepMatches(this.workspacePath, commit, primary, 5);
    return matches.map((m) => ({
      quote: m.lineText,
      sourceUri: `git:${this.workspacePath}@${commit}:${m.file}:${m.line}`,
      freshness: "CURRENT",
      freshnessCheck: `git grep -n -F -- ${primary} ${commit.slice(0, 7)}: matched ${m.file}:${m.line}`,
    }));
  }
}

export interface OutboundPolicy {
  publicTokens: ReadonlySet<string>;
  privateTokens?: ReadonlySet<string>;
  outboxPath?: string;
}

export interface OutboundFilterResult {
  allowed: boolean;
  sanitizedQuery: string;
  droppedTokens: string[];
  reason: string;
}

// Section 4: A web search or external API query may contain only tokens that appear in
// public sources. Anything with private names, repo names, people, paths, or internal
// flags is dropped and goes to the outbox for the owner.
const PRIVATE_TOKEN_PATTERN =
  /^(\/|~\/|\.\.?\/)|@[a-z0-9._-]+|\b(users|home|mac|private|internal|secret|corp|local)\b/i;

export function filterOutboundQuery(query: string, policy: OutboundPolicy): OutboundFilterResult {
  const rawTokens = query.match(/[\p{L}\p{N}._/-]+/gu) ?? [];
  if (rawTokens.length === 0) {
    return { allowed: false, sanitizedQuery: "", droppedTokens: [], reason: "empty query" };
  }
  const kept: string[] = [];
  const dropped: string[] = [];

  for (const raw of rawTokens) {
    const clean = raw.replace(/^[-_./]+|[-_./]+$/g, "").toLowerCase();
    if (!clean) continue;
    const isExplicitlyPrivate =
      PRIVATE_TOKEN_PATTERN.test(raw) ||
      (policy.privateTokens?.has(clean) ?? false) ||
      (policy.privateTokens?.has(raw.toLowerCase()) ?? false);
    const isPublic = policy.publicTokens.has(clean) || policy.publicTokens.has(raw.toLowerCase());
    if (isExplicitlyPrivate || !isPublic) {
      dropped.push(raw);
    } else {
      kept.push(raw);
    }
  }

  if (dropped.length > 0 || kept.length === 0) {
    return {
      allowed: false,
      sanitizedQuery: kept.join(" "),
      droppedTokens: dropped,
      reason: `blocked private/unverified tokens: ${dropped.join(", ")}`,
    };
  }

  return {
    allowed: true,
    sanitizedQuery: kept.join(" "),
    droppedTokens: [],
    reason: "all tokens verified in public allowlist",
  };
}

export class WebPublicSearcher implements Searcher {
  readonly id = "web";
  readonly external = true;

  constructor(
    private readonly policy: OutboundPolicy,
    private readonly provider?: (sanitizedQuery: string, asOfMs: number) => Promise<Hit[]>,
  ) {}

  async search(query: string, asOfMs: number): Promise<Hit[]> {
    assertValidAsOf(asOfMs);
    const check = filterOutboundQuery(query, this.policy);
    if (!check.allowed) {
      if (this.policy.outboxPath) {
        assertOutsideRepo(this.policy.outboxPath, "the outbound outbox");
        mkdirSync(dirname(this.policy.outboxPath), { recursive: true, mode: 0o700 });
        const line =
          JSON.stringify({
            atMs: asOfMs,
            originalQuery: query,
            sanitizedQuery: check.sanitizedQuery,
            droppedTokens: check.droppedTokens,
            reason: check.reason,
          }) + "\n";
        appendFileSync(this.policy.outboxPath, line, { mode: 0o600 });
        chmodSync(this.policy.outboxPath, 0o600);
      }
      return [];
    }
    if (!this.provider) return [];
    const hits = await this.provider(check.sanitizedQuery, asOfMs);
    return hits.filter((h) => h.freshness === "CURRENT");
  }
}

// The commit HEAD pointed at just before asOfMs, from HEAD's reflog (local checkout,
// commit, reset, and pull times). Not `rev-list --before`: that picks by committer time,
// and a fetch can bring in commits with committer times long before they were here.
// Before the oldest reflog entry the state is unknown, so nothing is returned.
function commitBefore(repo: string, asOfMs: number): string | null {
  try {
    const out = execFileSync(
      "git",
      ["--no-optional-locks", "-C", repo, "log", "-g", "--date=unix", "--format=%H\u001f%gD", "HEAD"],
      // An active repo's HEAD reflog can pass the 1 MiB default and fail with ENOBUFS.
      { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] },
    );
    const before = parseReflog(out).filter((e) => e.atMs < asOfMs);
    return before.at(-1)?.sha ?? null;
  } catch {
    return null;
  }
}

function gitGrepCount(repo: string, commit: string, needle: string): number {
  try {
    const out = execFileSync(
      "git",
      ["--no-optional-locks", "-C", repo, "grep", "-c", "-I", "-F", "--", needle, commit],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!out) return 0;
    return out
      .split("\n")
      .map((l) => Number(l.split(":").at(-1) ?? 0))
      .reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  } catch {
    return 0;
  }
}

function gitGrepMatches(
  repo: string,
  commit: string,
  needle: string,
  limit: number,
): Array<{ file: string; line: number; lineText: string }> {
  try {
    const out = execFileSync(
      "git",
      ["--no-optional-locks", "-C", repo, "grep", "-n", "-I", "-F", "--", needle, commit],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!out) return [];
    const results: Array<{ file: string; line: number; lineText: string }> = [];
    for (const raw of out.split("\n")) {
      if (results.length >= limit) break;
      // format: <commit>:<file>:<line>:<content>
      const first = raw.indexOf(":");
      const second = first >= 0 ? raw.indexOf(":", first + 1) : -1;
      const third = second >= 0 ? raw.indexOf(":", second + 1) : -1;
      if (first < 0 || second < 0 || third < 0) continue;
      const file = raw.slice(first + 1, second);
      const line = Number(raw.slice(second + 1, third));
      const lineText = raw.slice(third + 1).trim();
      if (file && Number.isInteger(line) && lineText) {
        results.push({ file, line, lineText });
      }
    }
    return results;
  } catch {
    return [];
  }
}
