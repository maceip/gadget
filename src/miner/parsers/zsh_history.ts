import { makeEvent } from "../event.js";
import { bump, emptyCounts, type ParseResult } from "../types.js";

// zsh "metafies" bytes in the history file: 0x83 followed by (byte XOR 32).
export function unmetafy(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === 0x83 && i + 1 < buf.length) {
      out[j++] = buf[++i]! ^ 32;
    } else {
      out[j++] = b;
    }
  }
  return out.subarray(0, j);
}

const EXTENDED = /^: (\d+):(\d+);([\s\S]*)$/;

// Parses a zsh history file. Only EXTENDED_HISTORY entries (": <epoch>:<duration>;<cmd>")
// carry a timestamp; other lines are skipped and counted, never given a guessed time.
// Embedded newlines are stored as backslash-newline.
export function parseZshHistory(buf: Buffer, path: string): ParseResult {
  const counts = emptyCounts();
  const events = [];
  const lines = unmetafy(buf).toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();

  let i = 0;
  while (i < lines.length) {
    const firstLine = i + 1;
    let entry = lines[i]!;
    while (entry.endsWith("\\") && i + 1 < lines.length) {
      entry = entry.slice(0, -1) + "\n" + lines[++i]!;
    }
    i++;
    counts.read++;

    const m = EXTENDED.exec(entry);
    if (!m) {
      bump(counts.skipped, "no_timestamp");
      continue;
    }
    const cmd = m[3]!;
    if (!cmd.trim()) {
      bump(counts.skipped, "empty_command");
      continue;
    }
    events.push(
      makeEvent({
        source: "zsh",
        timestampMs: Number(m[1]) * 1000,
        contentText: cmd,
        sourceUri: `${path}:${firstLine}`,
        metadataJson: JSON.stringify({ duration_s: Number(m[2]) }),
      }),
    );
    counts.parsed++;
  }
  return { events, counts };
}
