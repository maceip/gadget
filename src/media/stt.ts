import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findExecutable } from "./native_helper.js";
import { parseWavHeader } from "./tts.js";

export interface TranscribeOptions {
  audioPath: string;
  modelPath?: string;
  language?: string;
  captureJsonlPath?: string;
  workspacePath?: string;
}

export interface TranscribeResult {
  audioPath: string;
  transcript: string;
  modelPath: string;
  durationSec: number;
  processingMs: number;
}

export function findWhisperModel(customPath?: string): string {
  const home = homedir();
  const candidates = [
    customPath,
    process.env.GADGET_WHISPER_MODEL,
    join(home, "Documents/ggml-base.en.bin"),
    join(home, ".gadget/models/ggml-base.en.bin"),
    join(home, ".gadget/models/ggml-tiny.en.bin"),
    "/opt/homebrew/share/whisper-cpp/models/ggml-base.en.bin",
    "/opt/homebrew/share/whisper-cpp/models/ggml-tiny.en.bin",
  ].filter((c): c is string => Boolean(c));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `Whisper ggml model not found. Checked: ${candidates.join(", ")}. Set GADGET_WHISPER_MODEL or place ggml-base.en.bin in ~/Documents/.`,
  );
}

function ensure16kMonoWav(inputPath: string): { wavPath: string; tempCreated: boolean; durationSec: number } {
  try {
    const info = parseWavHeader(inputPath);
    if (info.sampleRate === 16000 && info.channels === 1) {
      return { wavPath: inputPath, tempCreated: false, durationSec: info.durationSec };
    }
  } catch {
    // Not a 16kHz mono WAV; convert with ffmpeg below.
  }

  const ffmpeg = findExecutable("ffmpeg", ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]);
  const tmpWav = join(tmpdir(), `gadget-stt-${process.pid}-${Date.now()}.wav`);
  execFileSync(
    ffmpeg,
    ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", tmpWav],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
  );
  const info = parseWavHeader(tmpWav);
  return { wavPath: tmpWav, tempCreated: true, durationSec: info.durationSec };
}

export function transcribeAudio(options: TranscribeOptions): TranscribeResult {
  if (!existsSync(options.audioPath)) {
    throw new Error(`Audio file does not exist: ${options.audioPath}`);
  }
  const whisperCli = findExecutable("whisper-cli", [
    "/opt/homebrew/bin/whisper-cli",
    "/usr/local/bin/whisper-cli",
  ]);
  const modelPath = findWhisperModel(options.modelPath);
  const lang = options.language ?? "en";

  const startMs = Date.now();
  const { wavPath, tempCreated, durationSec } = ensure16kMonoWav(options.audioPath);
  try {
    const out = execFileSync(
      whisperCli,
      ["-m", modelPath, "-f", wavPath, "-l", lang, "--no-timestamps", "-nt"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      },
    );
    const processingMs = Date.now() - startMs;
    const transcript = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("whisper_") && !l.startsWith("ggml_") && !l.startsWith("system_info:") && !l.startsWith("main:"))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (options.captureJsonlPath && transcript.length > 0) {
      mkdirSync(dirname(options.captureJsonlPath), { recursive: true, mode: 0o700 });
      const record = {
        ts: Date.now(),
        kind: "audio_stt",
        audioPath: options.audioPath,
        transcript,
        durationSec,
        processingMs,
        modelPath,
        cwd: options.workspacePath ?? process.cwd(),
      };
      appendFileSync(options.captureJsonlPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      try {
        chmodSync(options.captureJsonlPath, 0o600);
      } catch {
        // ignore chmod error
      }
    }

    return {
      audioPath: options.audioPath,
      transcript,
      modelPath,
      durationSec,
      processingMs,
    };
  } finally {
    if (tempCreated) {
      rmSync(wavPath, { force: true });
    }
  }
}
