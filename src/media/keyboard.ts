import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runSensoryViaLaunchServices } from "./native_helper.js";

export interface FocusedTextSnapshot {
  trusted: boolean;
  skippedSecure: boolean;
  role: string | null;
  text: string | null;
  frontmostApp: string | null;
  windowTitle: string | null;
}

export interface KeyWatchResult {
  listenAccess: boolean;
  skippedSecure: boolean;
  keyCount: number;
  text: string;
  frontmostApp: string | null;
  windowTitle: string | null;
}

export function readFocusedTextSafe(binDir?: string): FocusedTextSnapshot {
  const raw = runSensoryViaLaunchServices<{
    trusted: boolean;
    skippedSecure: boolean;
    role?: string | null;
    text?: string | null;
    frontmostApp?: string | null;
    windowTitle?: string | null;
  }>(["focused-text"], binDir);

  return {
    trusted: raw.trusted,
    skippedSecure: raw.skippedSecure,
    role: raw.role ?? null,
    text: raw.text ?? null,
    frontmostApp: raw.frontmostApp ?? null,
    windowTitle: raw.windowTitle ?? null,
  };
}

export function captureFocusedTextOnce(options: {
  captureJsonlPath: string;
  workspacePath?: string;
  lastText?: string;
  binDir?: string;
}): { captured: boolean; snapshot: FocusedTextSnapshot } {
  const snap = readFocusedTextSafe(options.binDir);
  if (snap.skippedSecure || !snap.text || !snap.text.trim()) {
    return { captured: false, snapshot: snap };
  }
  const trimmed = snap.text.trim();
  if (options.lastText !== undefined && trimmed === options.lastText) {
    return { captured: false, snapshot: snap };
  }
  mkdirSync(dirname(options.captureJsonlPath), { recursive: true, mode: 0o700 });
  const record = {
    ts: Date.now(),
    kind: "focused_text",
    role: snap.role,
    text: trimmed,
    frontmostApp: snap.frontmostApp,
    windowTitle: snap.windowTitle,
    cwd: options.workspacePath ?? process.cwd(),
  };
  appendFileSync(options.captureJsonlPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  try {
    chmodSync(options.captureJsonlPath, 0o600);
  } catch {
    // ignore
  }
  return { captured: true, snapshot: snap };
}

export function watchKeysBurst(options: {
  durationSec?: number;
  captureJsonlPath?: string;
  workspacePath?: string;
  binDir?: string;
} = {}): KeyWatchResult {
  const sec = options.durationSec ?? 1.0;
  const raw = runSensoryViaLaunchServices<{
    listenAccess: boolean;
    skippedSecure: boolean;
    keyCount: number;
    text: string;
    frontmostApp?: string | null;
    windowTitle?: string | null;
  }>(["watch-keys", String(sec)], options.binDir);

  const res: KeyWatchResult = {
    listenAccess: raw.listenAccess,
    skippedSecure: raw.skippedSecure,
    keyCount: raw.keyCount,
    text: raw.text,
    frontmostApp: raw.frontmostApp ?? null,
    windowTitle: raw.windowTitle ?? null,
  };

  if (options.captureJsonlPath && !res.skippedSecure && res.text.trim().length > 0) {
    mkdirSync(dirname(options.captureJsonlPath), { recursive: true, mode: 0o700 });
    const record = {
      ts: Date.now(),
      kind: "keystrokes",
      keyCount: res.keyCount,
      text: res.text.trim(),
      frontmostApp: res.frontmostApp,
      windowTitle: res.windowTitle,
      cwd: options.workspacePath ?? process.cwd(),
    };
    appendFileSync(options.captureJsonlPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    try {
      chmodSync(options.captureJsonlPath, 0o600);
    } catch {
      // ignore
    }
  }

  return res;
}
