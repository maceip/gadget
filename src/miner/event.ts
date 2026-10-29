import { createHash } from "node:crypto";
import type { EpisodicEvent } from "./types.js";

export const MINER_VERSION = "0.1.0";

// Content-addressed: the same source record always gets the same id.
export function eventId(e: Omit<EpisodicEvent, "eventId">): string {
  return createHash("sha256")
    .update([e.source, e.sourceUri, String(e.timestampMs), e.contentText].join("\u0000"))
    .digest("hex")
    .slice(0, 32);
}

export function makeEvent(e: Omit<EpisodicEvent, "eventId">): EpisodicEvent {
  return { eventId: eventId(e), ...e };
}
