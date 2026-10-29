// Runtime component interfaces from AGENTS.md sections 6.2, 7, and 9.
// Keep these definitions in sync with AGENTS.md.

export interface ContextWindow {
  endMs: number;
  eventIds: string[];
  workspacePath?: string;
}

export interface Anticipator {
  // Cheap; runs on every new context window.
  score(ctx: ContextWindow): { pSeek: number; horizonMs: number };
  // Above threshold: "what is the owner about to look for?"
  propose(ctx: ContextWindow): Array<{ query: string; searchers: string[] }>;
}

export type FreshnessStatus = "CURRENT" | "SUPERSEDED" | "UNKNOWN";

export interface Hit {
  quote: string; // verbatim from source
  sourceUri: string;
  eventId?: string;
  freshness: FreshnessStatus;
  freshnessCheck: string; // what was run, e.g. "git grep -- --jitless HEAD: 0 hits"
  charStart?: number;
  charEnd?: number;
}

export type SearcherId = "fts_events" | "git_pickaxe" | "repo_grep" | "sessions" | "web";

export interface Searcher {
  id: string; // "fts_events" | "git_pickaxe" | "repo_grep" | "sessions" | "web"
  external: boolean; // true => query leaves the machine; section 4 rules apply
  search(query: string, asOfMs: number): Promise<Hit[]>; // asOfMs is mandatory, see section 8
}

export interface Surfacer {
  // value = relevance x novelty x lead time - interruption cost
  decide(ctx: ContextWindow, hits: Hit[]): { action: "SURFACE" | "HOLD" | "SILENT"; reason: string };
}

export interface WorkspaceSink {
  write(workspacePath: string, hits: Hit[], reason: string): Promise<void>; // .gadget/brief.md, MCP
}

export interface Evidence {
  sourceEventId: string;
  quote: string;
  charStart: number;
  charEnd: number;
}

export interface Claim {
  text: string;
  evidence: Evidence[]; // empty => cannot be surfaced
}

export type Verdict =
  | { kind: "GOOD" }
  | { kind: "WRONG_FACT"; note: string } // fabricated or incorrect
  | { kind: "STALE"; note: string } // already resolved
  | { kind: "SHOULD_STAY_SILENT"; note: string }
  | { kind: "MISSED"; note: string }; // owner was stuck, system said nothing
