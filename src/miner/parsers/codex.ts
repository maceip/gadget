import { makeEvent } from "../event.js";
import { bump, emptyCounts, type EpisodicEvent, type ParseResult } from "../types.js";

// Parses a Codex CLI rollout file (~/.codex/sessions/**/*.jsonl).
//
// Written from the public rollout format, not verified against the owner's files:
// run `npm run mine -- probe` and compare. Recognized:
//   {"type":"session_meta","payload":{"cwd":...}}                       -> workspace
//   {"timestamp":ISO,"type":"response_item","payload":{"type":"message","role":...,"content":[{"text":...}]}}
//   {"timestamp":ISO,"type":"message","role":...,"content":[...]}       -> older top-level shape
// Everything else is counted as unknown by type, never dropped silently.
export function parseCodexSession(text: string, path: string): ParseResult {
  const counts = emptyCounts();
  const events: EpisodicEvent[] = [];
  let cwd: string | undefined;

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
    if (typeof r !== "object" || r === null || Array.isArray(r)) {
      bump(counts.unknown, "non_object");
      return;
    }
    const o = r as Record<string, unknown>;
    const payload = isObject(o.payload) ? o.payload : undefined;

    if (o.type === "session_meta") {
      if (payload && typeof payload.cwd === "string") cwd = payload.cwd;
      bump(counts.skipped, "session_meta");
      return;
    }

    const msg = o.type === "response_item" && payload?.type === "message" ? payload : o.type === "message" ? o : undefined;
    if (!msg) {
      bump(counts.unknown, shapeKey(o, payload));
      return;
    }

    const role = msg.role;
    if (role !== "user" && role !== "assistant") {
      bump(counts.skipped, `role:${typeof role === "string" ? role : "missing"}`);
      return;
    }
    const content = messageText(msg.content);
    if (!content) {
      bump(counts.skipped, "empty_message");
      return;
    }
    const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (Number.isNaN(ts)) {
      bump(counts.skipped, "no_timestamp");
      return;
    }
    if (role === "user" && isInjectedContext(content)) {
      bump(counts.skipped, "injected_context");
      return;
    }
    events.push(
      makeEvent({
        source: "codex_session",
        timestampMs: ts,
        workspacePath: cwd,
        contentText: content,
        sourceUri: `${path}#${idx + 1}`,
        metadataJson: JSON.stringify({ role }),
      }),
    );
    counts.parsed++;
  });
  return { events, counts };
}

// User-role messages that the CLI injects (environment, instructions) start with a tag.
export function isInjectedContext(text: string): boolean {
  return /^\s*<[a-z_][a-z0-9_-]*>/i.test(text);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (isObject(c) && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function shapeKey(o: Record<string, unknown>, payload: Record<string, unknown> | undefined): string {
  const t = typeof o.type === "string" ? o.type : "no_type";
  const pt = payload && typeof payload.type === "string" ? `/${payload.type}` : "";
  return safeLabel(t + pt);
}

function safeLabel(s: string): string {
  return /^[a-z0-9_./-]{1,60}$/i.test(s) ? s : "<unprintable>";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
