import { DatabaseSync } from "node:sqlite";
import type {
  CosmoSlotKind,
  SpokenSlotContextSnapshot,
  SpokenSlotRecallHit,
  SpokenSlotRecord,
  TriggerSocialMode,
} from "../triggers/cosmo_spoken_slots.js";
import type {
  SkypanelAgentReceipt,
  SkypanelCard,
  SkypanelExecutionMode,
  SkypanelIconId,
  SkypanelRevision,
  SkypanelSurface,
  SkypanelTriggerKind,
  SkypanelVerifiedHit,
} from "../triggers/skypanel_composer.js";
import { MINER_VERSION } from "./event.js";
import type { EpisodicEvent, ParseCounts, Seek, Source } from "./types.js";

export interface StoredEvent {
  eventId: string;
  source: Source;
  timestampMs: number;
  workspacePath: string | null;
  contentText: string;
  sourceUri: string;
  metadataJson: string;
  seeks: Seek[];
}

export interface StoreSnippetHit {
  eventId: string;
  source: Source;
  timestampMs: number;
  sourceUri: string;
  snippet: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_id       TEXT PRIMARY KEY,
  source         TEXT NOT NULL,
  timestamp_ms   INTEGER NOT NULL,
  workspace_path TEXT,
  content_text   TEXT NOT NULL,
  source_uri     TEXT NOT NULL,
  metadata_json  TEXT NOT NULL,
  is_seek        INTEGER NOT NULL DEFAULT 0,
  seek_kind      TEXT,
  seek_query     TEXT,
  seeks_json     TEXT NOT NULL DEFAULT '[]',
  miner_version  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ts ON events(timestamp_ms);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  content_text, event_id UNINDEXED, tokenize = "unicode61"
);
CREATE TABLE IF NOT EXISTS ingest_counts (
  source      TEXT NOT NULL,
  label       TEXT NOT NULL,
  counts_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spoken_slots (
  slot_id        TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL,
  source         TEXT NOT NULL,
  timestamp_ms   INTEGER NOT NULL,
  trigger_id     TEXT NOT NULL,
  trigger_prefix TEXT NOT NULL,
  social_mode    TEXT NOT NULL,
  primary_slot   TEXT NOT NULL,
  all_slots_json TEXT NOT NULL,
  raw_text       TEXT NOT NULL,
  body_text      TEXT NOT NULL,
  extracted_time TEXT,
  is_tbc         INTEGER NOT NULL DEFAULT 0,
  context_json   TEXT NOT NULL DEFAULT '{}',
  recall_json    TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'ACTIVE',
  miner_version  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS spoken_slots_ts ON spoken_slots(timestamp_ms DESC);
CREATE TABLE IF NOT EXISTS skypanel_cards (
  card_id                 TEXT PRIMARY KEY,
  slot_id                 TEXT NOT NULL,
  trigger_kind            TEXT NOT NULL,
  anticipator_score       REAL NOT NULL DEFAULT 1.0,
  created_at_ms           INTEGER NOT NULL,
  updated_at_ms           INTEGER NOT NULL,
  compact_label           TEXT NOT NULL,
  source_icons_json       TEXT NOT NULL,
  target_icons_json       TEXT NOT NULL,
  selected_mode           TEXT NOT NULL DEFAULT 'app',
  contact_name            TEXT,
  inferred_working_hours  TEXT NOT NULL,
  proposed_time_iso       TEXT,
  proposed_time_label     TEXT,
  context_summary         TEXT NOT NULL,
  verified_hits_json      TEXT NOT NULL DEFAULT '[]',
  staged_reply            TEXT,
  staged_ics              TEXT,
  staged_agent_brief      TEXT NOT NULL,
  active_surface          TEXT NOT NULL DEFAULT 'desktop',
  revisions_json          TEXT NOT NULL DEFAULT '[]',
  status                  TEXT NOT NULL DEFAULT 'PENDING',
  dispatched_paths_json   TEXT NOT NULL DEFAULT '[]',
  agent_receipt_json      TEXT,
  miner_version           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS skypanel_cards_ts ON skypanel_cards(updated_at_ms DESC);
`;

export class EventStore {
  readonly db: DatabaseSync;

  constructor(path: string, opts: { readOnly?: boolean } = {}) {
    this.db = new DatabaseSync(path, { readOnly: opts.readOnly ?? false, timeout: 10000 });
    this.db.exec("PRAGMA busy_timeout = 10000;");
    if (!opts.readOnly) {
      try {
        this.db.exec("PRAGMA journal_mode = WAL;");
      } catch {
        // Ignore if WAL is unsupported on the target filesystem
      }
      this.db.exec(SCHEMA);
    }
  }

  insert(rows: Array<{ event: EpisodicEvent; seeks: Seek[] }>): number {
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO events
         (event_id, source, timestamp_ms, workspace_path, content_text, source_uri, metadata_json,
          is_seek, seek_kind, seek_query, seeks_json, miner_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const fts = this.db.prepare("INSERT INTO events_fts (content_text, event_id) VALUES (?, ?)");
    let added = 0;
    this.db.exec("BEGIN");
    try {
      for (const { event: e, seeks } of rows) {
        const first = seeks[0];
        const r = ins.run(
          e.eventId,
          e.source,
          e.timestampMs,
          e.workspacePath ?? null,
          e.contentText,
          e.sourceUri,
          e.metadataJson,
          seeks.length > 0 ? 1 : 0,
          first?.kind ?? null,
          first?.query ?? null,
          JSON.stringify(seeks),
          MINER_VERSION,
        );
        if (Number(r.changes) === 1) {
          fts.run(e.contentText, e.eventId);
          added++;
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return added;
  }

  recordCounts(source: string, label: string, counts: ParseCounts): void {
    this.db
      .prepare("INSERT INTO ingest_counts (source, label, counts_json) VALUES (?, ?, ?)")
      .run(source, label, JSON.stringify(counts));
  }

  readCounts(): Array<{ source: string; label: string; counts: ParseCounts }> {
    const rows = this.db.prepare("SELECT source, label, counts_json FROM ingest_counts ORDER BY rowid").all() as Array<{
      source: string;
      label: string;
      counts_json: string;
    }>;
    return rows.map((r) => ({ source: r.source, label: r.label, counts: JSON.parse(r.counts_json) as ParseCounts }));
  }

  allEventsSorted(): StoredEvent[] {
    const rows = this.db
      .prepare(
        `SELECT event_id, source, timestamp_ms, workspace_path,
                CASE WHEN source IN ('zsh', 'zsh_hook') OR json_extract(metadata_json, '$.kind') = 'tool_command'
                     THEN content_text ELSE substr(content_text, 1, 200) END AS content_text,
                source_uri, metadata_json, seeks_json
           FROM events ORDER BY timestamp_ms, rowid`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      eventId: r.event_id as string,
      source: r.source as Source,
      timestampMs: r.timestamp_ms as number,
      workspacePath: (r.workspace_path as string | null) ?? null,
      contentText: r.content_text as string,
      sourceUri: r.source_uri as string,
      metadataJson: r.metadata_json as string,
      seeks: JSON.parse(r.seeks_json as string) as Seek[],
    }));
  }

  getEventById(eventId: string): EpisodicEvent | undefined {
    const r = this.db
      .prepare(
        `SELECT event_id, source, timestamp_ms, workspace_path, content_text, source_uri, metadata_json
           FROM events WHERE event_id = ?`,
      )
      .get(eventId) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const ev: EpisodicEvent = {
      eventId: r.event_id as string,
      source: r.source as Source,
      timestampMs: r.timestamp_ms as number,
      contentText: r.content_text as string,
      sourceUri: r.source_uri as string,
      metadataJson: r.metadata_json as string,
    };
    if (typeof r.workspace_path === "string") ev.workspacePath = r.workspace_path;
    return ev;
  }

  searchBefore(match: string, beforeMs: number, limit = 1): StoreSnippetHit[] {
    const rows = this.db
      .prepare(
        `SELECT e.event_id AS event_id, e.source AS source, e.timestamp_ms AS timestamp_ms,
                e.source_uri AS source_uri,
                snippet(events_fts, 0, '[', ']', '...', 12) AS snippet
           FROM events_fts
           JOIN events e ON e.event_id = events_fts.event_id
          WHERE events_fts MATCH ? AND e.timestamp_ms < ? AND e.is_seek = 0
          ORDER BY bm25(events_fts)
          LIMIT ?`,
      )
      .all(match, beforeMs, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      eventId: r.event_id as string,
      source: r.source as Source,
      timestampMs: r.timestamp_ms as number,
      sourceUri: r.source_uri as string,
      snippet: r.snippet as string,
    }));
  }

  upsertSpokenSlot(slot: SpokenSlotRecord): void {
    this.db
      .prepare(
        `INSERT INTO spoken_slots
           (slot_id, event_id, source, timestamp_ms, trigger_id, trigger_prefix, social_mode,
            primary_slot, all_slots_json, raw_text, body_text, extracted_time, is_tbc,
            context_json, recall_json, status, miner_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slot_id) DO UPDATE SET
           primary_slot = excluded.primary_slot,
           all_slots_json = excluded.all_slots_json,
           body_text = excluded.body_text,
           extracted_time = excluded.extracted_time,
           is_tbc = excluded.is_tbc,
           context_json = excluded.context_json,
           recall_json = excluded.recall_json,
           status = excluded.status`,
      )
      .run(
        slot.slotId,
        slot.eventId,
        slot.source,
        slot.timestampMs,
        slot.triggerId,
        slot.triggerPrefix,
        slot.socialMode,
        slot.primarySlot,
        JSON.stringify(slot.allSlots),
        slot.rawText,
        slot.bodyText,
        slot.extractedTimeText ?? null,
        slot.isTimeBoundCommitment ? 1 : 0,
        JSON.stringify(slot.context),
        JSON.stringify(slot.recallHits ?? []),
        slot.status,
        MINER_VERSION,
      );
  }

  getSpokenSlotById(slotId: string): SpokenSlotRecord | undefined {
    try {
      const r = this.db
        .prepare(`SELECT * FROM spoken_slots WHERE slot_id = ?`)
        .get(slotId) as Record<string, unknown> | undefined;
      if (!r) return undefined;
      return this.mapSpokenSlotRow(r);
    } catch {
      return undefined;
    }
  }

  private mapSpokenSlotRow(r: Record<string, unknown>): SpokenSlotRecord {
    const extractedTime = typeof r.extracted_time === "string" ? r.extracted_time : undefined;
    const recallHits = JSON.parse((r.recall_json as string) || "[]") as SpokenSlotRecallHit[];
    return {
      slotId: r.slot_id as string,
      eventId: r.event_id as string,
      source: r.source as Source,
      timestampMs: r.timestamp_ms as number,
      triggerId: r.trigger_id as string,
      triggerPrefix: r.trigger_prefix as string,
      socialMode: r.social_mode as TriggerSocialMode,
      primarySlot: r.primary_slot as CosmoSlotKind,
      allSlots: JSON.parse((r.all_slots_json as string) || "[]") as CosmoSlotKind[],
      rawText: r.raw_text as string,
      bodyText: r.body_text as string,
      ...(extractedTime ? { extractedTimeText: extractedTime } : {}),
      isTimeBoundCommitment: Number(r.is_tbc) === 1,
      context: JSON.parse((r.context_json as string) || "{}") as SpokenSlotContextSnapshot,
      ...(recallHits.length > 0 ? { recallHits } : {}),
      status: (r.status as "ACTIVE" | "RESOLVED") ?? "ACTIVE",
    };
  }

  listSpokenSlots(opts: { status?: "ACTIVE" | "RESOLVED"; limit?: number } = {}): SpokenSlotRecord[] {
    try {
      const limit = opts.limit ?? 50;
      const rows = opts.status
        ? (this.db
            .prepare(`SELECT * FROM spoken_slots WHERE status = ? ORDER BY timestamp_ms DESC LIMIT ?`)
            .all(opts.status, limit) as Array<Record<string, unknown>>)
        : (this.db
            .prepare(`SELECT * FROM spoken_slots ORDER BY timestamp_ms DESC LIMIT ?`)
            .all(limit) as Array<Record<string, unknown>>);
      return rows.map((r) => this.mapSpokenSlotRow(r));
    } catch {
      return [];
    }
  }

  resolveSpokenSlot(slotId: string): boolean {
    const r = this.db
      .prepare(`UPDATE spoken_slots SET status = 'RESOLVED' WHERE slot_id = ?`)
      .run(slotId);
    return Number(r.changes) > 0;
  }

  upsertSkypanelCard(card: SkypanelCard): void {
    this.db
      .prepare(
        `INSERT INTO skypanel_cards
           (card_id, slot_id, trigger_kind, anticipator_score, created_at_ms, updated_at_ms,
            compact_label, source_icons_json, target_icons_json, selected_mode, contact_name,
            inferred_working_hours, proposed_time_iso, proposed_time_label, context_summary,
            verified_hits_json, staged_reply, staged_ics, staged_agent_brief, active_surface,
            revisions_json, status, dispatched_paths_json, agent_receipt_json, miner_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(card_id) DO UPDATE SET
           updated_at_ms = excluded.updated_at_ms,
           compact_label = excluded.compact_label,
           source_icons_json = excluded.source_icons_json,
           target_icons_json = excluded.target_icons_json,
           selected_mode = excluded.selected_mode,
           contact_name = excluded.contact_name,
           inferred_working_hours = excluded.inferred_working_hours,
           proposed_time_iso = excluded.proposed_time_iso,
           proposed_time_label = excluded.proposed_time_label,
           context_summary = excluded.context_summary,
           verified_hits_json = excluded.verified_hits_json,
           staged_reply = excluded.staged_reply,
           staged_ics = excluded.staged_ics,
           staged_agent_brief = excluded.staged_agent_brief,
           active_surface = excluded.active_surface,
           revisions_json = excluded.revisions_json,
           status = excluded.status,
           dispatched_paths_json = excluded.dispatched_paths_json,
           agent_receipt_json = excluded.agent_receipt_json`,
      )
      .run(
        card.cardId,
        card.slotId,
        card.triggerKind,
        card.anticipatorScore,
        card.createdAtMs,
        card.updatedAtMs,
        card.compactLabel,
        JSON.stringify(card.sourceIcons),
        JSON.stringify(card.targetIcons),
        card.selectedMode,
        card.contactName,
        card.inferredWorkingHours,
        card.proposedTimeIso,
        card.proposedTimeLabel,
        card.contextSummary,
        JSON.stringify(card.verifiedHits),
        card.stagedReply,
        card.stagedIcs,
        card.stagedAgentBrief,
        card.activeSurface,
        JSON.stringify(card.revisions),
        card.status,
        JSON.stringify(card.dispatchedPaths),
        card.agentReceipt ? JSON.stringify(card.agentReceipt) : null,
        MINER_VERSION,
      );
  }

  private mapSkypanelCardRow(r: Record<string, unknown>): SkypanelCard {
    return {
      cardId: r.card_id as string,
      slotId: r.slot_id as string,
      triggerKind: (r.trigger_kind as SkypanelTriggerKind) ?? "SPOKEN_UTTERANCE",
      anticipatorScore: Number(r.anticipator_score ?? 1.0),
      createdAtMs: Number(r.created_at_ms),
      updatedAtMs: Number(r.updated_at_ms),
      compactLabel: r.compact_label as string,
      sourceIcons: JSON.parse((r.source_icons_json as string) || "[]") as SkypanelIconId[],
      targetIcons: JSON.parse((r.target_icons_json as string) || "[]") as SkypanelIconId[],
      selectedMode: ((r.selected_mode as string) === "agent" ? "agent" : "app") as SkypanelExecutionMode,
      contactName: (r.contact_name as string | null) ?? null,
      inferredWorkingHours: r.inferred_working_hours as string,
      proposedTimeIso: (r.proposed_time_iso as string | null) ?? null,
      proposedTimeLabel: (r.proposed_time_label as string | null) ?? null,
      contextSummary: r.context_summary as string,
      verifiedHits: JSON.parse((r.verified_hits_json as string) || "[]") as SkypanelVerifiedHit[],
      stagedReply: (r.staged_reply as string | null) ?? null,
      stagedIcs: (r.staged_ics as string | null) ?? null,
      stagedAgentBrief: r.staged_agent_brief as string,
      activeSurface: ((r.active_surface as string) || "desktop") as SkypanelSurface,
      revisions: JSON.parse((r.revisions_json as string) || "[]") as SkypanelRevision[],
      status: ((r.status as string) || "PENDING") as "PENDING" | "DISPATCHED" | "DISMISSED",
      dispatchedPaths: JSON.parse((r.dispatched_paths_json as string) || "[]") as string[],
      agentReceipt: r.agent_receipt_json
        ? (JSON.parse(r.agent_receipt_json as string) as SkypanelAgentReceipt)
        : null,
    };
  }

  getSkypanelCard(cardId: string): SkypanelCard | undefined {
    try {
      const r = this.db
        .prepare(`SELECT * FROM skypanel_cards WHERE card_id = ?`)
        .get(cardId) as Record<string, unknown> | undefined;
      if (!r) return undefined;
      return this.mapSkypanelCardRow(r);
    } catch {
      return undefined;
    }
  }

  listSkypanelCards(opts: { status?: "PENDING" | "DISPATCHED" | "DISMISSED"; limit?: number } = {}): SkypanelCard[] {
    try {
      const limit = opts.limit ?? 3;
      const rows = opts.status
        ? (this.db
            .prepare(`SELECT * FROM skypanel_cards WHERE status = ? ORDER BY updated_at_ms DESC LIMIT ?`)
            .all(opts.status, limit) as Array<Record<string, unknown>>)
        : (this.db
            .prepare(`SELECT * FROM skypanel_cards WHERE status != 'DISMISSED' ORDER BY updated_at_ms DESC LIMIT ?`)
            .all(limit) as Array<Record<string, unknown>>);
      return rows.map((r) => this.mapSkypanelCardRow(r));
    } catch {
      return [];
    }
  }

  dismissSkypanelCard(cardId: string): boolean {
    const r = this.db
      .prepare(`UPDATE skypanel_cards SET status = 'DISMISSED', updated_at_ms = ? WHERE card_id = ?`)
      .run(Date.now(), cardId);
    return Number(r.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}
