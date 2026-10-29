import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEvent } from "../src/miner/event.js";
import { classifyEvent } from "../src/miner/seek.js";
import type { StoredEvent } from "../src/miner/store.js";
import type { EpisodicEvent, Source } from "../src/miner/types.js";

// dist/test/helpers.js -> repo root
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function tmp(prefix = "gadget-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export const T0 = Date.UTC(2026, 9, 1, 12, 0, 0); // 2026-10-01T12:00:00Z
export const MIN = 60_000;
export const DAY = 24 * 60 * MIN;

export function ev(source: Source, timestampMs: number, contentText: string, meta: Record<string, unknown> = {}): EpisodicEvent {
  return makeEvent({ source, timestampMs, contentText, sourceUri: `test:${source}:${timestampMs}`, metadataJson: JSON.stringify(meta) });
}

export function stored(e: EpisodicEvent): StoredEvent {
  return {
    eventId: e.eventId,
    source: e.source,
    timestampMs: e.timestampMs,
    workspacePath: e.workspacePath ?? null,
    contentText: e.contentText,
    sourceUri: e.sourceUri,
    metadataJson: e.metadataJson,
    seek: classifyEvent(e),
  };
}
