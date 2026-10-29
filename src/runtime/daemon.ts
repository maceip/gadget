import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { recordAudioClip } from "../media/audio_recorder.js";
import { captureClipboardOnce } from "../media/clipboard.js";
import { captureFocusedTextOnce, watchKeysBurst } from "../media/keyboard.js";
import { captureScreenAndOcr } from "../media/screen.js";
import type { MinerConfig } from "../miner/config.js";
import { buildEpisodes } from "../miner/episodes.js";
import { parseChromeCapture } from "../miner/parsers/chrome.js";
import { parseClipboardCapture } from "../miner/parsers/clipboard.js";
import { parseAudioCapture, parseKeyboardCapture, parseScreenCapture } from "../miner/parsers/sensory.js";
import { parseZshHook } from "../miner/parsers/zsh_hook.js";
import { withSeeks } from "../miner/seek.js";
import { EventStore } from "../miner/store.js";
import type { EpisodicEvent } from "../miner/types.js";
import { readLabelsCsv } from "../web/server.js";
import { CalibratedAnticipator, type EpisodeLabel } from "./anticipator.js";
import { FtsEventsSearcher } from "./searchers.js";
import { BriefWorkspaceSink } from "./sink.js";
import { VerifiedSurfacer } from "./surfacer.js";

export interface DaemonOptions {
  intervalMs?: number;
  enableScreen?: boolean;
  enableClipboard?: boolean;
  enableKeyboard?: boolean;
  enableAudio?: boolean;
  audioClipSec?: number;
  keyWatchSec?: number;
  workspacePath?: string;
  once?: boolean;
  binDir?: string;
}

export interface DaemonStatus {
  pid: number;
  startedAt: string;
  lastTickAt: string;
  ticks: number;
  insertedEventsTotal: number;
  lastScreenApp: string | null;
  lastScreenTitle: string | null;
  lastScreenLines: number;
  lastClipboardChangeCount: number | null;
  lastFocusedRole: string | null;
  inputMonitoringAccess: boolean | null;
  lastKeyCount: number;
  lastAudioTranscript: string | null;
  countsBySource: Record<string, number>;
  errors: string[];
}

export class AmbientCatalogDaemon {
  private lastClipboardChangeCount: number | undefined;
  private lastFocusedText: string | undefined;
  private lastScreenText: string | undefined;
  private ticks = 0;
  private insertedEventsTotal = 0;
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly cfg: MinerConfig,
    private readonly opts: DaemonOptions = {},
  ) {}

  runTick(): DaemonStatus {
    this.ticks++;
    const captureDir = dirname(this.cfg.zshHook);
    mkdirSync(captureDir, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(this.cfg.dbPath), { recursive: true, mode: 0o700 });

    const clipboardPath = join(captureDir, "clipboard.jsonl");
    const screenPath = join(captureDir, "screen.jsonl");
    const keyboardPath = join(captureDir, "keyboard.jsonl");
    const audioPath = join(captureDir, "audio.jsonl");
    const chromePath = join(captureDir, "chrome.jsonl");

    const errors: string[] = [];
    let lastScreenApp: string | null = null;
    let lastScreenTitle: string | null = null;
    let lastScreenLines = 0;
    let lastFocusedRole: string | null = null;
    let inputMonitoringAccess: boolean | null = null;
    let lastKeyCount = 0;
    let lastAudioTranscript: string | null = null;
    const workspacePath = this.opts.workspacePath ?? process.cwd();

    if (this.opts.enableClipboard !== false) {
      try {
        const clipRes = captureClipboardOnce({
          captureJsonlPath: clipboardPath,
          workspacePath,
          lastChangeCount: this.lastClipboardChangeCount,
          binDir: this.opts.binDir,
        });
        this.lastClipboardChangeCount = clipRes.snapshot.changeCount;
      } catch (err) {
        errors.push(`clipboard: ${String(err)}`);
      }
    }

    if (this.opts.enableKeyboard !== false) {
      try {
        const focusRes = captureFocusedTextOnce({
          captureJsonlPath: keyboardPath,
          workspacePath,
          lastText: this.lastFocusedText,
          binDir: this.opts.binDir,
        });
        lastFocusedRole = focusRes.snapshot.role;
        if (focusRes.snapshot.text?.trim()) {
          this.lastFocusedText = focusRes.snapshot.text.trim();
        }
        const keyWatchSec = this.opts.keyWatchSec ?? 1.5;
        if (keyWatchSec > 0) {
          const keyRes = watchKeysBurst({
            durationSec: keyWatchSec,
            captureJsonlPath: keyboardPath,
            workspacePath,
            binDir: this.opts.binDir,
          });
          inputMonitoringAccess = keyRes.listenAccess;
          lastKeyCount = keyRes.keyCount;
        }
      } catch (err) {
        errors.push(`keyboard: ${String(err)}`);
      }
    }

    if (this.opts.enableScreen !== false) {
      try {
        const ocr = captureScreenAndOcr({
          keepImage: false,
          captureJsonlPath: screenPath,
          workspacePath,
          lastText: this.lastScreenText,
          binDir: this.opts.binDir,
        });
        lastScreenApp = ocr.frontmostApp;
        lastScreenTitle = ocr.windowTitle;
        lastScreenLines = ocr.lineCount;
        if (ocr.text.trim().length > 0) {
          this.lastScreenText = ocr.text.trim();
        }
      } catch (err) {
        errors.push(`screen: ${String(err)}`);
      }
    }

    if (this.opts.enableAudio) {
      try {
        const rec = recordAudioClip({
          durationSec: this.opts.audioClipSec ?? 3,
          transcribe: true,
          captureJsonlPath: audioPath,
          workspacePath,
        });
        lastAudioTranscript = rec.transcript ?? null;
      } catch (err) {
        errors.push(`audio: ${String(err)}`);
      }
    }

    const store = new EventStore(this.cfg.dbPath);
    let countsBySource: Record<string, number> = {};
    try {
      const batch: EpisodicEvent[] = [];
      if (existsSync(this.cfg.zshHook)) {
        batch.push(...parseZshHook(readFileSync(this.cfg.zshHook, "utf8"), this.cfg.zshHook).events);
      }
      if (existsSync(chromePath)) {
        batch.push(...parseChromeCapture(readFileSync(chromePath, "utf8"), chromePath).events);
      }
      if (existsSync(clipboardPath)) {
        batch.push(...parseClipboardCapture(readFileSync(clipboardPath, "utf8"), clipboardPath).events);
      }
      if (existsSync(screenPath)) {
        batch.push(...parseScreenCapture(readFileSync(screenPath, "utf8"), screenPath).events);
      }
      if (existsSync(keyboardPath)) {
        batch.push(...parseKeyboardCapture(readFileSync(keyboardPath, "utf8"), keyboardPath).events);
      }
      if (existsSync(audioPath)) {
        batch.push(...parseAudioCapture(readFileSync(audioPath, "utf8"), audioPath).events);
      }

      if (batch.length > 0) {
        const added = store.insert(withSeeks(batch));
        this.insertedEventsTotal += added;
      }

      const rows = store.db
        .prepare("SELECT source, COUNT(*) AS n FROM events GROUP BY source ORDER BY n DESC")
        .all() as Array<{ source: string; n: number }>;
      for (const r of rows) countsBySource[r.source] = Number(r.n);
    } finally {
      store.close();
    }

    const status: DaemonStatus = {
      pid: process.pid,
      startedAt: this.startedAt,
      lastTickAt: new Date().toISOString(),
      ticks: this.ticks,
      insertedEventsTotal: this.insertedEventsTotal,
      lastScreenApp,
      lastScreenTitle,
      lastScreenLines,
      lastClipboardChangeCount: this.lastClipboardChangeCount ?? null,
      lastFocusedRole,
      inputMonitoringAccess,
      lastKeyCount,
      lastAudioTranscript,
      countsBySource,
      errors,
    };

    const statusPath = join(dirname(this.cfg.dbPath), "daemon-status.json");
    writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
    return status;
  }

  async runProactiveBriefUpdate(workspacePath = this.opts.workspacePath ?? process.cwd()): Promise<number> {
    if (!existsSync(this.cfg.dbPath)) return 0;
    const store = new EventStore(this.cfg.dbPath, { readOnly: true });
    try {
      const events = store.allEventsSorted();
      if (events.length === 0) return 0;
      const episodes = buildEpisodes(events, this.cfg);
      const episodeLabels = loadLatestLabelsMap(this.cfg.reportsDir);
      const anticipator = new CalibratedAnticipator(store, {
        priorEpisodes: episodes,
        episodeLabels,
      });
      const recentIds = events.slice(-8).map((e) => e.eventId);
      const nowMs = Date.now();
      const ctx = {
        endMs: nowMs,
        eventIds: recentIds,
        workspacePath,
      };
      const proposals = anticipator.propose(ctx);
      if (proposals.length === 0) return 0;

      const searcher = new FtsEventsSearcher(store, workspacePath);
      const surfacer = new VerifiedSurfacer(store);
      const allHits = [];
      for (const p of proposals) {
        allHits.push(...(await searcher.search(p.query, nowMs)));
      }
      const decision = surfacer.decide(ctx, allHits);
      if (decision.action !== "SURFACE") return 0;

      const { accepted } = surfacer.filterSurfacableHits(ctx, allHits);
      if (accepted.length === 0) return 0;

      const sink = new BriefWorkspaceSink(store);
      await sink.write(workspacePath, accepted, decision.reason);
      return accepted.length;
    } finally {
      store.close();
    }
  }
}

export function loadLatestLabelsMap(reportsDir: string): Map<string, EpisodeLabel> {
  const out = new Map<string, EpisodeLabel>();
  if (!existsSync(reportsDir)) return out;
  try {
    const dirs = readdirSync(reportsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
    for (const d of dirs) {
      const csvPath = join(reportsDir, d, "labels.csv");
      for (const [k, v] of loadLabelsMapFromFile(csvPath)) {
        out.set(k, v);
      }
    }
  } catch {
    // ignore
  }
  return out;
}

export function loadLabelsMapFromFile(labelsCsvPath: string): Map<string, EpisodeLabel> {
  const out = new Map<string, EpisodeLabel>();
  if (!existsSync(labelsCsvPath)) return out;
  for (const row of readLabelsCsv(labelsCsvPath)) {
    if (row.real_seeking === "Y" || row.real_seeking === "N") {
      out.set(row.episode_id, {
        realSeeking: row.real_seeking === "Y",
        ...(row.answer_in_my_data === "Y" || row.answer_in_my_data === "N"
          ? { answerInData: row.answer_in_my_data === "Y" }
          : {}),
      });
    }
  }
  return out;
}
