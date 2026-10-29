import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listAudioDevices, parseAvFoundationDeviceList } from "../src/media/audio_recorder.js";
import { hasConcealedPasteboardType, readSafeClipboard } from "../src/media/clipboard.js";
import { ocrImage, renderTextImage } from "../src/media/screen.js";
import { findWhisperModel, transcribeAudio } from "../src/media/stt.js";
import { listVoices, synthesizeSpeech } from "../src/media/tts.js";
import { buildEpisodes } from "../src/miner/episodes.js";
import { parseClipboardCapture } from "../src/miner/parsers/clipboard.js";
import { withSeeks } from "../src/miner/seek.js";

test("TTS + Local Whisper STT round-trip: say synthesizes 16kHz WAV and whisper-cli transcribes it", (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS /usr/bin/say + whisper-cli test");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "gadget-media-tts-stt-"));
  try {
    const voices = listVoices();
    assert.ok(voices.length > 0, "Expected at least one macOS voice from /usr/bin/say");

    const wavPath = join(dir, "spoken.wav");
    const captureJsonl = join(dir, "audio.jsonl");
    const phrase = "Ambient recall system verified with local speech to text";
    const ttsRes = synthesizeSpeech({
      text: phrase,
      outputPath: wavPath,
    });

    assert.equal(ttsRes.sampleRate, 16000);
    assert.equal(ttsRes.channels, 1);
    assert.ok(ttsRes.bytes > 10_000);
    assert.ok(ttsRes.durationSec > 1.0);

    const modelPath = findWhisperModel();
    const sttRes = transcribeAudio({
      audioPath: wavPath,
      modelPath,
      captureJsonlPath: captureJsonl,
      workspacePath: "/Users/mac/gadget",
    });

    const lower = sttRes.transcript.toLowerCase();
    assert.match(lower, /ambient/);
    assert.match(lower, /recall/);
    assert.match(lower, /speech/);

    const logged = JSON.parse(readFileSync(captureJsonl, "utf8").trim()) as {
      kind: string;
      transcript: string;
    };
    assert.equal(logged.kind, "audio_stt");
    assert.match(logged.transcript.toLowerCase(), /ambient/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Screen Vision OCR: native Swift helper renders text PNG and extracts text via VNRecognizeTextRequest", (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS Vision.framework OCR test");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "gadget-media-ocr-"));
  try {
    const imgPath = join(dir, "error_banner.png");
    const targetText = "SQLITE_BUSY: database is locked in store.ts";
    renderTextImage(imgPath, targetText);

    const ocr = ocrImage(imgPath);
    assert.ok(ocr.lineCount >= 1);
    assert.match(ocr.text, /SQLITE_BUSY/i);
    assert.match(ocr.text, /store\.ts/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AVFoundation audio device parser and live device enumeration", () => {
  const sample = [
    "[AVFoundation indev @ 0x7b6680c140] AVFoundation video devices:",
    "[AVFoundation indev @ 0x7b6680c140] [0] MacBook Pro Camera",
    "[AVFoundation indev @ 0x7b6680c140] [1] Capture screen 0",
    "[AVFoundation indev @ 0x7b6680c140] AVFoundation audio devices:",
    "[AVFoundation indev @ 0x7b6680c140] [0] MacBook Pro Microphone",
  ].join("\n");

  const parsed = parseAvFoundationDeviceList(sample);
  assert.equal(parsed.videoDevices.length, 2);
  assert.equal(parsed.audioDevices.length, 1);
  assert.equal(parsed.audioDevices[0]?.name, "MacBook Pro Microphone");

  if (process.platform === "darwin") {
    const live = listAudioDevices();
    assert.ok(Array.isArray(live.audioDevices));
    assert.ok(Array.isArray(live.videoDevices));
  }
});

test("Safe clipboard capture skips concealed password-manager types and resolves PASTE_FROM_SOURCE", () => {
  assert.equal(hasConcealedPasteboardType(["public.utf8-plain-text"]).concealed, false);
  assert.equal(
    hasConcealedPasteboardType(["public.utf8-plain-text", "org.nspasteboard.ConcealedType"]).concealed,
    true,
  );
  assert.equal(
    hasConcealedPasteboardType(["com.agilebits.onepassword"]).concealed,
    true,
  );

  if (process.platform === "darwin") {
    const liveSnap = readSafeClipboard();
    assert.equal(typeof liveSnap.changeCount, "number");
    assert.equal(typeof liveSnap.skippedConcealed, "boolean");
  }

  const rawJsonl = [
    JSON.stringify({
      ts: 1_000,
      changeCount: 1,
      text: "super-secret-password",
      skippedConcealed: true,
      concealedTypes: ["org.nspasteboard.ConcealedType"],
    }),
    JSON.stringify({
      ts: 2_000,
      changeCount: 2,
      text: "--wasm-tier-up=false",
      frontmostApp: "Google Chrome",
      cwd: "/w",
    }),
  ].join("\n");

  const parsed = parseClipboardCapture(rawJsonl, "/tmp/clipboard.jsonl");
  assert.equal(parsed.counts.read, 2);
  assert.equal(parsed.counts.parsed, 1);
  assert.equal(parsed.counts.skipped.concealed_pasteboard, 1);
  assert.equal(parsed.events[0]?.contentText, "--wasm-tier-up=false");

  const stream = withSeeks([
    {
      eventId: "e1",
      source: "zsh_hook",
      timestampMs: 1_500,
      workspacePath: "/w",
      contentText: "rg wasm-tier-up",
      sourceUri: "/tmp/zsh.jsonl:1",
      metadataJson: JSON.stringify({ exit: 0, end_ms: 1_550 }),
    },
    parsed.events[0]!,
    {
      eventId: "e3",
      source: "zsh_hook",
      timestampMs: 2_500,
      workspacePath: "/w",
      contentText: "node --wasm-tier-up=false app.js",
      sourceUri: "/tmp/zsh.jsonl:2",
      metadataJson: JSON.stringify({ exit: 0, end_ms: 2_600 }),
    },
  ]).map(({ event, seeks }) => ({
    ...event,
    workspacePath: event.workspacePath ?? null,
    seeks,
  }));

  const episodes = buildEpisodes(stream, {
    seekGapMs: 300_000,
    contextWindowMs: 600_000,
    resolutionWindowMs: 600_000,
    maxContextEvents: 50,
  });
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0]?.resolution?.kind, "PASTE_FROM_SOURCE");
  assert.equal(episodes[0]?.resolution?.answerSpan, "--wasm-tier-up=false");
});
