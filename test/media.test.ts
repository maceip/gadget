import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listAudioDevices, parseAvFoundationDeviceList } from "../src/media/audio_recorder.js";
import { hasConcealedPasteboardType, readSafeClipboard } from "../src/media/clipboard.js";
import { readFocusedTextSafe, watchKeysBurst } from "../src/media/keyboard.js";
import {
  checkSensoryPermissions,
  ensureSensoryBinary,
  SENSORY_APP_NAME,
  SENSORY_BUNDLE_ID,
} from "../src/media/native_helper.js";
import { areScreensNearIdentical, ocrImage, renderTextImage } from "../src/media/screen.js";
import { findWhisperModel, isWhisperNonSpeech, transcribeAudio } from "../src/media/stt.js";
import { listVoices, synthesizeSpeech } from "../src/media/tts.js";
import { defaultConfig } from "../src/miner/config.js";
import { buildEpisodes } from "../src/miner/episodes.js";
import { parseClipboardCapture } from "../src/miner/parsers/clipboard.js";
import { parseAudioCapture, parseKeyboardCapture, parseScreenCapture } from "../src/miner/parsers/sensory.js";
import { withSeeks } from "../src/miner/seek.js";
import { EventStore } from "../src/miner/store.js";
import { CalibratedAnticipator } from "../src/runtime/anticipator.js";
import { AmbientCatalogDaemon } from "../src/runtime/daemon.js";

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

test("AmbientCatalogDaemon & sensory parsers: screen, audio, keyboard, and learned episode label log-odds", () => {
  const dir = mkdtempSync(join(tmpdir(), "gadget-daemon-test-"));
  try {
    if (process.platform === "darwin") {
      const binPath = ensureSensoryBinary();
      assert.ok(existsSync(binPath));
      assert.ok(binPath.includes(`${SENSORY_APP_NAME}.app/Contents/MacOS/GadgetSensoryCapture`));

      const perms = checkSensoryPermissions();
      assert.equal(perms.appName, SENSORY_APP_NAME);
      assert.equal(perms.bundleId, SENSORY_BUNDLE_ID);
      assert.equal(perms.kernelNetworkAndExecSandboxed, true);
      assert.equal(perms.readOnlyContained, true);

      // Verify Mach-O symbol table has zero mutation, input-synthesis, or network symbols
      const symbols = execFileSync("/usr/bin/nm", ["-u", binPath], { encoding: "utf8" });
      for (const forbidden of [
        "_AXUIElementPerformAction",
        "_AXUIElementSetAttributeValue",
        "_AXUIElementPostKeyboardEvent",
        "_CGEventPost",
        "_CGEventPostToPid",
        "_CGEventCreateKeyboardEvent",
        "_CGEventCreateMouseEvent",
        "_NSURLSession",
        "_connect",
      ]) {
        assert.equal(
          symbols.includes(forbidden),
          false,
          `Contained sensory binary must not import ${forbidden}`,
        );
      }

      const focus = readFocusedTextSafe();
      assert.equal(typeof focus.trusted, "boolean");
      assert.equal(typeof focus.skippedSecure, "boolean");
      const keys = watchKeysBurst({ durationSec: 0.05 });
      assert.equal(typeof keys.listenAccess, "boolean");
    }

    assert.equal(isWhisperNonSpeech("[BLANK_AUDIO]"), true);
    assert.equal(isWhisperNonSpeech("(gentle music)"), true);
    assert.equal(isWhisperNonSpeech("(snoring)"), true);
    assert.equal(isWhisperNonSpeech("check the dynamic workflow runtime"), false);

    const baseScreen = "Antigravity File Edit View Window building Smart GitHub Crawling Service Conversation History Automations Customizations Projects Haymens swizzle";
    assert.equal(areScreensNearIdentical(baseScreen + " 08:48", baseScreen + " 08:49"), true);
    assert.equal(areScreensNearIdentical(baseScreen, "Ghostty terminal model.tools DNS cache issue"), false);

    const screenRaw = [
      JSON.stringify({ ts: 1000, frontmostApp: "Cursor", windowTitle: "store.ts", text: "Error: SQLITE_BUSY", lineCount: 1 }),
      JSON.stringify({ ts: 2000, frontmostApp: "Cursor", windowTitle: "store.ts", text: "Error: SQLITE_BUSY", lineCount: 1 }),
    ].join("\n");
    const sParsed = parseScreenCapture(screenRaw, "/tmp/screen.jsonl");
    assert.equal(sParsed.counts.parsed, 1);
    assert.equal(sParsed.counts.skipped.unchanged_screen, 1);

    const audioRaw = [
      JSON.stringify({ ts: 1500, transcript: "[BLANK_AUDIO]" }),
      JSON.stringify({ ts: 1800, transcript: "(gentle music)" }),
      JSON.stringify({ ts: 2100, transcript: "(snoring)" }),
      JSON.stringify({ ts: 2500, transcript: "check the dynamic workflow runtime harness in ZCode" }),
    ].join("\n");
    const aParsed = parseAudioCapture(audioRaw, "/tmp/audio.jsonl");
    assert.equal(aParsed.counts.parsed, 1);
    assert.equal(aParsed.counts.skipped.silence_or_empty, 3);

    const kbRaw = [
      JSON.stringify({ ts: 3000, skippedSecure: true, text: "hunter2" }),
      JSON.stringify({ ts: 3500, kind: "keystrokes", frontmostApp: "iTerm2", text: "rg --wasm-tier-up" }),
    ].join("\n");
    const kParsed = parseKeyboardCapture(kbRaw, "/tmp/keyboard.jsonl");
    assert.equal(kParsed.counts.parsed, 1);
    assert.equal(kParsed.counts.skipped.secure_field, 1);

    const cfg = defaultConfig(dir);
    const captureDir = join(dir, ".gadget", "capture");
    writeFileSync(join(dir, ".zshrc"), "");
    const daemon = new AmbientCatalogDaemon(cfg, {
      enableScreen: false,
      enableClipboard: false,
      enableKeyboard: false,
      enableAudio: false,
    });
    // Pre-populate capture files and run a tick
    daemon.runTick();
    writeFileSync(join(captureDir, "screen.jsonl"), screenRaw + "\n");
    writeFileSync(join(captureDir, "audio.jsonl"), audioRaw + "\n");
    writeFileSync(join(captureDir, "keyboard.jsonl"), kbRaw + "\n");
    const st = daemon.runTick();
    assert.equal(st.countsBySource.screen, 1);
    assert.equal(st.countsBySource.audio, 1);
    assert.equal(st.countsBySource.keyboard, 1);

    const store = new EventStore(cfg.dbPath, { readOnly: true });
    try {
      const hits = store.searchBefore('"dynamic" AND "workflow"', 999_999, 5);
      assert.equal(hits.length, 1);
      assert.equal(hits[0]?.source, "audio");

      // Verify learned log-odds from episodeLabels without hand-written trigger rules
      const all = store.allEventsSorted();
      const firstId = all.find((e) => e.source === "keyboard")!.eventId;
      const fakeEpPos = {
        episodeId: "ep-pos",
        contextEventIds: [firstId],
        seekStartMs: 5000,
        seekActions: [{ kind: "ASK_AGENT" as const, query: "sqlite_busy lock", eventId: firstId }],
      };
      const fakeEpNeg = {
        episodeId: "ep-neg",
        contextEventIds: [firstId],
        seekStartMs: 5000,
        seekActions: [{ kind: "ASK_AGENT" as const, query: "noisy complaint token", eventId: firstId }],
      };
      const labels = new Map([
        ["ep-pos", { realSeeking: true }],
        ["ep-neg", { realSeeking: false }],
      ]);
      const antPos = new CalibratedAnticipator(store, {
        priorEpisodes: [fakeEpPos],
        episodeLabels: labels,
      });
      const antNeg = new CalibratedAnticipator(store, {
        priorEpisodes: [fakeEpNeg],
        episodeLabels: labels,
      });
      const scorePos = antPos.score({ endMs: 10_000, eventIds: [firstId] }).pSeek;
      const scoreNeg = antNeg.score({ endMs: 10_000, eventIds: [firstId] }).pSeek;
      assert.ok(scorePos > scoreNeg, `expected positive label score (${scorePos}) > negative label score (${scoreNeg})`);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
