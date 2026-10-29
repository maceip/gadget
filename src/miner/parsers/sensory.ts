import { makeEvent } from "../event.js";
import { bump, emptyCounts, type EpisodicEvent, type ParseResult } from "../types.js";

const WHISPER_SILENCE = /^(\[(blank_audio|silence|music|noise|inaudible)\]|\((silence|blank|music|noise)\)|\s)+$/i;

export function parseScreenCapture(raw: string, sourceFile: string): ParseResult {
  const counts = emptyCounts();
  const events: EpisodicEvent[] = [];
  let prevText = "";

  raw.split("\n").forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    counts.read++;

    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      bump(counts.skipped, "malformed_json");
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

    if (text === prevText) {
      bump(counts.skipped, "unchanged_screen");
      return;
    }
    prevText = text;

    const frontmostApp = typeof rec.frontmostApp === "string" ? rec.frontmostApp : undefined;
    const windowTitle = typeof rec.windowTitle === "string" ? rec.windowTitle : undefined;
    const cwd = typeof rec.cwd === "string" && rec.cwd.trim() ? rec.cwd.trim() : undefined;
    const header = [frontmostApp, windowTitle].filter(Boolean).join(" — ");
    const contentText = header ? `[${header}]\n${text}` : text;

    events.push(
      makeEvent({
        source: "screen",
        timestampMs: ts,
        ...(cwd ? { workspacePath: cwd } : {}),
        contentText,
        sourceUri: `${sourceFile}:${idx + 1}`,
        metadataJson: JSON.stringify({
          kind: "screen_ocr",
          ...(frontmostApp ? { frontmostApp } : {}),
          ...(windowTitle ? { windowTitle } : {}),
          ...(typeof rec.lineCount === "number" ? { lineCount: rec.lineCount } : {}),
        }),
      }),
    );
    counts.parsed++;
  });

  return { events, counts };
}

export function parseAudioCapture(raw: string, sourceFile: string): ParseResult {
  const counts = emptyCounts();
  const events: EpisodicEvent[] = [];

  raw.split("\n").forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    counts.read++;

    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      bump(counts.skipped, "malformed_json");
      return;
    }

    const ts = typeof rec.ts === "number" && Number.isFinite(rec.ts) && rec.ts > 0 ? Math.trunc(rec.ts) : undefined;
    if (ts === undefined) {
      bump(counts.skipped, "missing_timestamp");
      return;
    }

    const text = typeof rec.transcript === "string" ? rec.transcript.trim() : typeof rec.text === "string" ? rec.text.trim() : "";
    if (!text || WHISPER_SILENCE.test(text)) {
      bump(counts.skipped, "silence_or_empty");
      return;
    }

    const cwd = typeof rec.cwd === "string" && rec.cwd.trim() ? rec.cwd.trim() : undefined;
    const audioPath = typeof rec.audioPath === "string" ? rec.audioPath : undefined;

    events.push(
      makeEvent({
        source: "audio",
        timestampMs: ts,
        ...(cwd ? { workspacePath: cwd } : {}),
        contentText: text,
        sourceUri: `${sourceFile}:${idx + 1}`,
        metadataJson: JSON.stringify({
          kind: typeof rec.kind === "string" ? rec.kind : "audio_stt",
          ...(audioPath ? { audioPath } : {}),
          ...(typeof rec.durationSec === "number" ? { durationSec: rec.durationSec } : {}),
        }),
      }),
    );
    counts.parsed++;
  });

  return { events, counts };
}

export function parseKeyboardCapture(raw: string, sourceFile: string): ParseResult {
  const counts = emptyCounts();
  const events: EpisodicEvent[] = [];
  let prevText = "";

  raw.split("\n").forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    counts.read++;

    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      bump(counts.skipped, "malformed_json");
      return;
    }

    if (rec.skippedSecure === true) {
      bump(counts.skipped, "secure_field");
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

    if (text === prevText) {
      bump(counts.skipped, "unchanged_text");
      return;
    }
    prevText = text;

    const frontmostApp = typeof rec.frontmostApp === "string" ? rec.frontmostApp : undefined;
    const windowTitle = typeof rec.windowTitle === "string" ? rec.windowTitle : undefined;
    const cwd = typeof rec.cwd === "string" && rec.cwd.trim() ? rec.cwd.trim() : undefined;
    const kind = typeof rec.kind === "string" ? rec.kind : "keyboard";
    const header = [frontmostApp, windowTitle].filter(Boolean).join(" — ");
    const contentText = header ? `[${header}]\n${text}` : text;

    events.push(
      makeEvent({
        source: "keyboard",
        timestampMs: ts,
        ...(cwd ? { workspacePath: cwd } : {}),
        contentText,
        sourceUri: `${sourceFile}:${idx + 1}`,
        metadataJson: JSON.stringify({
          kind,
          ...(frontmostApp ? { frontmostApp } : {}),
          ...(windowTitle ? { windowTitle } : {}),
          ...(typeof rec.role === "string" ? { role: rec.role } : {}),
        }),
      }),
    );
    counts.parsed++;
  });

  return { events, counts };
}
