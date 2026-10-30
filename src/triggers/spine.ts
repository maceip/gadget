// The Functional Spine (`src/triggers/spine.ts`).
//
// Connects the 4 stages of gogogadget in a single deterministic pipeline:
//   Stage 1: Capture (Utterance / Context Window in EventStore)
//   Stage 2: Trigger (Cosmo 13/19-Head Spoken Slotter + CalibratedAnticipator)
//   Stage 3: Proactive Engine (Contact/Modality/Working-Hours Resolver + Multi-Searcher + verifyClaim)
//   Stage 4: Surface & Dual-Mode Execution (2-Row Skypanel Card + Mode 1 Native App / Mode 2 Action Agent)

import { keyTokens } from "../miner/ceiling.js";
import { makeEvent } from "../miner/event.js";
import { withSeeks } from "../miner/seek.js";
import type { EventStore } from "../miner/store.js";
import type { EpisodicEvent } from "../miner/types.js";
import { runScopedActionAgent } from "../runtime/action_agent.js";
import { CalibratedAnticipator } from "../runtime/anticipator.js";
import { BriefWorkspaceSink } from "../runtime/sink.js";
import { VerifiedSurfacer } from "../runtime/surfacer.js";
import type { ContextWindow, Hit } from "../runtime/types.js";
import {
  extractSpokenSlotFromEvent,
  type SpokenSlotRecord,
} from "./cosmo_spoken_slots.js";
import {
  composeProactiveSkypanelCard,
  composeSkypanelCard,
  executeNativeAppMode,
  reviseSkypanelCard,
  runProactiveSearchForQuery,
  type SkypanelCard,
  type SkypanelExecutionMode,
} from "./skypanel_composer.js";

export interface SpineRunOptions {
  store: EventStore;
  dbPath: string;
  workspacePath?: string;
  utteranceText?: string;
  event?: EpisodicEvent;
  contextEventIds?: string[];
  nowMs?: number;
}

export interface SpineRunResult {
  triggered: boolean;
  triggerKind: "SPOKEN_UTTERANCE" | "PROACTIVE_ANTICIPATOR" | null;
  slot: SpokenSlotRecord | null;
  card: SkypanelCard | null;
  visibleCards: SkypanelCard[];
  verifiedHits: Hit[];
}

export async function runFunctionalSpine(opts: SpineRunOptions): Promise<SpineRunResult> {
  const { store, workspacePath } = opts;
  const nowMs = opts.nowMs ?? Date.now();

  let targetEvent = opts.event;
  if (!targetEvent && opts.utteranceText) {
    targetEvent = makeEvent({
      source: "audio",
      timestampMs: nowMs,
      ...(workspacePath ? { workspacePath } : {}),
      contentText: `[audio transcript] ${opts.utteranceText.trim()}`,
      sourceUri: `spine:utterance#${nowMs}`,
      metadataJson: JSON.stringify({ kind: "utterance", raw: opts.utteranceText.trim() }),
    });
    store.insert(withSeeks([targetEvent]));
  }

  // Gather recent screen and clipboard events for visual/clipboard frame stapling
  const recentSensoryRows = store.db
    .prepare(
      `SELECT event_id, source, timestamp_ms, workspace_path, content_text, source_uri, metadata_json
         FROM events
        WHERE source IN ('screen', 'clipboard')
        ORDER BY timestamp_ms DESC
        LIMIT 20`,
    )
    .all() as Array<Record<string, unknown>>;

  const sensoryPool: EpisodicEvent[] = recentSensoryRows.map((r) => ({
    eventId: r.event_id as string,
    source: r.source as EpisodicEvent["source"],
    timestampMs: Number(r.timestamp_ms),
    ...(typeof r.workspace_path === "string" ? { workspacePath: r.workspace_path } : {}),
    contentText: r.content_text as string,
    sourceUri: r.source_uri as string,
    metadataJson: r.metadata_json as string,
  }));

  // Path A: Explicit Spoken / Typed Utterance Trigger
  if (targetEvent) {
    const slot = extractSpokenSlotFromEvent(targetEvent, sensoryPool);
    if (slot) {
      const verifiedHits = await runProactiveSearchForQuery(
        store,
        slot.bodyText,
        slot.timestampMs + 1,
        workspacePath,
        [targetEvent.eventId],
      );

      if (slot.primarySlot === "PROVIDE_RECALL" || slot.allSlots.includes("PROVIDE_RECALL")) {
        slot.recallHits = verifiedHits.map((h) => ({
          eventId: h.eventId ?? targetEvent!.eventId,
          source: "fts",
          timestampMs: slot.timestampMs,
          sourceUri: h.sourceUri,
          quote: h.quote,
        }));
      }

      store.upsertSpokenSlot(slot);
      const card = composeSkypanelCard(slot, store, undefined, verifiedHits);
      store.upsertSkypanelCard(card);

      if (workspacePath) {
        const sink = new BriefWorkspaceSink(store, () => nowMs + 10);
        const activeSlots = store.listSpokenSlots({ status: "ACTIVE", limit: 10 });
        await sink.write(
          workspacePath,
          verifiedHits,
          `Spoken trigger (${slot.triggerPrefix} -> ${slot.primarySlot}): ${card.compactLabel}`,
          activeSlots,
        );
      }

      return {
        triggered: true,
        triggerKind: "SPOKEN_UTTERANCE",
        slot,
        card,
        visibleCards: store.listSkypanelCards({ limit: 3 }),
        verifiedHits,
      };
    }
  }

  // Path B: Proactive Anticipator Trigger on Live Context Window
  const contextIds =
    opts.contextEventIds ??
    (
      store.db
        .prepare(`SELECT event_id FROM events WHERE source NOT IN ('screen') ORDER BY timestamp_ms DESC LIMIT 8`)
        .all() as Array<{ event_id: string }>
    ).map((r) => r.event_id);

  if (contextIds.length > 0) {
    const anticipator = new CalibratedAnticipator(store);
    const ctx: ContextWindow = {
      endMs: nowMs,
      eventIds: contextIds,
      ...(workspacePath ? { workspacePath } : {}),
    };
    const score = anticipator.score(ctx);
    const proposals = anticipator.propose(ctx);
    const surfacer = new VerifiedSurfacer(store);

    const candidateHits: Hit[] = [];
    for (const p of proposals.slice(0, 4)) {
      const hits = await runProactiveSearchForQuery(store, p.query, nowMs, workspacePath, contextIds);
      candidateHits.push(...hits);
    }

    const decision = surfacer.decide(ctx, candidateHits);
    if (decision.action === "SURFACE") {
      const { accepted } = surfacer.filterSurfacableHits(ctx, candidateHits);
      const topProposal = proposals[0]?.query ?? keyTokens(accepted[0]?.quote ?? "", "GREP").slice(0, 2).join(" ");
      if (accepted.length > 0 && topProposal) {
        const proactiveCard = composeProactiveSkypanelCard({
          query: topProposal,
          pSeek: score.pSeek,
          reason: decision.reason,
          acceptedHits: accepted,
          store,
          nowMs,
        });
        if (proactiveCard) {
          store.upsertSkypanelCard(proactiveCard);
          if (workspacePath) {
            const sink = new BriefWorkspaceSink(store, () => nowMs + 10);
            const activeSlots = store.listSpokenSlots({ status: "ACTIVE", limit: 10 });
            await sink.write(workspacePath, accepted, decision.reason, activeSlots);
          }
          return {
            triggered: true,
            triggerKind: "PROACTIVE_ANTICIPATOR",
            slot: null,
            card: proactiveCard,
            visibleCards: store.listSkypanelCards({ limit: 3 }),
            verifiedHits: accepted,
          };
        }
      }
    }
  }

  return {
    triggered: false,
    triggerKind: null,
    slot: null,
    card: null,
    visibleCards: store.listSkypanelCards({ limit: 3 }),
    verifiedHits: [],
  };
}

export async function reviseCardOnSpine(opts: {
  store: EventStore;
  cardId: string;
  instruction: string;
  workspacePath?: string;
}): Promise<SkypanelCard> {
  const existingCard = opts.store.getSkypanelCard(opts.cardId);
  if (!existingCard) {
    throw new Error(`SkypanelCard not found: ${opts.cardId}`);
  }
  const existingSlot = opts.store.getSpokenSlotById(existingCard.slotId);
  const { updatedSlot, updatedCard } = reviseSkypanelCard(
    existingCard,
    existingSlot,
    opts.instruction,
    opts.store,
  );
  if (updatedSlot) {
    opts.store.upsertSpokenSlot(updatedSlot);
  }
  opts.store.upsertSkypanelCard(updatedCard);

  if (opts.workspacePath) {
    const sink = new BriefWorkspaceSink(opts.store);
    const activeSlots = opts.store.listSpokenSlots({ status: "ACTIVE", limit: 10 });
    await sink.write(
      opts.workspacePath,
      [],
      `Revised Skypanel card ${updatedCard.cardId}: ${updatedCard.compactLabel}`,
      activeSlots,
    );
  }
  return updatedCard;
}

export async function executeCardOnSpine(opts: {
  store: EventStore;
  dbPath: string;
  cardId: string;
  modeOverride?: SkypanelExecutionMode;
  workspacePath?: string;
}): Promise<{ card: SkypanelCard; writtenPaths: string[] }> {
  const existingCard = opts.store.getSkypanelCard(opts.cardId);
  if (!existingCard) {
    throw new Error(`SkypanelCard not found: ${opts.cardId}`);
  }
  const mode = opts.modeOverride ?? existingCard.selectedMode;

  let updatedCard: SkypanelCard;
  let writtenPaths: string[];

  if (mode === "agent") {
    const res = await runScopedActionAgent({
      card: existingCard,
      store: opts.store,
      dbPath: opts.dbPath,
      workspacePath: opts.workspacePath,
    });
    updatedCard = res.updatedCard;
    writtenPaths = res.writtenPaths;
  } else {
    const res = executeNativeAppMode(existingCard, opts.dbPath);
    updatedCard = res.updatedCard;
    writtenPaths = res.writtenPaths;
  }

  opts.store.upsertSkypanelCard(updatedCard);
  opts.store.resolveSpokenSlot(existingCard.slotId);

  if (opts.workspacePath) {
    const sink = new BriefWorkspaceSink(opts.store);
    const activeSlots = opts.store.listSpokenSlots({ status: "ACTIVE", limit: 10 });
    await sink.write(
      opts.workspacePath,
      [],
      `Executed Go-Go-Gadget (${mode}) for ${updatedCard.compactLabel}`,
      activeSlots,
    );
  }

  return { card: updatedCard, writtenPaths };
}
