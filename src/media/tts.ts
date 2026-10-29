import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { findExecutable } from "./native_helper.js";

export interface VoiceInfo {
  name: string;
  locale: string;
  sampleText: string;
}

export interface SynthesizeSpeechOptions {
  text: string;
  outputPath: string;
  voice?: string;
  rateWpm?: number;
}

export interface SynthesizeSpeechResult {
  outputPath: string;
  bytes: number;
  durationSec: number;
  sampleRate: number;
  channels: number;
  voice?: string;
}

export function listVoices(): VoiceInfo[] {
  const sayBin = findExecutable("say", ["/usr/bin/say"]);
  const out = execFileSync(sayBin, ["-v", "?"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const voices: VoiceInfo[] = [];
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // Format: "Albert              en_US    # Hello! My name is Albert."
    const m = /^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,4})\s+#\s*(.*)$/.exec(line);
    if (m) {
      voices.push({
        name: m[1]!.trim(),
        locale: m[2]!.trim(),
        sampleText: m[3]!.trim(),
      });
    }
  }
  return voices;
}

export function parseWavHeader(filePath: string): { sampleRate: number; channels: number; durationSec: number } {
  const buf = readFileSync(filePath);
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Invalid WAV file at ${filePath}`);
  }
  let offset = 12;
  let channels = 1;
  let sampleRate = 16000;
  let byteRate = 32000;
  let dataBytes = 0;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === "fmt " && chunkSize >= 16 && chunkStart + 16 <= buf.length) {
      channels = buf.readUInt16LE(chunkStart + 2);
      sampleRate = buf.readUInt32LE(chunkStart + 4);
      byteRate = buf.readUInt32LE(chunkStart + 8);
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
      break;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  const durationSec = byteRate > 0 ? Number((dataBytes / byteRate).toFixed(3)) : 0;
  return { sampleRate, channels, durationSec };
}

export function synthesizeSpeech(options: SynthesizeSpeechOptions): SynthesizeSpeechResult {
  const text = options.text.trim();
  if (!text) {
    throw new Error("synthesizeSpeech requires non-empty text");
  }
  const sayBin = findExecutable("say", ["/usr/bin/say"]);
  mkdirSync(dirname(options.outputPath), { recursive: true });

  const args: string[] = ["-o", options.outputPath, "--data-format=LEI16@16000"];
  if (options.voice) {
    args.push("-v", options.voice);
  }
  if (options.rateWpm && Number.isFinite(options.rateWpm)) {
    args.push("-r", String(Math.round(options.rateWpm)));
  }
  args.push(text);

  execFileSync(sayBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });

  if (!existsSync(options.outputPath)) {
    throw new Error(`say did not produce output file: ${options.outputPath}`);
  }
  const st = statSync(options.outputPath);
  if (st.size <= 44) {
    throw new Error(`say produced empty WAV file (${st.size} bytes): ${options.outputPath}`);
  }
  const wav = parseWavHeader(options.outputPath);
  return {
    outputPath: options.outputPath,
    bytes: st.size,
    durationSec: wav.durationSec,
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    ...(options.voice ? { voice: options.voice } : {}),
  };
}

export function speakAloud(options: { text: string; voice?: string; rateWpm?: number }): void {
  const text = options.text.trim();
  if (!text) {
    throw new Error("speakAloud requires non-empty text");
  }
  const sayBin = findExecutable("say", ["/usr/bin/say"]);
  const args: string[] = [];
  if (options.voice) args.push("-v", options.voice);
  if (options.rateWpm && Number.isFinite(options.rateWpm)) args.push("-r", String(Math.round(options.rateWpm)));
  args.push(text);
  execFileSync(sayBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}
