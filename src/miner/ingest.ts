import { existsSync, readFileSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MinerConfig } from "./config.js";
import { parseChromeHistory, findChromiumHistoryFiles } from "./parsers/chrome.js";
import { parseCodexSession } from "./parsers/codex.js";
import { censusFiles, listFiles } from "./parsers/files.js";
import { discoverRepos, readGitRepo } from "./parsers/git.js";
import { parseZshHistory } from "./parsers/zsh_history.js";
import { dedupeHistoryAgainstHook, parseZshHook } from "./parsers/zsh_hook.js";
import { classifyEvent } from "./seek.js";
import { EventStore } from "./store.js";
import { bump, emptyCounts, mergeCounts, type EpisodicEvent, type ParseCounts } from "./types.js";

export interface IngestRow {
  source: string;
  label: string;
  counts: ParseCounts;
  note?: string;
}

export interface IngestSummary {
  rows: IngestRow[];
  inserted: number;
  seeks: number;
}

// Rebuilds the event store from the owner's files. Sources are only read; the Chrome
// database is copied before opening. The store is written to a temp file and renamed
// into place, so a failed run never leaves a half-built store.
export function ingest(cfg: MinerConfig): IngestSummary {
  mkdirSync(dirname(cfg.dbPath), { recursive: true, mode: 0o700 });
  const tmp = cfg.dbPath + ".building";
  rmSync(tmp, { force: true });
  const store = new EventStore(tmp);
  const rows: IngestRow[] = [];
  let inserted = 0;
  let seeks = 0;

  const insertEvents = (events: EpisodicEvent[]) => {
    const classified = events.map((event) => ({ event, seek: classifyEvent(event) }));
    seeks += classified.filter((c) => c.seek).length;
    inserted += store.insert(classified);
  };
  const record = (source: string, label: string, counts: ParseCounts, note?: string) => {
    store.recordCounts(source, label, counts);
    rows.push(note ? { source, label, counts, note } : { source, label, counts });
  };
  const add = (source: string, label: string, events: EpisodicEvent[], counts: ParseCounts, note?: string) => {
    insertEvents(events);
    record(source, label, counts, note);
  };
  const missing = (source: string, label: string) => {
    store.recordCounts(source, label, emptyCounts());
    rows.push({ source, label, counts: emptyCounts(), note: "not found" });
  };

  try {
    // zsh: the hook first, so history entries it also recorded can be dropped.
    let hookEvents: EpisodicEvent[] = [];
    if (existsSync(cfg.zshHook)) {
      const r = parseZshHook(readFileSync(cfg.zshHook, "utf8"), cfg.zshHook);
      hookEvents = r.events;
      add("zsh_hook", cfg.zshHook, r.events, r.counts);
    } else missing("zsh_hook", cfg.zshHook);

    if (existsSync(cfg.zshHistory)) {
      const r = parseZshHistory(readFileSync(cfg.zshHistory), cfg.zshHistory);
      const { kept, dropped } = dedupeHistoryAgainstHook(r.events, hookEvents);
      if (dropped > 0) {
        bump(r.counts.skipped, "also_in_zsh_hook", dropped);
        r.counts.parsed -= dropped;
      }
      add("zsh", cfg.zshHistory, kept, r.counts);
    } else missing("zsh", cfg.zshHistory);

    const histories = findChromiumHistoryFiles(cfg.chromiumRoots);
    if (histories.length === 0) missing("chrome", cfg.chromiumRoots.join(", "));
    for (const h of histories) {
      let r;
      try {
        r = parseChromeHistory(h);
      } catch (err) {
        const counts = emptyCounts();
        bump(counts.unknown, "unreadable_history_db");
        add("chrome", h, [], counts, String(err));
        continue;
      }
      add("chrome", h, r.events, r.counts);
    }

    const sessions = listFiles(cfg.codexDir, (p) => p.endsWith(".jsonl"));
    if (sessions.length === 0) missing("codex_session", cfg.codexDir);
    else {
      const counts = emptyCounts();
      for (const s of sessions) {
        const r = parseCodexSession(readFileSync(s, "utf8"), s);
        insertEvents(r.events);
        mergeCounts(counts, r.counts);
      }
      record("codex_session", `${cfg.codexDir} (${sessions.length} files)`, counts);
    }

    const census = censusFiles(cfg.antigravityDir);
    if (census.files === 0) missing("antigravity_session", cfg.antigravityDir);
    else {
      const counts = emptyCounts();
      counts.read = census.files;
      bump(counts.skipped, "no_parser_yet", census.files);
      add("antigravity_session", cfg.antigravityDir, [], counts, `${census.files} files, ${census.bytes} bytes; not parsed`);
    }

    const repos = discoverRepos(cfg.gitRoots, cfg.gitMaxDepth);
    if (repos.length === 0) missing("git", cfg.gitRoots.join(", "));
    else {
      const counts = emptyCounts();
      for (const repo of repos) {
        const r = readGitRepo(repo, cfg.maxCommitsPerRepo);
        insertEvents(r.events);
        mergeCounts(counts, r.counts);
      }
      record("git", `${repos.length} repos under ${cfg.gitRoots.join(", ")}`, counts);
    }
    store.close();
    renameSync(tmp, cfg.dbPath);
  } catch (err) {
    try {
      store.close();
    } catch {
      // already closed
    }
    rmSync(tmp, { force: true });
    throw err;
  }
  return { rows, inserted, seeks };
}

export function formatIngestTable(s: IngestSummary): string {
  const header = ["source", "read", "parsed", "skipped", "unknown", "detail"];
  const body = s.rows.map((r) => [
    r.source,
    String(r.counts.read),
    String(r.counts.parsed),
    describe(r.counts.skipped),
    describe(r.counts.unknown),
    r.note ? `${r.note}: ${r.label}` : r.label,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const fmt = (row: string[]) => row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]!))).join("  ");
  return [fmt(header), ...body.map(fmt), "", `events stored: ${s.inserted}   seek actions: ${s.seeks}`].join("\n");
}

function describe(m: Record<string, number>): string {
  const entries = Object.entries(m);
  if (entries.length === 0) return "0";
  const total = entries.reduce((a, [, v]) => a + v, 0);
  return `${total} (${entries.map(([k, v]) => `${k}=${v}`).join(", ")})`;
}
