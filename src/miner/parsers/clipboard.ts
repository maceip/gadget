import { makeEvent } from "../event.js";
import { bump, emptyCounts, type EpisodicEvent, type ParseResult } from "../types.js";
import { hasConcealedPasteboardType } from "../../media/clipboard.js";

interface RawClipboardRecord {
  ts?: unknown;
  changeCount?: unknown;
  text?: unknown;
  frontmostApp?: unknown;
  windowTitle?: unknown;
  cwd?: unknown;
  skippedConcealed?: unknown;
  concealedTypes?: unknown;
}

export function parseClipboardCapture(raw: string, sourceFile: string): ParseResult {
  const counts = emptyCounts();
  const events: EpisodicEvent[] = [];
  const lines = raw.split("\n");

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    counts.read++;

    let rec: RawClipboardRecord;
    try {
      rec = JSON.parse(trimmed) as RawClipboardRecord;
    } catch {
      bump(counts.skipped, "malformed_json");
      return;
    }

    const concealedList = Array.isArray(rec.concealedTypes)
      ? rec.concealedTypes.filter((x): x is string => typeof x === "string")
      : [];
    if (rec.skippedConcealed === true || hasConcealedPasteboardType(concealedList).concealed) {
      bump(counts.skipped, "concealed_pasteboard");
      return;
    }

    const ts = typeof rec.ts === "number" && Number.isFinite(rec.ts) && rec.ts > 0 ? Math.trunc(rec.ts) : undefined;
    if (ts === undefined) {
      bump(counts.skipped, "missing_timestamp");
      return;
    }

    const text = typeof rec.text === "string" ? rec.text.trim() : "";
    if (!text) {
      bump(counts.skipped, "empty_text");
      return;
    }

    const cwd = typeof rec.cwd === "string" && rec.cwd.trim().length > 0 ? rec.cwd.trim() : undefined;
    const frontmostApp = typeof rec.frontmostApp === "string" ? rec.frontmostApp : undefined;
    const windowTitle = typeof rec.windowTitle === "string" ? rec.windowTitle : undefined;
    const lineNo = idx + 1;

    events.push(
      makeEvent({
        source: "clipboard",
        timestampMs: ts,
        ...(cwd ? { workspacePath: cwd } : {}),
        contentText: text,
        sourceUri: `${sourceFile}:${lineNo}`,
        metadataJson: JSON.stringify({
          kind: "clipboard_copy",
          ...(typeof rec.changeCount === "number" ? { changeCount: rec.changeCount } : {}),
          ...(frontmostApp ? { frontmostApp } : {}),
          ...(windowTitle ? { windowTitle } : {}),
        }),
      }),
    );
    counts.parsed++;
  });

  return { events, counts };
}
