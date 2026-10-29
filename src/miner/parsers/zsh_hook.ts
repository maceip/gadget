import { makeEvent } from "../event.js";
import { bump, emptyCounts, type EpisodicEvent, type ParseResult } from "../types.js";

// Parses ~/.gadget/capture/zsh.jsonl written by capture/zsh/gadget.zsh.
export function parseZshHook(text: string, path: string): ParseResult {
  const counts = emptyCounts();
  const events: EpisodicEvent[] = [];
  text.split("\n").forEach((line, idx) => {
    if (!line.trim()) return;
    counts.read++;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      bump(counts.skipped, "bad_json");
      return;
    }
    if (typeof r !== "object" || r === null) {
      bump(counts.unknown, "non_object");
      return;
    }
    const o = r as Record<string, unknown>;
    if (o.v !== 1) {
      bump(counts.unknown, `version:${String(o.v)}`);
      return;
    }
    if (
      typeof o.start_ms !== "number" ||
      typeof o.end_ms !== "number" ||
      typeof o.cmd !== "string" ||
      typeof o.cwd !== "string" ||
      typeof o.exit !== "number"
    ) {
      bump(counts.skipped, "missing_field");
      return;
    }
    events.push(
      makeEvent({
        source: "zsh_hook",
        timestampMs: o.start_ms,
        workspacePath: o.cwd,
        contentText: o.cmd,
        sourceUri: `${path}:${idx + 1}`,
        metadataJson: JSON.stringify({ exit: o.exit, end_ms: o.end_ms }),
      }),
    );
    counts.parsed++;
  });
  return { events, counts };
}

// Drops zsh history entries that the hook also recorded (same command, start within ~2s).
export function dedupeHistoryAgainstHook(
  history: EpisodicEvent[],
  hook: EpisodicEvent[],
): { kept: EpisodicEvent[]; dropped: number } {
  const byCmd = new Map<string, number[]>();
  for (const h of hook) {
    const list = byCmd.get(h.contentText) ?? [];
    list.push(h.timestampMs);
    byCmd.set(h.contentText, list);
  }
  // Each hook record can account for at most one history entry.
  let dropped = 0;
  const kept = history.filter((e) => {
    const times = byCmd.get(e.contentText);
    const at = times?.findIndex((t) => t >= e.timestampMs - 1000 && t <= e.timestampMs + 2000) ?? -1;
    if (at >= 0) {
      times!.splice(at, 1);
      dropped++;
      return false;
    }
    return true;
  });
  return { kept, dropped };
}
