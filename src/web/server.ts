// Local Episode Tagging Workbench & Chrome Extension Capture Server.
// Runs on 127.0.0.1:4321 by default. Never makes outbound network calls.

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { evaluateCeiling } from "../miner/ceiling.js";
import type { MinerConfig } from "../miner/config.js";
import { buildEpisodes } from "../miner/episodes.js";
import { ingest } from "../miner/ingest.js";
import { assertOutsideRepo } from "../miner/paths.js";
import { sampleIndices, writeReport } from "../miner/report.js";
import { parseMeta } from "../miner/seek.js";
import { EventStore } from "../miner/store.js";
import { renderWorkbenchHtml } from "./ui.js";

export interface EpisodeLabel {
  realSeeking: "" | "Y" | "N";
  answerInMyData: "" | "Y" | "N";
  note: string;
}

export interface WorkbenchHitView {
  eventId: string;
  source: string;
  timestampMs: number;
  timestampIso: string;
  sourceUri: string;
  snippet: string;
  fullText: string;
}

export interface WorkbenchEpisodeView {
  sampleIndex: number;
  episodeId: string;
  seekStartMs: number;
  seekStartIso: string;
  primaryKind: string;
  primaryQuery: string;
  seekActions: Array<{
    kind: string;
    query: string;
    eventId: string;
    source: string;
    sourceUri: string;
  }>;
  contextEvents: Array<{
    eventId: string;
    timeUtc: string;
    source: string;
    contentText: string;
    exit?: number;
  }>;
  keyTokens: string[];
  repeatSeek: boolean;
  resolutionSummary: string;
  topHit: WorkbenchHitView | null;
  topHitOlderThanDay: WorkbenchHitView | null;
  label: EpisodeLabel;
}

export interface WorkbenchMetrics {
  totalSampled: number;
  labeledCount: number;
  realSeekingYes: number;
  realSeekingNo: number;
  answerInDataYes: number;
  answerInDataNo: number;
  phase0GatePassed: boolean;
  ceilingLocalHit: string;
  ceilingOlderThanDay: string;
  repeatSeek: string;
}

export interface WorkbenchState {
  reportDir: string;
  reportPath: string;
  labelsPath: string;
  episodes: WorkbenchEpisodeView[];
  metrics: WorkbenchMetrics;
  capture: {
    zshLogPath: string;
    zshCaptureLines: number;
    chromeLogPath: string;
    chromeCaptureLines: number;
  };
}

export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

export function formatCsvField(s: string): string {
  const clean = s.replace(/[\r\n]+/g, " ");
  const safe = /^[=+\-@]/.test(clean) ? `'${clean}` : clean;
  return /[",]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface LabelsCsvRow {
  episode_id: string;
  real_seeking: "" | "Y" | "N";
  answer_in_my_data: "" | "Y" | "N";
  note: string;
}

export function readLabelsCsv(labelsPath: string): LabelsCsvRow[] {
  if (!existsSync(labelsPath)) return [];
  const lines = readFileSync(labelsPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];
  const rows: LabelsCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]!);
    const rs = (cols[1] ?? "").trim().toUpperCase();
    const ad = (cols[2] ?? "").trim().toUpperCase();
    rows.push({
      episode_id: cols[0] ?? "",
      real_seeking: rs === "Y" || rs === "N" ? rs : "",
      answer_in_my_data: ad === "Y" || ad === "N" ? ad : "",
      note: (cols[3] ?? "").replace(/^'(?=[=+\-@])/, ""),
    });
  }
  return rows;
}

export function writeLabelsCsv(labelsPath: string, rows: LabelsCsvRow[]): void {
  assertOutsideRepo(labelsPath, "labels.csv");
  const header = "episode_id,real_seeking_YN,answer_in_my_data_YN,notes";
  const out = [header];
  for (const r of rows) {
    out.push([r.episode_id, r.real_seeking, r.answer_in_my_data, formatCsvField(r.note)].join(","));
  }
  writeFileSync(labelsPath, out.join("\n") + "\n", { mode: 0o600 });
  chmodSync(labelsPath, 0o600);
}

export function ensureLatestReportDir(cfg: MinerConfig): string {
  if (!existsSync(cfg.dbPath)) {
    ingest(cfg);
  }
  mkdirSync(cfg.reportsDir, { recursive: true, mode: 0o700 });
  const existing = readdirSync(cfg.reportsDir)
    .map((name) => join(cfg.reportsDir, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory() && existsSync(join(p, "labels.csv"));
      } catch {
        return false;
      }
    })
    .sort();
  if (existing.length > 0) {
    return existing.at(-1)!;
  }

  const store = new EventStore(cfg.dbPath, { readOnly: true });
  try {
    const events = store.allEventsSorted();
    const counts = store.readCounts();
    const episodes = buildEpisodes(events, cfg);
    const ceiling = evaluateCeiling(episodes, store);
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const outDir = join(cfg.reportsDir, stamp);
    writeReport({ cfg, counts, events, episodes, ceiling, generatedAt: now }, outDir);
    return outDir;
  } finally {
    store.close();
  }
}

function countNonEmptyLines(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  try {
    const text = readFileSync(filePath, "utf8");
    let count = 0;
    for (const l of text.split("\n")) {
      if (l.trim()) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

export function buildWorkbenchState(cfg: MinerConfig, reportDirOverride?: string): WorkbenchState {
  const reportDir = reportDirOverride ?? ensureLatestReportDir(cfg);
  const labelsPath = join(reportDir, "labels.csv");
  const reportPath = join(reportDir, "report.md");
  const csvRows = readLabelsCsv(labelsPath);
  const labelByEpisodeId = new Map<string, EpisodeLabel>();
  for (const r of csvRows) {
    labelByEpisodeId.set(r.episode_id, {
      realSeeking: r.real_seeking,
      answerInMyData: r.answer_in_my_data,
      note: r.note,
    });
  }

  const store = new EventStore(cfg.dbPath, { readOnly: true });
  try {
    const events = store.allEventsSorted();
    const byId = new Map(events.map((e) => [e.eventId, e]));
    const episodes = buildEpisodes(events, cfg);
    const ceiling = evaluateCeiling(episodes, store);
    const evalById = new Map(ceiling.evals.map((e) => [e.episodeId, e]));
    const picks = sampleIndices(episodes.length, cfg.sampleSize, cfg.seed);

    const hydrateHit = (h: { eventId: string; source: string; timestampMs: number; sourceUri: string; snippet: string } | null): WorkbenchHitView | null => {
      if (!h) return null;
      const fullEv = store.getEventById(h.eventId);
      return {
        eventId: h.eventId,
        source: h.source,
        timestampMs: h.timestampMs,
        timestampIso: new Date(h.timestampMs).toISOString(),
        sourceUri: h.sourceUri,
        snippet: h.snippet,
        fullText: fullEv ? fullEv.contentText.slice(0, 2000) : h.snippet,
      };
    };

    const views: WorkbenchEpisodeView[] = picks.map((epIdx, i) => {
      const ep = episodes[epIdx]!;
      const ev = evalById.get(ep.episodeId)!;
      const firstAction = ep.seekActions[0];
      const seekActions = ep.seekActions.map((a) => {
        const srcEv = byId.get(a.eventId);
        return {
          kind: a.kind,
          query: a.query,
          eventId: a.eventId,
          source: srcEv?.source ?? "unknown",
          sourceUri: srcEv?.sourceUri ?? "",
        };
      });
      const contextEvents = ep.contextEventIds.slice(-15).map((cid) => {
        const fullEv = store.getEventById(cid);
        const meta = fullEv ? parseMeta(fullEv.metadataJson) : {};
        return {
          eventId: cid,
          timeUtc: fullEv ? new Date(fullEv.timestampMs).toISOString().slice(11, 19) : "",
          source: fullEv?.source ?? "unknown",
          contentText: fullEv ? fullEv.contentText.slice(0, 1200) : "",
          ...(typeof meta.exit === "number" ? { exit: meta.exit } : {}),
        };
      });

      const resolutionSummary = ep.resolution
        ? `${ep.resolution.kind} after ${((ep.costMs ?? 0) / 60000).toFixed(1)} min (${ep.resolution.sourceUri ?? ""})`
        : "unresolved within window";

      const label = labelByEpisodeId.get(ep.episodeId) ?? {
        realSeeking: "",
        answerInMyData: "",
        note: "",
      };

      return {
        sampleIndex: i + 1,
        episodeId: ep.episodeId,
        seekStartMs: ep.seekStartMs,
        seekStartIso: new Date(ep.seekStartMs).toISOString(),
        primaryKind: firstAction?.kind ?? "",
        primaryQuery: firstAction?.query ?? "",
        seekActions,
        contextEvents,
        keyTokens: ev.keyTokens,
        repeatSeek: ev.repeatSeek,
        resolutionSummary,
        topHit: hydrateHit(ev.hit),
        topHitOlderThanDay: hydrateHit(ev.hitOlderThanDay),
        label,
      };
    });

    const pct = (num: number, den: number) => (den === 0 ? "0/0 (n/a)" : `${num}/${den} (${((100 * num) / den).toFixed(1)}%)`);
    const metrics = computeMetrics(
      views.map((v) => v.label),
      pct(ceiling.localHit.num, ceiling.localHit.den),
      pct(ceiling.localHitOlderThanDay.num, ceiling.localHitOlderThanDay.den),
      pct(ceiling.repeatSeek.num, ceiling.repeatSeek.den),
    );

    const chromeLogPath = join(dirname(cfg.zshHook), "chrome.jsonl");
    return {
      reportDir,
      reportPath,
      labelsPath,
      episodes: views,
      metrics,
      capture: {
        zshLogPath: cfg.zshHook,
        zshCaptureLines: countNonEmptyLines(cfg.zshHook),
        chromeLogPath,
        chromeCaptureLines: countNonEmptyLines(chromeLogPath),
      },
    };
  } finally {
    store.close();
  }
}

function computeMetrics(
  labels: EpisodeLabel[],
  ceilingLocalHit: string,
  ceilingOlderThanDay: string,
  repeatSeek: string,
): WorkbenchMetrics {
  let labeledCount = 0;
  let realSeekingYes = 0;
  let realSeekingNo = 0;
  let answerInDataYes = 0;
  let answerInDataNo = 0;

  for (const l of labels) {
    if (l.realSeeking !== "" && l.answerInMyData !== "") labeledCount++;
    if (l.realSeeking === "Y") realSeekingYes++;
    if (l.realSeeking === "N") realSeekingNo++;
    if (l.answerInMyData === "Y") answerInDataYes++;
    if (l.answerInMyData === "N") answerInDataNo++;
  }

  return {
    totalSampled: labels.length,
    labeledCount,
    realSeekingYes,
    realSeekingNo,
    answerInDataYes,
    answerInDataNo,
    phase0GatePassed: realSeekingYes >= 20,
    ceilingLocalHit,
    ceilingOlderThanDay,
    repeatSeek,
  };
}

export function updateEpisodeLabelOnDisk(
  cfg: MinerConfig,
  episodeId: string,
  patch: Partial<EpisodeLabel>,
  reportDirOverride?: string,
): { ok: boolean; label: EpisodeLabel; metrics: WorkbenchMetrics } {
  const reportDir = reportDirOverride ?? ensureLatestReportDir(cfg);
  const labelsPath = join(reportDir, "labels.csv");
  const rows = readLabelsCsv(labelsPath);
  const target = rows.find((r) => r.episode_id === episodeId);
  if (!target) {
    throw new Error(`Episode ${episodeId} not found in ${labelsPath}`);
  }
  if (patch.realSeeking !== undefined) {
    const rs = patch.realSeeking.toUpperCase();
    target.real_seeking = rs === "Y" || rs === "N" ? rs : "";
  }
  if (patch.answerInMyData !== undefined) {
    const ad = patch.answerInMyData.toUpperCase();
    target.answer_in_my_data = ad === "Y" || ad === "N" ? ad : "";
  }
  if (patch.note !== undefined) {
    target.note = String(patch.note);
  }
  writeLabelsCsv(labelsPath, rows);

  const state = buildWorkbenchState(cfg, reportDir);
  return {
    ok: true,
    label: {
      realSeeking: target.real_seeking,
      answerInMyData: target.answer_in_my_data,
      note: target.note,
    },
    metrics: state.metrics,
  };
}

export function appendChromeCaptureEvents(cfg: MinerConfig, rawEvents: unknown[]): number {
  const chromeLogPath = join(dirname(cfg.zshHook), "chrome.jsonl");
  assertOutsideRepo(chromeLogPath, "chrome capture log");
  mkdirSync(dirname(chromeLogPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(chromeLogPath), 0o700);

  let appended = 0;
  const lines: string[] = [];
  for (const item of rawEvents) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const url = typeof obj.url === "string" ? obj.url.trim() : "";
    if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
    const timestampMs =
      typeof obj.timestampMs === "number"
        ? Math.round(obj.timestampMs)
        : typeof obj.timestamp === "number"
          ? Math.round(obj.timestamp)
          : Date.now();
    lines.push(
      JSON.stringify({
        type: typeof obj.type === "string" ? obj.type : "PAGE_VIEW",
        url,
        title: typeof obj.title === "string" ? obj.title : url,
        timestampMs,
        ...(typeof obj.searchQuery === "string" && obj.searchQuery ? { searchQuery: obj.searchQuery } : {}),
        ...(typeof obj.visibleText === "string" && obj.visibleText ? { visibleText: obj.visibleText.slice(0, 1500) } : {}),
        ...(typeof obj.selectedText === "string" && obj.selectedText ? { selectedText: obj.selectedText.slice(0, 800) } : {}),
      }),
    );
    appended++;
  }
  if (lines.length > 0) {
    appendFileSync(chromeLogPath, lines.join("\n") + "\n", { mode: 0o600 });
    chmodSync(chromeLogPath, 0o600);
  }
  return appended;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 10 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // No CORS headers: the workbench page is same-origin and the extension's service worker
  // has host_permissions, so neither needs them. Any other web page must not read these.
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// The only paths the capture extension calls.
const EXTENSION_PATHS = new Set(["/api/capture/chrome", "/api/shadow/browser", "/api/status"]);

// Every response holds the owner's private data and every POST changes it, so only these
// callers are served:
// - Host must name this server on loopback. A web page that points its own domain at
//   127.0.0.1 (DNS rebinding) sends its own name here and is refused.
// - Origin, when present, must be this server's own origin, or the capture extension for
//   the paths it uses. Browsers send Origin on every cross-origin read and on every POST,
//   so another site's page cannot read state or write labels or capture events.
// - Sec-Fetch-Site, when present, must be same-origin or none (typed URL), which also
//   refuses cross-site requests that carry no Origin (an <img> or <script> GET).
// Clients with no Origin and no Sec-Fetch-Site are local programs, not web pages.
export function requestAllowed(
  headers: IncomingMessage["headers"],
  port: number,
  pathname: string,
): boolean {
  const host = headers.host ?? "";
  const names = ["127.0.0.1", "localhost", "[::1]"];
  // On port 80, clients send Host (and Origin) without the port.
  const hosts = names.map((n) => `${n}:${port}`).concat(port === 80 ? names : []);
  if (!hosts.includes(host)) return false;
  const origin = headers.origin;
  if (origin !== undefined) {
    if (origin.startsWith("chrome-extension://")) return EXTENSION_PATHS.has(pathname);
    if (origin !== `http://${host}`) return false;
  }
  const site = headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

export function startWorkbenchServer(
  cfg: MinerConfig,
  opts: { port?: number; host?: string } = {},
): Promise<{ server: Server; port: number; url: string; getReportDir: () => string }> {
  let activeReportDir = ensureLatestReportDir(cfg);
  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 4321;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const urlObj = new URL(req.url ?? "/", `http://${host}`);
      const pathname = urlObj.pathname;
      const addr = server.address();
      const listeningPort = typeof addr === "object" && addr ? addr.port : requestedPort;
      if (!requestAllowed(req.headers, listeningPort, pathname)) {
        sendJson(res, 403, { ok: false, error: "forbidden: not this workbench's own page or capture extension" });
        return;
      }

      if (req.method === "OPTIONS") {
        sendJson(res, 204, {});
        return;
      }

      if (req.method === "GET" && pathname === "/") {
        const html = renderWorkbenchHtml();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && pathname === "/api/state") {
        const state = buildWorkbenchState(cfg, activeReportDir);
        sendJson(res, 200, state);
        return;
      }

      if (req.method === "GET" && pathname === "/api/status") {
        const state = buildWorkbenchState(cfg, activeReportDir);
        sendJson(res, 200, {
          labeledCount: state.metrics.labeledCount,
          totalSampled: state.metrics.totalSampled,
          realSeekingYes: state.metrics.realSeekingYes,
          answerInDataYes: state.metrics.answerInDataYes,
          zshCaptureLines: state.capture.zshCaptureLines,
          chromeCaptureLines: state.capture.chromeCaptureLines,
        });
        return;
      }

      const labelMatch = /^\/api\/episodes\/([^/]+)\/label$/.exec(pathname);
      if (req.method === "POST" && labelMatch) {
        const episodeId = decodeURIComponent(labelMatch[1]!);
        const body = await readJsonBody(req);
        const updated = updateEpisodeLabelOnDisk(
          cfg,
          episodeId,
          {
            realSeeking: typeof body.realSeeking === "string" ? (body.realSeeking as "" | "Y" | "N") : undefined,
            answerInMyData:
              typeof body.answerInMyData === "string" ? (body.answerInMyData as "" | "Y" | "N") : undefined,
            note: typeof body.note === "string" ? body.note : undefined,
          },
          activeReportDir,
        );
        sendJson(res, 200, updated);
        return;
      }

      if (req.method === "POST" && (pathname === "/api/capture/chrome" || pathname === "/api/shadow/browser")) {
        const body = await readJsonBody(req);
        const batch = Array.isArray(body.events) ? body.events : [body];
        const appended = appendChromeCaptureEvents(cfg, batch);
        sendJson(res, 200, { ok: true, appended });
        return;
      }

      if (req.method === "POST" && pathname === "/api/reingest") {
        const prevRows = readLabelsCsv(join(activeReportDir, "labels.csv"));
        const prevByEp = new Map(prevRows.map((r) => [r.episode_id, r]));

        ingest(cfg);
        const store = new EventStore(cfg.dbPath, { readOnly: true });
        try {
          const events = store.allEventsSorted();
          const counts = store.readCounts();
          const episodes = buildEpisodes(events, cfg);
          const ceiling = evaluateCeiling(episodes, store);
          const now = new Date();
          const stamp = now.toISOString().replace(/[:.]/g, "-");
          const newDir = join(cfg.reportsDir, stamp);
          writeReport({ cfg, counts, events, episodes, ceiling, generatedAt: now }, newDir);

          // Carry over existing owner labels by episode_id
          const newLabelsPath = join(newDir, "labels.csv");
          const newRows = readLabelsCsv(newLabelsPath);
          for (const nr of newRows) {
            const old = prevByEp.get(nr.episode_id);
            if (old) {
              nr.real_seeking = old.real_seeking;
              nr.answer_in_my_data = old.answer_in_my_data;
              nr.note = old.note;
            }
          }
          writeLabelsCsv(newLabelsPath, newRows);
          activeReportDir = newDir;
        } finally {
          store.close();
        }

        const state = buildWorkbenchState(cfg, activeReportDir);
        sendJson(res, 200, { ok: true, state });
        return;
      }

      if (req.method === "POST" && pathname === "/api/write-status") {
        const state = buildWorkbenchState(cfg, activeReportDir);
        let sha = "unknown";
        try {
          sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        } catch {
          // ignore
        }
        const statusMd = [
          "# Phase 0 Status",
          "",
          `- **Commit SHA:** \`${sha}\``,
          `- **Report directory:** \`${state.reportDir}\``,
          `- **Repeat-seek rate:** ${state.metrics.repeatSeek}`,
          `- **Local-hit rate:** ${state.metrics.ceilingLocalHit}`,
          `- **Local-hit rate (>1 day old):** ${state.metrics.ceilingOlderThanDay}`,
          `- **Sampled episodes labeled:** ${state.metrics.labeledCount} / ${state.metrics.totalSampled}`,
          `- **Real seeking (Y):** ${state.metrics.realSeekingYes} / ${state.metrics.labeledCount} (Phase 0 gate >= 20: ${state.metrics.phase0GatePassed ? "PASS" : "PENDING"})`,
          `- **Answer in my data (Y):** ${state.metrics.answerInDataYes} / ${state.metrics.labeledCount}`,
          "",
        ].join("\n");
        const statusPath = join(dirname(cfg.dbPath), "STATUS.md");
        assertOutsideRepo(statusPath, "STATUS.md");
        writeFileSync(statusPath, statusMd, { mode: 0o600 });
        sendJson(res, 200, { ok: true, statusPath });
        return;
      }

      sendJson(res, 404, { ok: false, error: `Not found: ${pathname}` });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : requestedPort;
      resolve({
        server,
        port,
        url: `http://${host}:${port}`,
        getReportDir: () => activeReportDir,
      });
    });
  });
}
