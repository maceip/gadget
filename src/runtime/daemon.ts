import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { recordAudioClip } from "../media/audio_recorder.js";
import { captureClipboardOnce } from "../media/clipboard.js";
import { captureFocusedTextOnce, watchKeysBurst } from "../media/keyboard.js";
import { captureScreenAndOcr } from "../media/screen.js";
import { keyTokens } from "../miner/ceiling.js";
import type { MinerConfig } from "../miner/config.js";
import { buildEpisodes } from "../miner/episodes.js";
import { parseChromeCapture } from "../miner/parsers/chrome.js";
import { parseClipboardCapture } from "../miner/parsers/clipboard.js";
import { parseAudioCapture, parseKeyboardCapture, parseScreenCapture } from "../miner/parsers/sensory.js";
import { parseZshHook } from "../miner/parsers/zsh_hook.js";
import { withSeeks } from "../miner/seek.js";
import { EventStore, type StoredEvent } from "../miner/store.js";
import type { EpisodicEvent, Seek, SeekingEpisode } from "../miner/types.js";
import { readLabelsCsv } from "../web/server.js";
import {
  extractSpokenSlotFromEvent,
  type SpokenSlotRecord,
} from "../triggers/cosmo_spoken_slots.js";
import { OpenChronicleEventDispatcher } from "../triggers/desktop_activity_commitments.js";
import { computeAdaptiveCadenceMs } from "../triggers/governed_loop_cadence.js";
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
  recommendedIntervalMs: number;
  lastScreenApp: string | null;
  lastScreenTitle: string | null;
  lastScreenLines: number;
  lastClipboardChangeCount: number | null;
  lastFocusedRole: string | null;
  inputMonitoringAccess: boolean | null;
  lastKeyCount: number;
  lastAudioTranscript: string | null;
  activeSpokenSlotsCount?: number;
  lastSpokenSlot?: {
    slotId: string;
    triggerPrefix: string;
    socialMode: string;
    primarySlot: string;
    bodyText: string;
  } | null;
  countsBySource: Record<string, number>;
  errors: string[];
}

export class AmbientCatalogDaemon {
  private lastClipboardChangeCount: number | undefined;
  private lastFocusedText: string | undefined;
  private lastScreenText: string | undefined;
  private readonly screenDispatcher = new OpenChronicleEventDispatcher({
    debounceMs: 0,
    dedupIntervalMs: 1000,
    minCaptureGapMs: 2000,
    sameWindowDedupMs: 5000,
  });
  private readonly parsedLineCounts = new Map<string, number>();
  private cachedEpisodes: SeekingEpisode[] | null = null;
  private lastEpisodesBuiltAtMs = 0;
  private ticks = 0;
  private insertedEventsTotal = 0;
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly cfg: MinerConfig,
    private readonly opts: DaemonOptions = {},
  ) {}

  private readIncrementalTail(filePath: string, keepOverlapLines = 0): string | null {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n");
    const nonTrailingCount = lines.at(-1) === "" ? lines.length - 1 : lines.length;
    const prevCount = this.parsedLineCounts.get(filePath) ?? 0;
    if (prevCount > 0 && nonTrailingCount <= prevCount) {
      return null;
    }
    const startIdx = Math.max(0, prevCount - keepOverlapLines);
    this.parsedLineCounts.set(filePath, nonTrailingCount);
    if (startIdx === 0) return raw;
    return "\n".repeat(startIdx) + lines.slice(startIdx).join("\n");
  }

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
          this.screenDispatcher.ingestNotification({
            kind: "AXFocusedWindowChanged",
            timestampMs: Date.now(),
            app: ocr.frontmostApp ?? "unknown",
            windowTitle: ocr.windowTitle ?? "",
            textContent: this.lastScreenText,
          });
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
    let activeSpokenSlotsCount = 0;
    let lastSpokenSlot: DaemonStatus["lastSpokenSlot"] = null;
    try {
      const batch: EpisodicEvent[] = [];
      const zshRaw = this.readIncrementalTail(this.cfg.zshHook, 0);
      if (zshRaw !== null) {
        batch.push(...parseZshHook(zshRaw, this.cfg.zshHook).events);
      }
      const chromeRaw = this.readIncrementalTail(chromePath, 0);
      if (chromeRaw !== null) {
        batch.push(...parseChromeCapture(chromeRaw, chromePath).events);
      }
      const clipRaw = this.readIncrementalTail(clipboardPath, 0);
      if (clipRaw !== null) {
        batch.push(...parseClipboardCapture(clipRaw, clipboardPath).events);
      }
      const screenRaw = this.readIncrementalTail(screenPath, 1);
      if (screenRaw !== null) {
        batch.push(...parseScreenCapture(screenRaw, screenPath).events);
      }
      const kbRaw = this.readIncrementalTail(keyboardPath, 1);
      if (kbRaw !== null) {
        batch.push(...parseKeyboardCapture(kbRaw, keyboardPath).events);
      }
      const audioRaw = this.readIncrementalTail(audioPath, 0);
      if (audioRaw !== null) {
        batch.push(...parseAudioCapture(audioRaw, audioPath).events);
      }

      if (batch.length > 0) {
        const added = store.insert(withSeeks(batch));
        this.insertedEventsTotal += added;

        // Extract any Cosmo spoken commitments / slots from newly captured audio, keyboard, or zsh events
        const recentSensoryRows = store.db
          .prepare(
            `SELECT event_id, source, timestamp_ms, workspace_path, content_text, source_uri, metadata_json
               FROM events
              WHERE source IN ('screen', 'clipboard')
              ORDER BY timestamp_ms DESC
              LIMIT 15`,
          )
          .all() as Array<Record<string, unknown>>;
        const contextPool: EpisodicEvent[] = [
          ...batch,
          ...recentSensoryRows.map((r) => ({
            eventId: r.event_id as string,
            source: r.source as EpisodicEvent["source"],
            timestampMs: Number(r.timestamp_ms),
            ...(typeof r.workspace_path === "string" ? { workspacePath: r.workspace_path } : {}),
            contentText: r.content_text as string,
            sourceUri: r.source_uri as string,
            metadataJson: r.metadata_json as string,
          })),
        ];

        for (const ev of batch) {
          const slot = extractSpokenSlotFromEvent(ev, contextPool);
          if (slot) {
            if (slot.primarySlot === "PROVIDE_RECALL" || slot.allSlots.includes("PROVIDE_RECALL")) {
              const toks = keyTokens(slot.bodyText, "ASK_AGENT").slice(0, 4);
              if (toks.length > 0) {
                try {
                  const ftsMatch = toks.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
                  const recallRows = store.searchBefore(ftsMatch, slot.timestampMs, 5);
                  slot.recallHits = recallRows.map((rh) => ({
                    eventId: rh.eventId,
                    source: rh.source,
                    timestampMs: rh.timestampMs,
                    sourceUri: rh.sourceUri,
                    quote: rh.snippet,
                  }));
                } catch {
                  // ignore FTS syntax edge cases
                }
              }
            }
            store.upsertSpokenSlot(slot);
          }
        }
      }

      const activeSlots = store.listSpokenSlots({ status: "ACTIVE", limit: 25 });
      activeSpokenSlotsCount = activeSlots.length;
      if (activeSlots[0]) {
        lastSpokenSlot = {
          slotId: activeSlots[0].slotId,
          triggerPrefix: activeSlots[0].triggerPrefix,
          socialMode: activeSlots[0].socialMode,
          primarySlot: activeSlots[0].primarySlot,
          bodyText: activeSlots[0].bodyText,
        };
      }

      const rows = store.db
        .prepare("SELECT source, COUNT(*) AS n FROM events GROUP BY source ORDER BY n DESC")
        .all() as Array<{ source: string; n: number }>;
      for (const r of rows) countsBySource[r.source] = Number(r.n);
    } finally {
      store.close();
    }

    const recommendedIntervalMs = computeAdaptiveCadenceMs(
      this.opts.intervalMs ?? 5000,
      { minMs: 2000, maxMs: 30_000 },
      {
        stateChanged: lastKeyCount > 0 || lastScreenLines > 0,
        urgent: lastKeyCount >= 10,
        replied: false,
      },
    );

    const status: DaemonStatus = {
      pid: process.pid,
      startedAt: this.startedAt,
      lastTickAt: new Date().toISOString(),
      ticks: this.ticks,
      insertedEventsTotal: this.insertedEventsTotal,
      recommendedIntervalMs,
      lastScreenApp,
      lastScreenTitle,
      lastScreenLines,
      lastClipboardChangeCount: this.lastClipboardChangeCount ?? null,
      lastFocusedRole,
      inputMonitoringAccess,
      lastKeyCount,
      lastAudioTranscript,
      activeSpokenSlotsCount,
      lastSpokenSlot,
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
      const nowMs = Date.now();
      if (this.cachedEpisodes === null || nowMs - this.lastEpisodesBuiltAtMs > 5 * 60 * 1000) {
        const recentNonGitEvents = store.db
          .prepare(
            `SELECT event_id, source, timestamp_ms, workspace_path, content_text, source_uri, metadata_json, seeks_json
               FROM events
              WHERE source != 'git' AND source != 'screen'
              ORDER BY timestamp_ms DESC
              LIMIT 12000`,
          )
          .all() as Array<{
          event_id: string;
          source: EpisodicEvent["source"];
          timestamp_ms: number;
          workspace_path: string | null;
          content_text: string;
          source_uri: string;
          metadata_json: string;
          seeks_json: string;
        }>;
        const sortedSub: StoredEvent[] = recentNonGitEvents
          .reverse()
          .map((r) => ({
            eventId: r.event_id,
            source: r.source,
            timestampMs: Number(r.timestamp_ms),
            workspacePath: r.workspace_path ?? null,
            contentText: r.content_text,
            sourceUri: r.source_uri,
            metadataJson: r.metadata_json,
            seeks: JSON.parse(r.seeks_json) as Seek[],
          }));
        this.cachedEpisodes = buildEpisodes(sortedSub, this.cfg);
        this.lastEpisodesBuiltAtMs = nowMs;
      }

      const recentRows = store.db
        .prepare(
          `SELECT event_id FROM (
             SELECT event_id, timestamp_ms FROM events
              WHERE source NOT IN ('screen', 'audio')
              ORDER BY timestamp_ms DESC LIMIT 6
           )
           UNION ALL
           SELECT event_id FROM (
             SELECT event_id, timestamp_ms FROM events
              WHERE source IN ('screen', 'audio')
              ORDER BY timestamp_ms DESC LIMIT 4
           )`,
        )
        .all() as Array<{ event_id: string }>;
      const recentIds = [...new Set(recentRows.map((r) => r.event_id))];
      if (recentIds.length === 0) return 0;

      const episodeLabels = loadLatestLabelsMap(this.cfg.reportsDir);
      const anticipator = new CalibratedAnticipator(store, {
        priorEpisodes: this.cachedEpisodes,
        episodeLabels,
      });
      const ctx = {
        endMs: nowMs,
        eventIds: recentIds,
        workspacePath,
      };
      const proposals = anticipator.propose(ctx);
      const sensoryQueries = this.extractLiveSensoryQueries(store, nowMs);
      const activeSlots: SpokenSlotRecord[] = store.listSpokenSlots({ status: "ACTIVE", limit: 10 });
      const slotQueries: string[] = [];
      for (const s of activeSlots) {
        const toks = keyTokens(s.bodyText, "ASK_AGENT").filter((t) => t.length >= 4);
        if (toks.length >= 2) slotQueries.push(toks.slice(0, 2).join(" "));
      }
      const queryList = [...new Set([...proposals.map((p) => p.query), ...sensoryQueries, ...slotQueries])].slice(0, 8);
      if (queryList.length === 0 && activeSlots.length === 0) return 0;

      const searcher = new FtsEventsSearcher(store, workspacePath);
      const surfacer = new VerifiedSurfacer(store);
      const allHits = [];
      for (const q of queryList) {
        const hits = await searcher.search(q, nowMs);
        for (const h of hits) {
          if (!h.sourceUri.includes("/capture/screen.jsonl:")) {
            allHits.push(h);
          }
        }
      }
      const decision = surfacer.decide(ctx, allHits);
      const { accepted } = decision.action === "SURFACE" ? surfacer.filterSurfacableHits(ctx, allHits) : { accepted: [] };
      if (accepted.length === 0 && activeSlots.length === 0) return 0;

      const sink = new BriefWorkspaceSink(store);
      const reason =
        accepted.length > 0
          ? decision.reason
          : `Surfacing ${activeSlots.length} active spoken commitment/slot(s)`;
      await sink.write(workspacePath, accepted, reason, activeSlots);
      return accepted.length + activeSlots.length;
    } finally {
      store.close();
    }
  }

  private extractLiveSensoryQueries(store: EventStore, nowMs: number): string[] {
    const cutoffMs = nowMs - 2 * 60 * 1000;
    const rows = store.db
      .prepare(
        `SELECT source, content_text, metadata_json
           FROM events
          WHERE timestamp_ms >= ?
            AND timestamp_ms <= ?
            AND source IN ('keyboard', 'audio', 'clipboard', 'screen')
          ORDER BY timestamp_ms DESC
          LIMIT 6`,
      )
      .all(cutoffMs, nowMs) as Array<{ source: string; content_text: string; metadata_json: string }>;

    const queries: string[] = [];
    for (const r of rows) {
      if (r.source === "keyboard" || r.source === "audio" || r.source === "clipboard") {
        const toks = keyTokens(r.content_text, "ASK_AGENT").filter((t) => t.length >= 4);
        if (toks.length >= 2) queries.push(toks.slice(0, 2).join(" "));
        if (toks[0]) queries.push(toks[0]);
      } else if (r.source === "screen") {
        try {
          const meta = JSON.parse(r.metadata_json) as { windowTitle?: string };
          if (meta.windowTitle) {
            const titleToks = keyTokens(meta.windowTitle, "ASK_AGENT").filter((t) => t.length >= 4);
            if (titleToks.length >= 2) queries.push(titleToks.slice(0, 2).join(" "));
          }
        } catch {
          // ignore
        }
      }
    }
    return queries;
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
