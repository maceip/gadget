import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findExecutable, runSensoryCommand } from "./native_helper.js";

function jaccardTokenSimilarity(a: string, b: string): number {
  const tokA = new Set(
    (a.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((t) => t.length >= 2 && !/^\d+$/.test(t)),
  );
  const tokB = new Set(
    (b.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((t) => t.length >= 2 && !/^\d+$/.test(t)),
  );
  if (tokA.size === 0 && tokB.size === 0) return 1;
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let inter = 0;
  for (const t of tokA) {
    if (tokB.has(t)) inter++;
  }
  const union = tokA.size + tokB.size - inter;
  return union > 0 ? Number((inter / union).toFixed(4)) : 0;
}

export interface ScreenOcrResult {
  text: string;
  lineCount: number;
  lines: string[];
  frontmostApp: string | null;
  windowTitle: string | null;
  imagePath?: string;
}

export interface CaptureScreenOptions {
  outputPath?: string;
  keepImage?: boolean;
  captureJsonlPath?: string;
  workspacePath?: string;
  lastText?: string;
  binDir?: string;
}

export function areScreensNearIdentical(prevText: string | undefined, nextText: string): boolean {
  if (!prevText) return false;
  const a = prevText.trim();
  const b = nextText.trim();
  if (a === b) return true;
  const tokA = new Set(a.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []);
  const tokB = new Set(b.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []);
  if (tokA.size < 10 || tokB.size < 10) return false;
  return jaccardTokenSimilarity(a, b) >= 0.92;
}

export function ocrImage(imagePath: string, binDir?: string): ScreenOcrResult {
  if (!existsSync(imagePath)) {
    throw new Error(`Image file not found: ${imagePath}`);
  }
  const raw = runSensoryCommand<{
    text: string;
    lineCount: number;
    lines: string[];
    frontmostApp?: string | null;
    windowTitle?: string | null;
  }>(["ocr", imagePath], binDir);

  return {
    text: raw.text,
    lineCount: raw.lineCount,
    lines: raw.lines,
    frontmostApp: raw.frontmostApp ?? null,
    windowTitle: raw.windowTitle ?? null,
    imagePath,
  };
}

export function renderTextImage(outputPath: string, text: string, binDir?: string): string {
  mkdirSync(dirname(outputPath), { recursive: true });
  runSensoryCommand<{ ok: boolean; path: string }>(["render-text-image", outputPath, text], binDir);
  return outputPath;
}

export function captureScreenAndOcr(options: CaptureScreenOptions = {}): ScreenOcrResult {
  const screencapture = findExecutable("screencapture", ["/usr/sbin/screencapture"]);
  const keep = Boolean(options.keepImage || options.outputPath);
  const imgPath =
    options.outputPath ??
    join(
      keep ? join(homedir(), ".gadget", "capture", "screens") : tmpdir(),
      `screen-${process.pid}-${Date.now()}.png`,
    );

  mkdirSync(dirname(imgPath), { recursive: true, mode: 0o700 });
  execFileSync(screencapture, ["-x", imgPath], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });

  if (!existsSync(imgPath)) {
    throw new Error("screencapture did not write an image file (Screen Recording permission may be required)");
  }

  try {
    const ocr = ocrImage(imgPath, options.binDir);
    const trimmed = ocr.text.trim();
    if (options.captureJsonlPath && trimmed.length > 0 && !areScreensNearIdentical(options.lastText, trimmed)) {
      mkdirSync(dirname(options.captureJsonlPath), { recursive: true, mode: 0o700 });
      const record = {
        ts: Date.now(),
        kind: "screen_ocr",
        frontmostApp: ocr.frontmostApp,
        windowTitle: ocr.windowTitle,
        text: ocr.text,
        lineCount: ocr.lineCount,
        ...(keep ? { imagePath: imgPath } : {}),
        cwd: options.workspacePath ?? process.cwd(),
      };
      appendFileSync(options.captureJsonlPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      try {
        chmodSync(options.captureJsonlPath, 0o600);
      } catch {
        // ignore
      }
    }
    return {
      ...ocr,
      ...(keep ? { imagePath: imgPath } : { imagePath: undefined }),
    };
  } finally {
    if (!keep) {
      rmSync(imgPath, { force: true });
    }
  }
}
