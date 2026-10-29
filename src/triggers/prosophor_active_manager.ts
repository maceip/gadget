// Ported from Swair/prosophor:
// - main_src/prosophor_core/managers/active_trigger_manager.h
// - main_src/prosophor_core/managers/active_trigger_manager.cc
// - config/.prosophor/active/file_organizer/trigger.py
// - config/.prosophor/active/skill_creator/trigger.py
//
// Implements the plugin-based ActiveTriggerManager with 3 trigger modes (periodic, idle,
// idle_once), the 3-state IdleTaskState machine (Monitoring -> Pending -> Triggering),
// trigger_mode.cfg parsing, priority sorting, timeout protection, exit-code-0 trigger
// firing, and real filesystem probes (file_organizer and skill_creator).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

export type TriggerMode = "periodic" | "idle" | "idle_once";

export type IdleTaskState = "Monitoring" | "Pending" | "Triggering";

export interface ActivePluginConfig {
  name: string;
  pluginDir: string;
  entryPoint: string;
  mode: TriggerMode;
  intervalSeconds: number;
  idleSeconds: number;
  timeoutSeconds: number;
  priority: number; // Lower number = higher priority (1..100)
  enabled: boolean;
}

export interface ProbeResult {
  exitCode: number; // 0 = trigger fired, non-zero = silent
  stdout: string;
  stderr?: string;
}

export type ProbeRunner = (config: ActivePluginConfig) => ProbeResult;

export interface ActivePluginRuntimeState {
  config: ActivePluginConfig;
  lastCheckMs: number;
  idleState: IdleTaskState;
  hasTriggeredInCurrentIdle: boolean;
  triggerCount: number;
  lastOutput: string | null;
}

export interface TriggerFiredEvent {
  pluginName: string;
  mode: TriggerMode;
  priority: number;
  timestampMs: number;
  output: string;
  parsedPayload: Record<string, unknown> | null;
}

// Parses Swair/prosophor's key=value trigger_mode.cfg format.
export function parseTriggerModeCfg(
  cfgText: string,
  pluginName: string,
  pluginDir: string,
): ActivePluginConfig {
  const kv = new Map<string, string>();
  for (const rawLine of cfgText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const val = line.slice(eq + 1).trim();
    kv.set(key, val);
  }

  const rawMode = (kv.get("mode") ?? "periodic").toLowerCase();
  const mode: TriggerMode =
    rawMode === "idle" || rawMode === "idle_once" || rawMode === "periodic"
      ? rawMode
      : "periodic";

  const parsePositiveInt = (k: string, fallback: number): number => {
    const n = Number.parseInt(kv.get(k) ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  const enabledStr = (kv.get("enabled") ?? "true").toLowerCase();
  const enabled = enabledStr !== "false" && enabledStr !== "0" && enabledStr !== "no";

  return {
    name: pluginName,
    pluginDir,
    entryPoint: kv.get("entry_point") ?? "trigger.py",
    mode,
    intervalSeconds: parsePositiveInt("interval_seconds", 60),
    idleSeconds: parsePositiveInt("idle_seconds", 300),
    timeoutSeconds: parsePositiveInt("timeout_seconds", 10),
    priority: parsePositiveInt("priority", 50),
    enabled,
  };
}

// Default OS process runner that executes entryPoint inside pluginDir with timeoutSeconds
// and interprets exit code 0 as "trigger fired" and non-zero as "silent".
export function runExecutableProbe(config: ActivePluginConfig): ProbeResult {
  const fullEntry = join(config.pluginDir, config.entryPoint);
  if (!existsSync(fullEntry)) {
    return { exitCode: 127, stdout: "", stderr: `entry point not found: ${fullEntry}` };
  }
  const ext = extname(fullEntry).toLowerCase();
  const cmd =
    ext === ".py"
      ? "python3"
      : ext === ".js" || ext === ".mjs"
        ? process.execPath
        : ext === ".sh"
          ? "bash"
          : fullEntry;
  const args = cmd === fullEntry ? [] : [fullEntry];

  try {
    const stdout = execFileSync(cmd, args, {
      cwd: config.pluginDir,
      encoding: "utf8",
      timeout: config.timeoutSeconds * 1000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, stdout: stdout.trim() };
  } catch (err: unknown) {
    const e = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer; killed?: boolean };
    const exitCode = typeof e.status === "number" ? e.status : e.killed ? 124 : 1;
    const stdout = typeof e.stdout === "string" ? e.stdout : Buffer.isBuffer(e.stdout) ? e.stdout.toString("utf8") : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : "";
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  }
}

// Built-in port of Swair/prosophor/config/.prosophor/active/file_organizer/trigger.py:
// Checks if non-hidden files/directories in targetDir exceed itemThreshold (default 10).
export function fileOrganizerProbe(targetDir: string, itemThreshold = 10): ProbeResult {
  if (!existsSync(targetDir)) {
    return { exitCode: 1, stdout: "" };
  }
  const entries = readdirSync(targetDir, { withFileTypes: true }).filter((d) => !d.name.startsWith("."));
  const totalCount = entries.length;
  if (totalCount <= itemThreshold) {
    return { exitCode: 1, stdout: "" };
  }

  let fileCount = 0;
  let dirCount = 0;
  const byExtension: Record<string, number> = {};
  const sampleItems: string[] = [];

  for (const entry of entries) {
    if (sampleItems.length < 15) sampleItems.push(entry.name);
    if (entry.isDirectory()) {
      dirCount++;
    } else {
      fileCount++;
      const ext = extname(entry.name).toLowerCase() || "<no_ext>";
      byExtension[ext] = (byExtension[ext] ?? 0) + 1;
    }
  }

  const payload = {
    trigger: "file_organizer",
    targetDir,
    totalCount,
    itemThreshold,
    fileCount,
    dirCount,
    byExtension,
    sampleItems,
    message: `Target directory ${targetDir} has ${totalCount} items (${fileCount} files, ${dirCount} folders), exceeding threshold ${itemThreshold}.`,
  };
  return { exitCode: 0, stdout: JSON.stringify(payload) };
}

// Built-in port of Swair/prosophor/config/.prosophor/active/skill_creator/trigger.py:
// Checks consolidated history files in historyDir modified after the epoch seconds stored
// in lastCheckFile. Detects complex multi-step workflows (numbered steps, repeated commands,
// or multi-file/multi-app sequences) and updates lastCheckFile.
export function skillCreatorProbe(
  historyDir: string,
  lastCheckFile = join(historyDir, ".last_check"),
  nowMs = Date.now(),
): ProbeResult {
  if (!existsSync(historyDir)) {
    return { exitCode: 1, stdout: "" };
  }

  let lastCheckMs = 0;
  if (existsSync(lastCheckFile)) {
    const raw = Number.parseFloat(readFileSync(lastCheckFile, "utf8").trim());
    if (Number.isFinite(raw) && raw > 0) {
      // Support both seconds and milliseconds
      lastCheckMs = raw < 1e11 ? raw * 1000 : raw;
    }
  }

  const files = readdirSync(historyDir)
    .filter((f) => !f.startsWith(".") && (f.endsWith(".md") || f.endsWith(".jsonl") || f.endsWith(".txt") || f.endsWith(".log")))
    .map((f) => join(historyDir, f));

  const newComplexFiles: Array<{ file: string; mtimeMs: number; stepCount: number; summary: string }> = [];

  for (const fullPath of files) {
    const st = statSync(fullPath);
    if (st.mtimeMs <= lastCheckMs) continue;
    const text = readFileSync(fullPath, "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    // Count multi-step indicators: numbered steps (1., 2.), tool/command lines, or workflow arrows
    const stepLines = lines.filter(
      (l) => /^\s*(\d+[.)]|[-*]\s+\[[ x]\]|step\s+\d+|->|==>|\$ )/i.test(l) || l.includes("tool_command"),
    );
    if (stepLines.length >= 3 || lines.length >= 8) {
      newComplexFiles.push({
        file: fullPath,
        mtimeMs: st.mtimeMs,
        stepCount: Math.max(stepLines.length, lines.length),
        summary: lines.slice(0, 3).join(" | ").slice(0, 200),
      });
    }
  }

  // Always update .last_check when scanned
  writeFileSync(lastCheckFile, `${(nowMs / 1000).toFixed(3)}\n`, "utf8");

  if (newComplexFiles.length === 0) {
    return { exitCode: 1, stdout: "" };
  }

  const payload = {
    trigger: "skill_creator",
    newFilesCount: newComplexFiles.length,
    candidates: newComplexFiles,
    message: `Detected ${newComplexFiles.length} new complex history log(s) suitable for skill extraction.`,
  };
  return { exitCode: 0, stdout: JSON.stringify(payload) };
}

export class ActiveTriggerManager {
  private readonly plugins = new Map<string, ActivePluginRuntimeState>();
  private readonly customRunners = new Map<string, ProbeRunner>();
  private readonly firedEvents: TriggerFiredEvent[] = [];

  constructor(private readonly defaultRunner: ProbeRunner = runExecutableProbe) {}

  // Scans a directory of plugins (each subfolder containing trigger_mode.cfg).
  loadPluginsFromDirectory(activeRootDir: string, nowMs = Date.now()): number {
    if (!existsSync(activeRootDir)) return 0;
    let loaded = 0;
    const entries = readdirSync(activeRootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const pluginDir = join(activeRootDir, entry.name);
      const cfgPath = join(pluginDir, "trigger_mode.cfg");
      if (!existsSync(cfgPath)) continue;
      const cfg = parseTriggerModeCfg(readFileSync(cfgPath, "utf8"), entry.name, pluginDir);
      this.registerPlugin(cfg, undefined, nowMs);
      loaded++;
    }
    return loaded;
  }

  registerPlugin(config: ActivePluginConfig, customRunner?: ProbeRunner, nowMs = Date.now()): void {
    this.plugins.set(config.name, {
      config,
      lastCheckMs: nowMs,
      idleState: "Monitoring",
      hasTriggeredInCurrentIdle: false,
      triggerCount: 0,
      lastOutput: null,
    });
    if (customRunner) {
      this.customRunners.set(config.name, customRunner);
    }
  }

  getPluginState(name: string): ActivePluginRuntimeState | undefined {
    const st = this.plugins.get(name);
    return st ? { ...st, config: { ...st.config } } : undefined;
  }

  getAllFiredEvents(): ReadonlyArray<TriggerFiredEvent> {
    return this.firedEvents;
  }

  // Executes one scheduler tick across all enabled plugins in priority order (lowest number first),
  // faithfully implementing Prosophor's Periodic / Idle / IdleOnce state machine.
  checkAndRunTriggers(userIdleSeconds: number, nowMs = Date.now()): TriggerFiredEvent[] {
    const sorted = [...this.plugins.values()]
      .filter((p) => p.config.enabled)
      .sort((a, b) => a.config.priority - b.config.priority);

    const firedThisTick: TriggerFiredEvent[] = [];

    for (const plugin of sorted) {
      const { config } = plugin;
      const elapsedSec = (nowMs - plugin.lastCheckMs) / 1000;
      let shouldRun = false;

      if (config.mode === "periodic") {
        if (elapsedSec >= config.intervalSeconds) {
          shouldRun = true;
        }
      } else if (config.mode === "idle") {
        if (userIdleSeconds >= config.idleSeconds) {
          if (plugin.idleState === "Monitoring") {
            plugin.idleState = "Pending";
            shouldRun = true;
          } else if (plugin.idleState === "Triggering" && elapsedSec >= config.idleSeconds) {
            plugin.idleState = "Pending";
            shouldRun = true;
          }
        } else {
          plugin.idleState = "Monitoring";
          plugin.hasTriggeredInCurrentIdle = false;
        }
      } else if (config.mode === "idle_once") {
        if (userIdleSeconds >= config.idleSeconds) {
          if (plugin.idleState === "Monitoring" && !plugin.hasTriggeredInCurrentIdle) {
            plugin.idleState = "Pending";
            shouldRun = true;
          }
        } else {
          plugin.idleState = "Monitoring";
          plugin.hasTriggeredInCurrentIdle = false;
        }
      }

      if (!shouldRun) continue;

      plugin.lastCheckMs = nowMs;
      const runner = this.customRunners.get(config.name) ?? this.defaultRunner;
      const res = runner(config);

      if (config.mode === "idle" || config.mode === "idle_once") {
        plugin.idleState = "Triggering";
        if (config.mode === "idle_once") {
          plugin.hasTriggeredInCurrentIdle = true;
        }
      }

      if (res.exitCode === 0 && res.stdout.trim().length > 0) {
        plugin.triggerCount++;
        plugin.lastOutput = res.stdout.trim();
        let parsedPayload: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(plugin.lastOutput);
          if (typeof parsed === "object" && parsed !== null) {
            parsedPayload = parsed as Record<string, unknown>;
          }
        } catch {
          parsedPayload = null;
        }
        const ev: TriggerFiredEvent = {
          pluginName: config.name,
          mode: config.mode,
          priority: config.priority,
          timestampMs: nowMs,
          output: plugin.lastOutput,
          parsedPayload,
        };
        this.firedEvents.push(ev);
        firedThisTick.push(ev);
      }
    }

    return firedThisTick;
  }
}
