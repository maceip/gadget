import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeEvent } from "../event.js";
import { bump, emptyCounts, type EpisodicEvent, type ParseResult } from "../types.js";

// Chrome stores times as microseconds since 1601-01-01 UTC.
export const CHROME_EPOCH_OFFSET_MS = 11644473600000;

// Search-results pages whose query parameter is the search term. Used for visits that
// Chromium did not record in keyword_search_terms (e.g. an engine that is not configured
// as a search provider in that profile).
const SEARCH_URLS: Array<{ host: RegExp; path: RegExp; param: string }> = [
  { host: /(^|\.)google\.[a-z.]+$/, path: /^\/search$/, param: "q" },
  { host: /(^|\.)bing\.com$/, path: /^\/search$/, param: "q" },
  { host: /(^|\.)duckduckgo\.com$/, path: /^\/(html\/?)?$/, param: "q" },
  { host: /^search\.brave\.com$/, path: /^\/search$/, param: "q" },
  { host: /(^|\.)kagi\.com$/, path: /^\/search$/, param: "q" },
  { host: /^github\.com$/, path: /^\/search$/, param: "q" },
  { host: /(^|\.)stackoverflow\.com$/, path: /^\/search$/, param: "q" },
];

export function searchTermFromUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  for (const s of SEARCH_URLS) {
    if (s.host.test(u.hostname) && s.path.test(u.pathname)) {
      const q = u.searchParams.get(s.param)?.trim();
      return q ? q : null;
    }
  }
  return null;
}

export interface ChromiumDiscovery {
  files: string[];
  unreadableRoots: Array<{ root: string; error: string }>;
}

// Discovers <root>/<profile>/History files under the given Chromium user-data roots,
// recording roots that cannot be scanned (e.g. macOS TCC EPERM) instead of throwing.
export function discoverChromiumHistoryFiles(roots: string[]): ChromiumDiscovery {
  const found: string[] = [];
  const unreadableRoots: Array<{ root: string; error: string }> = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let names: string[];
    try {
      names = readdirSync(root);
    } catch (err) {
      unreadableRoots.push({ root, error: String(err) });
      continue;
    }
    for (const name of names) {
      const p = join(root, name, "History");
      try {
        if (statSync(p).isFile()) found.push(p);
      } catch {
        // not a profile or unreadable
      }
    }
  }
  return { files: found.sort(), unreadableRoots };
}

// Returns every <root>/<profile>/History file under the given Chromium user-data roots.
export function findChromiumHistoryFiles(roots: string[]): string[] {
  return discoverChromiumHistoryFiles(roots).files;
}

const SIDE_FILES = ["-wal", "-journal"];

function fingerprint(historyPath: string): string {
  return ["", ...SIDE_FILES]
    .map((suffix) => {
      try {
        const st = statSync(historyPath + suffix);
        return `${suffix}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${suffix}:absent`;
      }
    })
    .join("|");
}

// Copies History and its WAL/journal as one snapshot: if Chrome wrote to any of them
// while copying (size or mtime changed), the copy is retried. Throws after 5 tries.
export function snapshot(historyPath: string, dir: string, attempts = 5, fp = fingerprint): string {
  const copy = join(dir, "History");
  for (let i = 0; i < attempts; i++) {
    const before = fp(historyPath);
    for (const suffix of SIDE_FILES) rmSync(copy + suffix, { force: true });
    copyFileSync(historyPath, copy);
    for (const suffix of SIDE_FILES) {
      if (existsSync(historyPath + suffix)) copyFileSync(historyPath + suffix, copy + suffix);
    }
    if (fp(historyPath) === before) return copy;
  }
  throw new Error(`${historyPath} kept changing while being copied (${attempts} tries)`);
}

// Reads one History file. The file is copied first (Chrome keeps it locked) and the
// copy is opened read-only. Search terms become WEB_SEARCH candidates; visits to the
// search-results pages behind those terms are skipped so they are not double counted.
// Other visits to a known search-results URL become searches from the URL's query.
export function parseChromeHistory(historyPath: string): ParseResult {
  const counts = emptyCounts();
  const events: EpisodicEvent[] = [];
  const dir = mkdtempSync(join(tmpdir(), "gadget-chrome-"));
  try {
    const copy = snapshot(historyPath, dir);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
          (r) => r.name,
        ),
      );
      for (const t of ["urls", "visits"]) {
        if (!tables.has(t)) bump(counts.unknown, `missing_table:${t}`);
      }
      if (!tables.has("urls") || !tables.has("visits")) return { events, counts };

      const searchUrlIds = new Set<number>();
      if (tables.has("keyword_search_terms")) {
        const rows = db
          .prepare(
            `SELECT k.term AS term, k.url_id AS url_id, v.id AS visit_id, u.url AS url,
                    (v.visit_time / 1000) - ${CHROME_EPOCH_OFFSET_MS} AS ts_ms
               FROM keyword_search_terms k
               JOIN visits v ON v.url = k.url_id
               JOIN urls u ON u.id = k.url_id`,
          )
          .all() as Array<{ term: string; url_id: number; visit_id: number; url: string; ts_ms: number }>;
        for (const r of rows) {
          counts.read++;
          searchUrlIds.add(r.url_id);
          if (r.ts_ms <= 0) {
            bump(counts.skipped, "no_timestamp");
            continue;
          }
          events.push(
            makeEvent({
              source: "chrome",
              timestampMs: r.ts_ms,
              contentText: r.term,
              sourceUri: r.url,
              metadataJson: JSON.stringify({ kind: "search", history: historyPath, visit_id: r.visit_id }),
            }),
          );
          counts.parsed++;
        }
      } else {
        bump(counts.unknown, "missing_table:keyword_search_terms");
      }

      const visits = db
        .prepare(
          `SELECT v.id AS visit_id, u.id AS url_id, u.url AS url, u.title AS title,
                  (v.visit_time / 1000) - ${CHROME_EPOCH_OFFSET_MS} AS ts_ms
             FROM visits v JOIN urls u ON u.id = v.url`,
        )
        .all() as Array<{ visit_id: number; url_id: number; url: string; title: string | null; ts_ms: number }>;
      for (const r of visits) {
        counts.read++;
        if (searchUrlIds.has(r.url_id)) {
          bump(counts.skipped, "search_results_page");
          continue;
        }
        if (r.ts_ms <= 0) {
          bump(counts.skipped, "no_timestamp");
          continue;
        }
        const term = searchTermFromUrl(r.url);
        if (term) {
          events.push(
            makeEvent({
              source: "chrome",
              timestampMs: r.ts_ms,
              contentText: term,
              sourceUri: r.url,
              metadataJson: JSON.stringify({ kind: "search", via: "url", history: historyPath, visit_id: r.visit_id }),
            }),
          );
          counts.parsed++;
          continue;
        }
        events.push(
          makeEvent({
            source: "chrome",
            timestampMs: r.ts_ms,
            contentText: `${r.title ?? ""}\n${r.url}`.trim(),
            sourceUri: r.url,
            metadataJson: JSON.stringify({ kind: "visit", history: historyPath, visit_id: r.visit_id }),
          }),
        );
        counts.parsed++;
      }
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { events, counts };
}

// Parses ~/.gadget/capture/chrome.jsonl written by the Chrome extension capture bridge.
export function parseChromeCapture(text: string, path: string): ParseResult {
  const counts = emptyCounts();
  const events: EpisodicEvent[] = [];
  const seen = new Set<string>();

  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    counts.read++;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      bump(counts.unknown, "bad_json");
      continue;
    }
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    const ts =
      typeof rec.timestampMs === "number"
        ? Math.round(rec.timestampMs)
        : typeof rec.timestamp === "number"
          ? Math.round(rec.timestamp)
          : NaN;
    if (!url || !Number.isFinite(ts) || ts <= 0) {
      bump(counts.skipped, "invalid_record");
      continue;
    }
    const dedupeKey = `${url}|${Math.floor(ts / 1000)}`;
    if (seen.has(dedupeKey)) {
      bump(counts.skipped, "duplicate_capture");
      continue;
    }
    seen.add(dedupeKey);

    const explicitQuery = typeof rec.searchQuery === "string" ? rec.searchQuery.trim() : "";
    const term = explicitQuery || searchTermFromUrl(url);
    if (term) {
      events.push(
        makeEvent({
          source: "chrome",
          timestampMs: ts,
          contentText: term,
          sourceUri: url,
          metadataJson: JSON.stringify({ kind: "search", via: "extension", capture: path }),
        }),
      );
      counts.parsed++;
      continue;
    }

    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    const extraText =
      typeof rec.selectedText === "string" && rec.selectedText.trim()
        ? `\n${rec.selectedText.trim()}`
        : typeof rec.visibleText === "string" && rec.visibleText.trim()
          ? `\n${rec.visibleText.trim().slice(0, 400)}`
          : "";
    events.push(
      makeEvent({
        source: "chrome",
        timestampMs: ts,
        contentText: `${title}\n${url}${extraText}`.trim(),
        sourceUri: url,
        metadataJson: JSON.stringify({ kind: "visit", via: "extension", capture: path }),
      }),
    );
    counts.parsed++;
  }
  return { events, counts };
}
