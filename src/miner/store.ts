import { DatabaseSync } from "node:sqlite";
import { MINER_VERSION } from "./event.js";
import type { EpisodicEvent, ParseCounts, Seek, Source } from "./types.js";

// Event row as read back for episode building. contentText is truncated to 200 chars
// except for shell sources, whose full command is needed for classification.
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

export interface Hit {
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
-- Default unicode61: '-' and '_' separate words, so "--jitless" indexes as "jitless" and
-- compound identifiers are matched as phrases ("wasm-tier-up" -> wasm tier up, adjacent).
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  content_text, event_id UNINDEXED, tokenize = "unicode61"
);
CREATE TABLE IF NOT EXISTS ingest_counts (
  source      TEXT NOT NULL,
  label       TEXT NOT NULL,
  counts_json TEXT NOT NULL
);
`;

export class EventStore {
  readonly db: DatabaseSync;

  constructor(path: string, opts: { readOnly?: boolean } = {}) {
    this.db = new DatabaseSync(path, { readOnly: opts.readOnly ?? false });
    if (!opts.readOnly) this.db.exec(SCHEMA);
  }

  // Inserts events with their seek actions. Returns how many were new. seek_kind and
  // seek_query hold the first action for simple SQL; seeks_json holds all of them.
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

  // Time order; events with the same timestamp keep insertion order (rowid), which is the
  // order of the source file (e.g. several zsh history entries within one second).
  allEventsSorted(): StoredEvent[] {
    const rows = this.db
      .prepare(
        `SELECT event_id, source, timestamp_ms, workspace_path,
                CASE WHEN source IN ('zsh', 'zsh_hook') THEN content_text ELSE substr(content_text, 1, 200) END AS content_text,
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

  // Best FTS match among non-seek events strictly older than beforeMs.
  // The strict cutoff is what keeps replay honest: nothing from the future can match.
  searchBefore(match: string, beforeMs: number, limit = 1): Hit[] {
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

  close(): void {
    this.db.close();
  }
}
