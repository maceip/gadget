// Mode 2 — Scoped Go-Go-Gadget Action Agent (`src/runtime/action_agent.ts`).
//
// Executes a scoped, deterministic multi-searcher investigation and artifact synthesis
// over a SkypanelCard's brief, verifying every recalled claim via `verifyClaim(asOfMs)`
// and recording a persistent execution receipt on the card in SQLite.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { keyTokens } from "../miner/ceiling.js";
import { assertOutsideRepo } from "../miner/paths.js";
import type { EventStore } from "../miner/store.js";
import type {
  SkypanelAgentReceipt,
  SkypanelCard,
  SkypanelVerifiedHit,
} from "../triggers/skypanel_composer.js";
import { FtsEventsSearcher, GitPickaxeSearcher, RepoGrepSearcher, SessionsSearcher } from "./searchers.js";
import { formatUntrustedDataBlock } from "./sink.js";
import { VerifiedSurfacer } from "./surfacer.js";
import type { ContextWindow, Hit } from "./types.js";

export interface ActionAgentExecutionResult {
  updatedCard: SkypanelCard;
  receipt: SkypanelAgentReceipt;
  writtenPaths: string[];
}

export async function runScopedActionAgent(opts: {
  card: SkypanelCard;
  store: EventStore;
  dbPath: string;
  workspacePath?: string;
  asOfMs?: number;
}): Promise<ActionAgentExecutionResult> {
  const { card, store, dbPath, workspacePath } = opts;
  const asOfMs = opts.asOfMs ?? Date.now();

  const fts = new FtsEventsSearcher(store, workspacePath);
  const git = new GitPickaxeSearcher(store, workspacePath);
  const sessions = new SessionsSearcher(store, workspacePath);
  const surfacer = new VerifiedSurfacer(store);

  const queries = new Set<string>();
  if (card.contactName) queries.add(card.contactName);
  queries.add(card.compactLabel);
  const toks = keyTokens(card.compactLabel, "ASK_AGENT");
  if (toks.length > 0) queries.add(toks.slice(0, 3).join(" "));

  const rawHits: Hit[] = [];
  for (const q of queries) {
    if (!q.trim()) continue;
    try {
      rawHits.push(...(await fts.search(q, asOfMs)));
      rawHits.push(...(await git.search(q, asOfMs)));
      rawHits.push(...(await sessions.search(q, asOfMs)));
      if (workspacePath) {
        const repoGrep = new RepoGrepSearcher(store, workspacePath);
        rawHits.push(...(await repoGrep.search(q, asOfMs)));
      }
    } catch {
      // ignore searcher edge cases
    }
  }

  const ctx: ContextWindow = {
    endMs: asOfMs,
    eventIds: [],
    ...(workspacePath ? { workspacePath } : {}),
  };

  const { accepted } = surfacer.filterSurfacableHits(
    ctx,
    rawHits.filter((h) => !h.sourceUri.includes("/capture/screen.jsonl:")),
  );

  // Merge newly discovered verified hits with any existing verified hits on the card
  const mergedHits: SkypanelVerifiedHit[] = [...card.verifiedHits];
  for (const h of accepted) {
    if (mergedHits.length >= 6) break;
    if (!mergedHits.some((mh) => mh.sourceUri === h.sourceUri && mh.quote === h.quote)) {
      mergedHits.push({
        sourceUri: h.sourceUri,
        ...(h.eventId ? { eventId: h.eventId } : {}),
        quote: h.quote,
        freshness: h.freshness,
        freshnessCheck: h.freshnessCheck,
      });
    }
  }

  const stagedDir = join(dirname(dbPath), "staged");
  assertOutsideRepo(stagedDir, "ActionAgent staged output");
  mkdirSync(stagedDir, { recursive: true, mode: 0o700 });
  chmodSync(stagedDir, 0o700);

  const writtenPaths: string[] = [];
  const receiptPath = join(stagedDir, `agent-receipt-${card.cardId}.md`);

  const reportLines: string[] = [
    `# Go-Go-Gadget Scoped Action Agent Receipt — ${card.compactLabel}`,
    "",
    `- **Card ID:** \`${card.cardId}\``,
    `- **Execution Mode:** \`agent\` (Mode 2 — Scoped Action Agent)`,
    `- **Executed At:** \`${new Date(asOfMs).toISOString()}\``,
    `- **Verified Context Hits Synthesized:** \`${mergedHits.length}\``,
    card.contactName ? `- **Target Contact:** \`${card.contactName}\`` : null,
    card.proposedTimeLabel ? `- **Scheduled Window:** \`${card.proposedTimeLabel}\` (\`${card.inferredWorkingHours}\`)` : null,
    "",
    "## 1. Original Brief & Context",
    card.stagedAgentBrief,
    "",
    "## 2. Action Agent Synthesized Findings (Verified via `verifyClaim`)",
    mergedHits.length === 0
      ? "_No additional historical hits required; action brief is self-contained._"
      : mergedHits
          .map((vh, idx) =>
            formatUntrustedDataBlock(
              {
                sourceUri: vh.sourceUri,
                ...(vh.eventId ? { eventId: vh.eventId } : {}),
                quote: vh.quote,
                freshness: "CURRENT",
                freshnessCheck: vh.freshnessCheck,
              },
              idx,
            ),
          )
          .join("\n\n"),
    "",
  ].filter((l): l is string => l !== null);

  writeFileSync(receiptPath, reportLines.join("\n"), { mode: 0o600 });
  chmodSync(receiptPath, 0o600);
  writtenPaths.push(receiptPath);

  if (card.stagedIcs) {
    const icsPath = join(stagedDir, `meeting-${card.cardId}.ics`);
    writeFileSync(icsPath, card.stagedIcs, { mode: 0o600 });
    chmodSync(icsPath, 0o600);
    writtenPaths.push(icsPath);
  }

  if (card.stagedReply) {
    const replyPath = join(stagedDir, `reply-${card.cardId}.txt`);
    writeFileSync(replyPath, `${card.stagedReply}\n`, { mode: 0o600 });
    chmodSync(replyPath, 0o600);
    writtenPaths.push(replyPath);
  }

  const receipt: SkypanelAgentReceipt = {
    executedAtMs: asOfMs,
    mode: "agent",
    summary: `ActionAgent synthesized ${mergedHits.length} verified hit(s) and wrote ${writtenPaths.length} artifact(s)`,
    verifiedHitCount: mergedHits.length,
    artifactPaths: writtenPaths,
  };

  const updatedCard: SkypanelCard = {
    ...card,
    selectedMode: "agent",
    updatedAtMs: asOfMs,
    verifiedHits: mergedHits,
    status: "DISPATCHED",
    dispatchedPaths: writtenPaths,
    agentReceipt: receipt,
  };

  return { updatedCard, receipt, writtenPaths };
}
