import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeEvent } from "../event.js";
import { bump, emptyCounts, isObject, type EpisodicEvent, type ParseResult } from "../types.js";

export function parseAndroidCapture(raw: string, filePath: string): ParseResult {
  const counts = emptyCounts();
  const events: EpisodicEvent[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    counts.read++;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      bump(counts.skipped, "malformed_json");
      continue;
    }
    if (!isObject(obj)) {
      bump(counts.skipped, "not_object");
      continue;
    }
    const sender = typeof obj.sender === "string" ? obj.sender.trim() : typeof obj.contact === "string" ? obj.contact.trim() : "";
    const text = typeof obj.text === "string" ? obj.text.trim() : typeof obj.body === "string" ? obj.body.trim() : "";
    const timestampMs = typeof obj.timestampMs === "number" ? Math.round(obj.timestampMs) : Date.now();
    if (!text) {
      bump(counts.skipped, "empty_text");
      continue;
    }
    const prefix = sender ? `[Android SMS from ${sender}] ` : "[Android SMS] ";
    events.push(
      makeEvent({
        source: "android",
        timestampMs,
        contentText: `${prefix}${text}`,
        sourceUri: `${filePath}:${i + 1}`,
        metadataJson: JSON.stringify({
          sender: sender || null,
          app: typeof obj.app === "string" ? obj.app : "Android Messages",
          channel: "sms",
        }),
      }),
    );
    counts.parsed++;
  }
  return { events, counts };
}

export function parseMessagesCapture(raw: string, filePath: string): ParseResult {
  const counts = emptyCounts();
  const events: EpisodicEvent[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    counts.read++;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      bump(counts.skipped, "malformed_json");
      continue;
    }
    if (!isObject(obj)) {
      bump(counts.skipped, "not_object");
      continue;
    }
    const sender = typeof obj.sender === "string" ? obj.sender.trim() : typeof obj.handle === "string" ? obj.handle.trim() : "";
    const text = typeof obj.text === "string" ? obj.text.trim() : "";
    const timestampMs = typeof obj.timestampMs === "number" ? Math.round(obj.timestampMs) : Date.now();
    if (!text) {
      bump(counts.skipped, "empty_text");
      continue;
    }
    const prefix = sender ? `[Messages.app ${sender}] ` : "[Messages.app] ";
    events.push(
      makeEvent({
        source: "messages",
        timestampMs,
        contentText: `${prefix}${text}`,
        sourceUri: `${filePath}:${i + 1}`,
        metadataJson: JSON.stringify({
          sender: sender || null,
          service: typeof obj.service === "string" ? obj.service : "iMessage/SMS",
        }),
      }),
    );
    counts.parsed++;
  }
  return { events, counts };
}

export function parseCalendarCapture(raw: string, filePath: string): ParseResult {
  const counts = emptyCounts();
  const events: EpisodicEvent[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    counts.read++;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      bump(counts.skipped, "malformed_json");
      continue;
    }
    if (!isObject(obj)) {
      bump(counts.skipped, "not_object");
      continue;
    }
    const title = typeof obj.title === "string" ? obj.title.trim() : typeof obj.summary === "string" ? obj.summary.trim() : "";
    const startIso = typeof obj.startIso === "string" ? obj.startIso : "";
    const endIso = typeof obj.endIso === "string" ? obj.endIso : "";
    const timestampMs = typeof obj.timestampMs === "number" ? Math.round(obj.timestampMs) : Date.now();
    if (!title) {
      bump(counts.skipped, "empty_title");
      continue;
    }
    events.push(
      makeEvent({
        source: "calendar",
        timestampMs,
        contentText: `[Calendar.app] ${title}${startIso ? ` (${startIso}${endIso ? ` -> ${endIso}` : ""})` : ""}`,
        sourceUri: `${filePath}:${i + 1}`,
        metadataJson: JSON.stringify({
          title,
          startIso: startIso || null,
          endIso: endIso || null,
          attendees: Array.isArray(obj.attendees) ? obj.attendees : [],
        }),
      }),
    );
    counts.parsed++;
  }
  return { events, counts };
}

/**
 * Safely reads recent rows from macOS `~/Library/Messages/chat.db` via a temporary
 * read-only file copy when Full Disk Access is available. Never mutates or locks the original.
 */
export function parseMacosChatDbSnapshot(chatDbPath: string, limit = 200): ParseResult {
  const counts = emptyCounts();
  const events: EpisodicEvent[] = [];
  if (!existsSync(chatDbPath)) {
    bump(counts.skipped, "missing_chat_db");
    return { events, counts };
  }
  const tmpDir = mkdtempSync(join(tmpdir(), "gogogadget-chatdb-"));
  const copyPath = join(tmpDir, "chat.db");
  try {
    copyFileSync(chatDbPath, copyPath);
    const db = new DatabaseSync(copyPath, { readOnly: true, timeout: 2000 });
    try {
      // Apple Cocoa CoreData epoch is 2001-01-01T00:00:00Z (978307200 seconds after Unix epoch)
      const rows = db
        .prepare(
          `SELECT m.ROWID AS rowid, m.text AS text, m.date AS date_raw, m.service AS service,
                  h.id AS handle_id
             FROM message m
             LEFT JOIN handle h ON m.handle_id = h.ROWID
            WHERE m.text IS NOT NULL AND length(trim(m.text)) > 0
            ORDER BY m.date DESC
            LIMIT ?`,
        )
        .all(limit) as Array<{
        rowid: number;
        text: string;
        date_raw: number;
        service: string | null;
        handle_id: string | null;
      }>;
      for (const r of rows) {
        counts.read++;
        const rawDate = Number(r.date_raw || 0);
        // Newer macOS stores nanoseconds since 2001-01-01; older stores seconds
        const secSince2001 = rawDate > 1e12 ? rawDate / 1e9 : rawDate;
        const timestampMs = Math.round((secSince2001 + 978307200) * 1000);
        const sender = r.handle_id?.trim() || "contact";
        events.push(
          makeEvent({
            source: "messages",
            timestampMs,
            contentText: `[Messages.app ${sender}] ${r.text.trim()}`,
            sourceUri: `${chatDbPath}#rowid-${r.rowid}`,
            metadataJson: JSON.stringify({
              sender,
              service: r.service ?? "iMessage",
            }),
          }),
        );
        counts.parsed++;
      }
    } finally {
      db.close();
    }
  } catch {
    bump(counts.skipped, "unreadable_or_tcc_protected");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return { events, counts };
}
