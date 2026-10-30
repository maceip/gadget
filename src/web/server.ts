// Local Loopback Skypanel HUD & Capture Server (`src/web/server.ts`).
// Runs on 127.0.0.1:4321 by default. Never makes outbound network calls.

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import type { MinerConfig } from "../miner/config.js";
import { ingest } from "../miner/ingest.js";
import { parseAndroidCapture } from "../miner/parsers/messages_calendar.js";
import { assertOutsideRepo } from "../miner/paths.js";
import { withSeeks } from "../miner/seek.js";
import { EventStore } from "../miner/store.js";
import { inferActiveSurface, type SkypanelExecutionMode } from "../triggers/skypanel_composer.js";
import {
  executeCardOnSpine,
  reviseCardOnSpine,
  runFunctionalSpine,
} from "../triggers/spine.js";
import { renderSkypanelHtml } from "./skypanel_ui.js";

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
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const EXTENSION_PATHS = new Set(["/api/capture/chrome", "/api/shadow/browser", "/api/status"]);

export function requestAllowed(
  headers: IncomingMessage["headers"],
  port: number,
  pathname: string,
): boolean {
  const host = headers.host ?? "";
  const names = ["127.0.0.1", "localhost", "[::1]"];
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
  opts: { port?: number; host?: string; workspacePath?: string } = {},
): Promise<{ server: Server; port: number; url: string }> {
  if (!existsSync(cfg.dbPath)) {
    mkdirSync(dirname(cfg.dbPath), { recursive: true, mode: 0o700 });
    const initStore = new EventStore(cfg.dbPath);
    initStore.close();
  }
  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 4321;
  const workspacePath = opts.workspacePath ?? process.cwd();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const urlObj = new URL(req.url ?? "/", `http://${host}`);
      const pathname = urlObj.pathname;
      const addr = server.address();
      const listeningPort = typeof addr === "object" && addr ? addr.port : requestedPort;
      if (!requestAllowed(req.headers, listeningPort, pathname)) {
        sendJson(res, 403, { ok: false, error: "forbidden: not this server's own page or capture extension" });
        return;
      }

      if (req.method === "OPTIONS") {
        sendJson(res, 204, {});
        return;
      }

      if (req.method === "GET" && (pathname === "/" || pathname === "/skypanel")) {
        const html = renderSkypanelHtml();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && pathname === "/api/status") {
        const chromeLogPath = join(dirname(cfg.zshHook), "chrome.jsonl");
        const store = new EventStore(cfg.dbPath);
        try {
          const cards = store.listSkypanelCards({ limit: 3 });
          sendJson(res, 200, {
            ok: true,
            visibleCardsCount: cards.length,
            zshCaptureLines: countNonEmptyLines(cfg.zshHook),
            chromeCaptureLines: countNonEmptyLines(chromeLogPath),
          });
        } finally {
          store.close();
        }
        return;
      }

      if (req.method === "GET" && pathname === "/api/skypanel") {
        const store = new EventStore(cfg.dbPath);
        try {
          const cards = store.listSkypanelCards({ limit: 3 });
          const activeSurface = inferActiveSurface(store);
          sendJson(res, 200, {
            ok: true,
            activeSurface,
            cards,
          });
        } finally {
          store.close();
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/skypanel/utterance") {
        const body = await readJsonBody(req);
        const rawText =
          typeof body.utterance === "string"
            ? body.utterance
            : typeof body.text === "string"
              ? body.text
              : "";
        const utterance = rawText.trim();
        if (!utterance) {
          sendJson(res, 400, { ok: false, error: "missing utterance" });
          return;
        }
        const store = new EventStore(cfg.dbPath);
        try {
          const result = await runFunctionalSpine({
            store,
            dbPath: cfg.dbPath,
            workspacePath,
            utteranceText: utterance,
          });
          sendJson(res, 200, {
            ok: true,
            triggered: result.triggered,
            triggerKind: result.triggerKind,
            slot: result.slot,
            card: result.card,
            visibleCards: result.visibleCards,
          });
        } finally {
          store.close();
        }
        return;
      }

      const modeMatch = /^\/api\/skypanel\/(?:cards\/)?([^/]+)\/mode$/.exec(pathname);
      if (req.method === "POST" && modeMatch) {
        const cardId = decodeURIComponent(modeMatch[1]!);
        const body = await readJsonBody(req);
        const mode: SkypanelExecutionMode = body.mode === "agent" ? "agent" : "app";
        const store = new EventStore(cfg.dbPath);
        try {
          const card = store.getSkypanelCard(cardId);
          if (!card) {
            sendJson(res, 404, { ok: false, error: `Card not found: ${cardId}` });
            return;
          }
          card.selectedMode = mode;
          card.updatedAtMs = Date.now();
          store.upsertSkypanelCard(card);
          sendJson(res, 200, {
            ok: true,
            card,
            visibleCards: store.listSkypanelCards({ limit: 3 }),
          });
        } finally {
          store.close();
        }
        return;
      }

      const reviseMatch = /^\/api\/skypanel\/(?:cards\/)?([^/]+)\/revise$/.exec(pathname);
      if (req.method === "POST" && reviseMatch) {
        const cardId = decodeURIComponent(reviseMatch[1]!);
        const body = await readJsonBody(req);
        const rawInstruction =
          typeof body.instruction === "string"
            ? body.instruction
            : typeof body.feedback === "string"
              ? body.feedback
              : "";
        const instruction = rawInstruction.trim();
        if (!instruction) {
          sendJson(res, 400, { ok: false, error: "missing revision instruction" });
          return;
        }
        const store = new EventStore(cfg.dbPath);
        try {
          const updatedCard = await reviseCardOnSpine({
            store,
            cardId,
            instruction,
            workspacePath,
          });
          sendJson(res, 200, {
            ok: true,
            card: updatedCard,
            visibleCards: store.listSkypanelCards({ limit: 3 }),
          });
        } finally {
          store.close();
        }
        return;
      }

      const executeMatch = /^\/api\/skypanel\/(?:cards\/)?([^/]+)\/execute$/.exec(pathname);
      if (req.method === "POST" && executeMatch) {
        const cardId = decodeURIComponent(executeMatch[1]!);
        const body = await readJsonBody(req);
        const modeOverride =
          body.mode === "agent" || body.mode === "app"
            ? (body.mode as SkypanelExecutionMode)
            : undefined;
        const store = new EventStore(cfg.dbPath);
        try {
          const resExec = await executeCardOnSpine({
            store,
            dbPath: cfg.dbPath,
            cardId,
            modeOverride,
            workspacePath,
          });
          sendJson(res, 200, {
            ok: true,
            card: resExec.card,
            writtenPaths: resExec.writtenPaths,
            visibleCards: store.listSkypanelCards({ limit: 3 }),
          });
        } finally {
          store.close();
        }
        return;
      }

      const dismissMatch = /^\/api\/skypanel\/(?:cards\/)?([^/]+)\/dismiss$/.exec(pathname);
      if (req.method === "POST" && dismissMatch) {
        const cardId = decodeURIComponent(dismissMatch[1]!);
        const store = new EventStore(cfg.dbPath);
        try {
          const existing = store.getSkypanelCard(cardId);
          store.dismissSkypanelCard(cardId);
          if (existing) {
            store.resolveSpokenSlot(existing.slotId);
          }
          sendJson(res, 200, {
            ok: true,
            visibleCards: store.listSkypanelCards({ limit: 3 }),
          });
        } finally {
          store.close();
        }
        return;
      }

      if (req.method === "POST" && (pathname === "/api/capture/chrome" || pathname === "/api/shadow/browser")) {
        const body = await readJsonBody(req);
        const batch = Array.isArray(body.events) ? body.events : [body];
        const appended = appendChromeCaptureEvents(cfg, batch);
        sendJson(res, 200, { ok: true, appended });
        return;
      }

      if (req.method === "POST" && pathname === "/api/capture/android") {
        const body = await readJsonBody(req);
        const batch = Array.isArray(body.events) ? body.events : [body];
        const androidLogPath = join(dirname(cfg.zshHook), "android.jsonl");
        assertOutsideRepo(androidLogPath, "android capture log");
        mkdirSync(dirname(androidLogPath), { recursive: true, mode: 0o700 });
        const lines: string[] = [];
        for (const raw of batch) {
          if (!raw || typeof raw !== "object") continue;
          const ev = raw as Record<string, unknown>;
          lines.push(
            JSON.stringify({
              sender: typeof ev.sender === "string" ? ev.sender : "unknown",
              ...(typeof ev.phone === "string" ? { phone: ev.phone } : {}),
              text: typeof ev.text === "string" ? ev.text : "",
              ...(typeof ev.app === "string" ? { app: ev.app } : {}),
              timestampMs: typeof ev.timestampMs === "number" ? ev.timestampMs : Date.now(),
            }),
          );
        }
        if (lines.length > 0) {
          appendFileSync(androidLogPath, `${lines.join("\n")}\n`, { mode: 0o600 });
          chmodSync(androidLogPath, 0o600);
          const parsed = parseAndroidCapture(lines.join("\n"), androidLogPath);
          const store = new EventStore(cfg.dbPath);
          try {
            store.insert(withSeeks(parsed.events));
          } finally {
            store.close();
          }
        }
        sendJson(res, 200, { ok: true, appended: lines.length, ingested: lines.length });
        return;
      }

      if (req.method === "POST" && pathname === "/api/reingest") {
        ingest(cfg);
        sendJson(res, 200, { ok: true });
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
      });
    });
  });
}
