import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEvent } from "../src/miner/event.js";
import { classifyEventAll } from "../src/miner/seek.js";
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
    seeks: classifyEventAll(e),
  };
}

// Playwright is not a dependency. Browser tests use it when the machine has it
// (`import`, `require` resolution honoring NODE_PATH, or local installation) and skip otherwise.
export async function loadPlaywright(): Promise<any | null> {
  const fromModule = (m: any) => (m?.chromium ? m : m?.default?.chromium ? m.default : null);
  try {
    const m = fromModule(await import("playwright" as string));
    if (m) return m;
  } catch {
    // not importable from here
  }
  try {
    const m = fromModule(createRequire(import.meta.url)("playwright"));
    if (m) return m;
  } catch {
    // not in require path
  }
  try {
    const m = fromModule(await import("/Users/mac/outbox/web/node_modules/playwright/index.js" as string));
    if (m) return m;
  } catch {
    // not installed at fallback path
  }
  return null;
}
