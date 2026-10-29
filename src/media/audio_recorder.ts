import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { findExecutable } from "./native_helper.js";
import { transcribeAudio } from "./stt.js";
import { parseWavHeader } from "./tts.js";

export interface AvDevice {
  index: number;
  name: string;
}

export interface AvDeviceList {
  videoDevices: AvDevice[];
  audioDevices: AvDevice[];
}

export interface RecordAudioOptions {
  durationSec: number;
  outputPath?: string;
  audioDeviceIndex?: number;
  transcribe?: boolean;
  modelPath?: string;
  captureJsonlPath?: string;
  workspacePath?: string;
}

export interface RecordAudioResult {
  outputPath: string;
  bytes: number;
  durationSec: number;
  sampleRate: number;
  audioDeviceIndex: number;
  transcript?: string;
}

export function parseAvFoundationDeviceList(output: string): AvDeviceList {
  const videoDevices: AvDevice[] = [];
  const audioDevices: AvDevice[] = [];
  let section: "none" | "video" | "audio" = "none";

  for (const line of output.split("\n")) {
    if (line.includes("AVFoundation video devices:")) {
      section = "video";
      continue;
    }
    if (line.includes("AVFoundation audio devices:")) {
      section = "audio";
      continue;
    }
    const m = /\[AVFoundation indev @ [^\]]+\]\s+\[(\d+)\]\s+(.+)$/.exec(line.trim());
    if (m) {
      const dev: AvDevice = { index: Number(m[1]), name: m[2]!.trim() };
      if (section === "video") videoDevices.push(dev);
      else if (section === "audio") audioDevices.push(dev);
    }
  }

  return { videoDevices, audioDevices };
}

export function listAudioDevices(): AvDeviceList {
  const ffmpeg = findExecutable("ffmpeg", ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]);
  const res = spawnSync(ffmpeg, ["-f", "avfoundation", "-list_devices", "true", "-i", ""], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  return parseAvFoundationDeviceList(combined);
}

export function recordAudioClip(options: RecordAudioOptions): RecordAudioResult {
  if (!Number.isFinite(options.durationSec) || options.durationSec <= 0 || options.durationSec > 600) {
    throw new Error(`Invalid durationSec: ${options.durationSec} (must be between 0 and 600 seconds)`);
  }
  const ffmpeg = findExecutable("ffmpeg", ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]);
  const audioIdx = options.audioDeviceIndex ?? 0;
  const outPath =
    options.outputPath ??
    join(homedir(), ".gadget", "capture", "audio", `clip-${Date.now()}.wav`);

  mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });

  execFileSync(
    ffmpeg,
    [
      "-y",
      "-f",
      "avfoundation",
      "-i",
      `:${audioIdx}`,
      "-t",
      String(options.durationSec),
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      outPath,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: Math.ceil(options.durationSec * 1000) + 15_000,
    },
  );

  if (!existsSync(outPath)) {
    throw new Error(`Audio recording failed to produce ${outPath}`);
  }
  chmodSync(outPath, 0o600);
  const st = statSync(outPath);
  const wav = parseWavHeader(outPath);

  let transcript: string | undefined;
  if (options.transcribe) {
    const sttRes = transcribeAudio({
      audioPath: outPath,
      modelPath: options.modelPath,
      captureJsonlPath: options.captureJsonlPath,
      workspacePath: options.workspacePath,
    });
    transcript = sttRes.transcript;
  } else if (options.captureJsonlPath) {
    mkdirSync(dirname(options.captureJsonlPath), { recursive: true, mode: 0o700 });
    const record = {
      ts: Date.now(),
      kind: "audio_clip",
      audioPath: outPath,
      durationSec: wav.durationSec,
      sampleRate: wav.sampleRate,
      audioDeviceIndex: audioIdx,
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
    outputPath: outPath,
    bytes: st.size,
    durationSec: wav.durationSec,
    sampleRate: wav.sampleRate,
    audioDeviceIndex: audioIdx,
    ...(transcript !== undefined ? { transcript } : {}),
  };
}
