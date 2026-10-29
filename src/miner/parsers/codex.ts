import { makeEvent } from "../event.js";
import { bump, emptyCounts, type EpisodicEvent, type ParseResult } from "../types.js";

// Parses a Codex CLI rollout file (~/.codex/sessions/**/*.jsonl).
//
// Verified against the owner's files via `npm run mine -- probe`. Recognized:
//   {"type":"session_meta","payload":{"cwd":...}}                       -> workspace
//   {"type":"turn_context","payload":{"cwd":...}}                       -> workspace update
//   {"timestamp":ISO,"type":"response_item","payload":{"type":"message","role":...,"content":[{"text":...}]}}
//   {"timestamp":ISO,"type":"message","role":...,"content":[...]}       -> older top-level shape
//   {"timestamp":ISO,"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution",...}}}
//   {"timestamp":ISO,"type":"response_item","payload":{"type":"function_call","name":"exec_command",...}} + function_call_output
// Everything else is counted as skipped or unknown by type, never dropped silently.
export function parseCodexSession(text: string, path: string): ParseResult {
  const counts = emptyCounts();
  const events: EpisodicEvent[] = [];
  let cwd: string | undefined;
  const pendingExec = new Map<string, { cmd: string; cwd: string | undefined; startMs: number; line: number }>();

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

    if (o.type === "turn_context") {
      if (payload && typeof payload.cwd === "string") cwd = payload.cwd;
      bump(counts.skipped, "turn_context");
      return;
    }

    if (o.type === "event_msg" && payload?.type === "item_completed" && isObject(payload.item)) {
      const item = payload.item;
      if (item.type === "CommandExecution") {
        const cmd = extractCommandText(item.command);
        const startMs =
          typeof payload.started_at_ms === "number"
            ? payload.started_at_ms
            : typeof o.timestamp === "string"
              ? Date.parse(o.timestamp)
              : NaN;
        const endMs = typeof payload.completed_at_ms === "number" ? payload.completed_at_ms : startMs;
        const exit = typeof item.exit_code === "number" ? item.exit_code : undefined;
        const itemCwd = typeof item.cwd === "string" ? item.cwd : cwd;
        if (!cmd || Number.isNaN(startMs) || exit === undefined) {
          bump(counts.skipped, "incomplete_command_execution");
          return;
        }
        events.push(
          makeEvent({
            source: "codex_session",
            timestampMs: startMs,
            workspacePath: itemCwd,
            contentText: cmd,
            sourceUri: `${path}#${idx + 1}`,
            metadataJson: JSON.stringify({ role: "tool", kind: "tool_command", exit, end_ms: Math.max(startMs, endMs) }),
          }),
        );
        counts.parsed++;
        return;
      }
    }

    if (
      o.type === "response_item" &&
      payload?.type === "function_call" &&
      payload.name === "exec_command" &&
      typeof payload.call_id === "string" &&
      typeof payload.arguments === "string"
    ) {
      try {
        const args = JSON.parse(payload.arguments) as Record<string, unknown>;
        const startMs = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
        if (typeof args.cmd === "string" && args.cmd.trim() && !Number.isNaN(startMs)) {
          pendingExec.set(payload.call_id, {
            cmd: args.cmd.trim(),
            cwd: typeof args.workdir === "string" ? args.workdir : cwd,
            startMs,
            line: idx + 1,
          });
          bump(counts.skipped, "exec_command_call");
          return;
        }
      } catch {
        // fall through
      }
    }

    if (
      o.type === "response_item" &&
      payload?.type === "function_call_output" &&
      typeof payload.call_id === "string" &&
      pendingExec.has(payload.call_id)
    ) {
      const call = pendingExec.get(payload.call_id)!;
      pendingExec.delete(payload.call_id);
      const exit = extractExitCode(payload.output);
      const endMs = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : call.startMs;
      if (exit === undefined || Number.isNaN(endMs)) {
        bump(counts.skipped, "incomplete_exec_command_output");
        return;
      }
      events.push(
        makeEvent({
          source: "codex_session",
          timestampMs: call.startMs,
          workspacePath: call.cwd,
          contentText: call.cmd,
          sourceUri: `${path}#${call.line}`,
          metadataJson: JSON.stringify({ role: "tool", kind: "tool_command", exit, end_ms: Math.max(call.startMs, endMs) }),
        }),
      );
      counts.parsed++;
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
    // The CLI injects context (environment, instructions) as user turns wrapped in tags.
    // Strip complete leading tag blocks and keep whatever the owner wrote after them.
    const text = role === "user" ? stripLeadingContext(content) : content;
    if (!text) {
      bump(counts.skipped, "injected_context");
      return;
    }
    events.push(
      makeEvent({
        source: "codex_session",
        timestampMs: ts,
        workspacePath: cwd,
        contentText: text,
        sourceUri: `${path}#${idx + 1}`,
        metadataJson: JSON.stringify(text === content ? { role } : { role, stripped_leading_context: true }),
      }),
    );
    counts.parsed++;
  });
  return { events, counts };
}

// Known tool-injected leading tag names in Codex user messages. Only these are stripped
// so user-authored XML blocks (e.g. <context>...</context> or <request>...</request>) stay intact.
export const INJECTED_CONTEXT_TAGS = new Set([
  "environment_context",
  "user_instructions",
  "instructions",
  "permissions",
  "collaboration_mode",
  "skills",
  "automation",
  "ide_context",
  "system-reminder",
  "user_action",
  "turn_aborted",
  "subagent_notification",
  "additional_metadata",
  "user_settings_change",
  "send_user_message_question_reply",
  "external_codex_apps_writing_block_edits",
  "external_codex_apps_open_page",
]);

// Removes complete tool-injected <tag>...</tag> blocks at the start of a message. A message
// that is only such blocks becomes "" (injected context). An unclosed or non-injected tag is kept.
export function stripLeadingContext(text: string): string {
  let rest = text;
  for (;;) {
    const m = /^\s*<([a-z_][a-z0-9_-]*)>[\s\S]*?<\/\1>/i.exec(rest);
    if (!m || !INJECTED_CONTEXT_TAGS.has(m[1]!.toLowerCase())) break;
    rest = rest.slice(m[0].length);
  }
  return rest.trim();
}

function extractCommandText(command: unknown): string {
  if (typeof command === "string") return command.trim();
  if (Array.isArray(command)) {
    if (command.length >= 3 && typeof command[2] === "string" && (command[1] === "-lc" || command[1] === "-c")) {
      return command[2].trim();
    }
    const strs = command.filter((x): x is string => typeof x === "string");
    return strs.join(" ").trim();
  }
  return "";
}

function extractExitCode(output: unknown): number | undefined {
  if (typeof output === "string") {
    const m = /(?:Process exited with code|Exit code:)\s*(\d+)/.exec(output);
    if (m) return Number(m[1]);
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      if (isObject(parsed.metadata) && typeof parsed.metadata.exit_code === "number") {
        return parsed.metadata.exit_code;
      }
    } catch {
      // plain string
    }
  }
  return undefined;
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
