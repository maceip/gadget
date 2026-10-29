// `mine probe`: prints the STRUCTURE of the owner's Codex and Antigravity files
// (record types, key names, counts) so parsers can be written against real data.
// It never prints content: values are shown only when they look like enum labels.

import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { MinerConfig } from "./config.js";
import { censusFiles, listFiles } from "./parsers/files.js";

const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,39}$/;
const SAFE_VALUE = /^[a-z][a-z0-9_.-]{0,39}$/i;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function keyList(o: Record<string, unknown>): string {
  return Object.keys(o)
    .map((k) => (SAFE_KEY.test(k) ? k : "<key>"))
    .sort()
    .join(",");
}

function label(v: unknown): string {
  return typeof v === "string" && SAFE_VALUE.test(v) ? v : typeof v;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// One line of JSON -> a structural signature with no content in it.
export function signature(o: unknown): string {
  if (!isObject(o)) return Array.isArray(o) ? "array" : typeof o;
  const parts = [`type=${label(o.type)}`, `keys={${keyList(o)}}`];
  if (isObject(o.payload)) {
    const p = o.payload;
    parts.push(`payload.type=${label(p.type)}`);
    if ("role" in p) parts.push(`payload.role=${label(p.role)}`);
    if (Array.isArray(p.content)) {
      const types = [...new Set(p.content.map((c) => (isObject(c) ? label(c.type) : typeof c)))].sort();
      parts.push(`payload.content[].type={${types.join(",")}}`);
    }
    parts.push(`payload.keys={${keyList(p)}}`);
  }
  if ("role" in o) parts.push(`role=${label(o.role)}`);
  if ("timestamp" in o) parts.push(`timestamp:${typeof o.timestamp}`);
  return parts.join(" ");
}

// The leading tag of user-role texts (e.g. "<environment_context>"), never the text.
function leadingTag(o: unknown): string | null {
  if (!isObject(o)) return null;
  const msg = isObject(o.payload) && o.payload.type === "message" ? o.payload : o.type === "message" ? o : null;
  if (!msg || msg.role !== "user" || !Array.isArray(msg.content)) return null;
  for (const c of msg.content) {
    if (isObject(c) && typeof c.text === "string") {
      const m = /^\s*<([a-z_][a-z0-9_-]{0,39})>/i.exec(c.text);
      return m ? `<${m[1]}>` : "(no leading tag)";
    }
  }
  return null;
}

function top(m: Map<string, number>, n: number): string[] {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `  ${String(v).padStart(8)}  ${k}`);
}

function probeJsonl(files: string[], out: string[]): void {
  const sigs = new Map<string, number>();
  const tags = new Map<string, number>();
  let lines = 0;
  let bad = 0;
  let skippedLarge = 0;
  for (const f of files) {
    if (statSync(f).size > MAX_FILE_BYTES) {
      skippedLarge++;
      continue;
    }
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      lines++;
      let o: unknown;
      try {
        o = JSON.parse(line);
      } catch {
        bad++;
        continue;
      }
      const s = signature(o);
      sigs.set(s, (sigs.get(s) ?? 0) + 1);
      const t = leadingTag(o);
      if (t) tags.set(t, (tags.get(t) ?? 0) + 1);
    }
  }
  out.push(`  ${files.length} files, ${lines} lines, ${bad} not JSON, ${skippedLarge} files over 50 MB skipped`);
  out.push("  record signatures (count, signature):", ...top(sigs, 60));
  if (tags.size) out.push("  user-message leading tags (count, tag):", ...top(tags, 30));
}

export function probe(cfg: MinerConfig): string {
  const out: string[] = ["gadget probe: structure only, no content", ""];

  out.push(`Codex sessions: ${cfg.codexDir}`);
  const codex = listFiles(cfg.codexDir, (p) => p.endsWith(".jsonl"));
  if (codex.length === 0) out.push("  not found or empty");
  else probeJsonl(codex, out);
  out.push("");

  out.push(`Antigravity: ${cfg.antigravityDir}`);
  const census = censusFiles(cfg.antigravityDir);
  if (census.files === 0) out.push("  not found or empty");
  else {
    out.push(`  ${census.files} files, ${census.bytes} bytes`);
    out.push("  by extension:", ...Object.entries(census.byExtension).sort().map(([k, v]) => `  ${String(v).padStart(8)}  ${k}`));
    const all = listFiles(cfg.antigravityDir);
    const jsonl = all.filter((p) => extname(p) === ".jsonl");
    const json = all.filter((p) => extname(p) === ".json");
    if (jsonl.length) {
      out.push("  .jsonl files:");
      probeJsonl(jsonl, out);
    }
    if (json.length) {
      const sigs = new Map<string, number>();
      let bad = 0;
      for (const f of json) {
        if (statSync(f).size > MAX_FILE_BYTES) continue;
        try {
          const s = signature(JSON.parse(readFileSync(f, "utf8")));
          sigs.set(s, (sigs.get(s) ?? 0) + 1);
        } catch {
          bad++;
        }
      }
      out.push(`  .json files: ${json.length}, ${bad} not JSON`, "  signatures (count, signature):", ...top(sigs, 30));
    }
  }
  return out.join("\n");
}
