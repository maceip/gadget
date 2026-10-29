import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeEvent } from "../event.js";
import { bump, emptyCounts, isObject, safeLabel, type EpisodicEvent, type ParseResult } from "../types.js";

// Finds canonical Antigravity conversation transcripts under ~/.gemini/antigravity/brain.
// Each conversation directory <brainDir>/<convId>/.system_generated/logs/ holds
// transcript_full.jsonl (untruncated) and transcript.jsonl (compact), plus per-chunk
// files under chunks/. Prefer transcript_full.jsonl and skip chunks/ so steps are not
// double-counted.
export function findAntigravityTranscripts(brainDir: string): string[] {
  if (!existsSync(brainDir)) return [];
  let entries;
  try {
    entries = readdirSync(brainDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const logsDir = join(brainDir, e.name, ".system_generated", "logs");
    const full = join(logsDir, "transcript_full.jsonl");
    const compact = join(logsDir, "transcript.jsonl");
    if (existsSync(full)) found.push(full);
    else if (existsSync(compact)) found.push(compact);
  }
  return found.sort();
}

interface PendingCommand {
  cmd: string;
  cwd: string | undefined;
  startMs: number;
  stepIndex: number | string;
}

// Parses an Antigravity transcript.jsonl / transcript_full.jsonl file.
// Documented step shapes (verified with `npm run mine -- probe`):
//   USER_INPUT       (source=USER_EXPLICIT): owner turn wrapped in <USER_REQUEST>...</USER_REQUEST>
//   PLANNER_RESPONSE (source=MODEL): assistant prose in `content` and/or tool calls in `tool_calls`
//   GENERIC          (source=MODEL): tool execution output (carries `Completed At:` and `Command exited with code N.`)
//   SYSTEM_MESSAGE, CHECKPOINT, ERROR_MESSAGE: system bookkeeping, counted as skipped.
export function parseAntigravityTranscript(text: string, path: string): ParseResult {
  const counts = emptyCounts();
  const events: EpisodicEvent[] = [];
  let cwd: string | undefined;
  let firstCwd: string | undefined;
  let pendingCmd: PendingCommand | undefined;

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
    if (!isObject(r)) {
      bump(counts.unknown, "non_object");
      return;
    }

    const type = typeof r.type === "string" ? r.type : undefined;
    const stepIndex = typeof r.step_index === "number" ? r.step_index : idx + 1;
    const ts = typeof r.created_at === "string" ? Date.parse(r.created_at) : NaN;

    if (type === "USER_INPUT") {
      pendingCmd = undefined;
      if (Number.isNaN(ts)) {
        bump(counts.skipped, "no_timestamp");
        return;
      }
      const rawContent = typeof r.content === "string" ? r.content : "";
      const extractedCwd = extractWorkspaceFromContent(rawContent);
      if (extractedCwd) {
        cwd = extractedCwd;
        if (!firstCwd) firstCwd = extractedCwd;
      }
      const prompt = extractUserRequest(rawContent);
      if (!prompt) {
        bump(counts.skipped, "empty_user_input");
        return;
      }
      events.push(
        makeEvent({
          source: "antigravity_session",
          timestampMs: ts,
          workspacePath: cwd,
          contentText: prompt,
          sourceUri: `${path}#step-${stepIndex}`,
          metadataJson: JSON.stringify({ role: "user", step_index: stepIndex }),
        }),
      );
      counts.parsed++;
      return;
    }

    if (type === "PLANNER_RESPONSE") {
      pendingCmd = undefined;
      if (Number.isNaN(ts)) {
        bump(counts.skipped, "no_timestamp");
        return;
      }
      if (Array.isArray(r.tool_calls)) {
        for (const tc of r.tool_calls) {
          if (isObject(tc) && tc.name === "run_command" && isObject(tc.args)) {
            const cmdLine = unquoteArg(tc.args.CommandLine);
            const argCwd = unquoteArg(tc.args.Cwd);
            if (argCwd) {
              cwd = argCwd;
              if (!firstCwd) firstCwd = argCwd;
            }
            if (cmdLine) {
              pendingCmd = { cmd: cmdLine, cwd: argCwd ?? cwd, startMs: ts, stepIndex };
            }
          }
        }
      }
      const content = typeof r.content === "string" ? r.content.trim() : "";
      if (!content) {
        bump(counts.skipped, "planner_tool_only");
        return;
      }
      events.push(
        makeEvent({
          source: "antigravity_session",
          timestampMs: ts,
          workspacePath: cwd,
          contentText: content,
          sourceUri: `${path}#step-${stepIndex}`,
          metadataJson: JSON.stringify({ role: "assistant", step_index: stepIndex }),
        }),
      );
      counts.parsed++;
      return;
    }

    if (type === "GENERIC") {
      const content = typeof r.content === "string" ? r.content : "";
      if (pendingCmd && content) {
        const cmd = pendingCmd;
        pendingCmd = undefined;
        const exitMatch = /^Command exited with code (\d+)\./m.exec(content);
        if (exitMatch) {
          const exit = Number(exitMatch[1]);
          const createdMatch = /^Created At:\s*(.+)$/m.exec(content);
          const completedMatch = /^Completed At:\s*(.+)$/m.exec(content);
          const startMs = createdMatch ? Date.parse(createdMatch[1]!.trim()) : cmd.startMs;
          const endMs = completedMatch ? Date.parse(completedMatch[1]!.trim()) : !Number.isNaN(ts) ? ts : startMs;
          const validStart = !Number.isNaN(startMs) ? startMs : cmd.startMs;
          const validEnd = !Number.isNaN(endMs) ? Math.max(validStart, endMs) : validStart;
          events.push(
            makeEvent({
              source: "antigravity_session",
              timestampMs: validStart,
              workspacePath: cmd.cwd,
              contentText: cmd.cmd,
              sourceUri: `${path}#step-${cmd.stepIndex}`,
              metadataJson: JSON.stringify({
                role: "tool",
                kind: "tool_command",
                exit,
                end_ms: validEnd,
                step_index: cmd.stepIndex,
              }),
            }),
          );
          counts.parsed++;
          return;
        }
      }
      pendingCmd = undefined;
      bump(counts.skipped, "tool_output");
      return;
    }

    if (type === "SYSTEM_MESSAGE" || type === "CHECKPOINT" || type === "ERROR_MESSAGE") {
      pendingCmd = undefined;
      bump(counts.skipped, type.toLowerCase());
      return;
    }

    pendingCmd = undefined;
    bump(counts.unknown, safeLabel(type ?? "no_type"));
  });

  if (firstCwd) {
    for (const e of events) {
      if (!e.workspacePath) e.workspacePath = firstCwd;
    }
  }

  return { events, counts };
}

// Extracts the owner's prompt from <USER_REQUEST>...</USER_REQUEST>, or strips system metadata blocks.
export function extractUserRequest(content: string): string {
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(content);
  if (m) return m[1]!.trim();
  return content
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
    .trim();
}

function extractWorkspaceFromContent(content: string): string | undefined {
  const m = /^Command Working Directory:\s*(\/.+)$/m.exec(content);
  if (m) return m[1]!.trim();
  const w = /^Active Workspaces:\s*\n-\s*(\/.+)$/m.exec(content);
  if (w) return w[1]!.trim();
  return undefined;
}

// In compact transcript.jsonl, tool argument values are JSON-encoded strings (`"\"git status\""`);
// in transcript_full.jsonl, they are raw strings (`"git status"`).
function unquoteArg(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed.trim() || undefined;
    } catch {
      // keep raw
    }
  }
  return trimmed;
}
