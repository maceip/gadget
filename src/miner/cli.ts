#!/usr/bin/env node
// gadget history miner and runtime CLI. Usage:
//   npm run mine -- ingest                      rebuild ~/.gadget/miner.db from your files
//   npm run mine -- report [--seed N] [--out D] write the ceiling report and labels.csv
//   npm run mine -- probe                       print Codex/Antigravity file structure (no content)
//   npm run mine -- replay                      run Phase 1 replay harness (upper-bound, realistic, anticipator)
//   npm run mine -- mcp                         run Phase 2 read-only MCP stdio server exposing recall(query)
// Offline and read-only on every source. Config overrides: ~/.gadget/config.json.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { listAudioDevices, recordAudioClip } from "../media/audio_recorder.js";
import { captureClipboardOnce } from "../media/clipboard.js";
import { captureScreenAndOcr } from "../media/screen.js";
import { transcribeAudio } from "../media/stt.js";
import { listVoices, speakAloud, synthesizeSpeech } from "../media/tts.js";
import { runStdioMcpServer } from "../mcp/server.js";
import { formatReplayTable, runReplay } from "../runtime/replay.js";
import { startWorkbenchServer } from "../web/server.js";
import { evaluateCeiling } from "./ceiling.js";
import { loadConfig } from "./config.js";
import { buildEpisodes } from "./episodes.js";
import { formatIngestTable, ingest } from "./ingest.js";
import { probe } from "./probe.js";
import { rate, writeReport } from "./report.js";
import { computeSensitivity } from "./sensitivity.js";
import { EventStore } from "./store.js";

function checkNode(): void {
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  if (major < 22 || (major === 22 && minor < 13)) {
    console.error(`gadget miner needs Node 22.13 or newer (node:sqlite); this is ${process.versions.node}`);
    process.exit(2);
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  checkNode();
  // Everything this tool writes (store, journals, reports) holds private data.
  process.umask(0o077);
  const [cmd, ...args] = argv;
  const cfg = loadConfig();

  if (cmd === "ingest") {
    const summary = ingest(cfg);
    console.log(formatIngestTable(summary));
    console.log(`\nstore: ${cfg.dbPath}`);
    return 0;
  }

  if (cmd === "report") {
    if (!existsSync(cfg.dbPath)) {
      console.error(`no store at ${cfg.dbPath}; run: npm run mine -- ingest`);
      return 1;
    }
    const seed = flag(args, "--seed");
    if (seed !== undefined) cfg.seed = Number(seed);
    const store = new EventStore(cfg.dbPath, { readOnly: true });
    try {
      const events = store.allEventsSorted();
      const episodes = buildEpisodes(events, cfg);
      const ceiling = evaluateCeiling(episodes, store);
      const written = writeReport(
        {
          cfg,
          counts: store.readCounts(),
          events,
          episodes,
          ceiling,
          sensitivity: computeSensitivity(events, store, cfg),
          generatedAt: new Date(),
        },
        flag(args, "--out"),
      );
      console.log(`episodes: ${episodes.length}`);
      console.log(`repeat-seek rate: ${rate(ceiling.repeatSeek)}`);
      console.log(`local-hit rate: ${rate(ceiling.localHit)}`);
      console.log(`local-hit rate, older than one day: ${rate(ceiling.localHitOlderThanDay)}`);
      console.log(`\nreport: ${written.reportPath}\nlabels: ${written.labelsPath}`);
    } finally {
      store.close();
    }
    return 0;
  }

  if (cmd === "probe") {
    console.log(probe(cfg));
    return 0;
  }

  if (cmd === "replay") {
    if (!existsSync(cfg.dbPath)) {
      console.error(`no store at ${cfg.dbPath}; run: npm run mine -- ingest`);
      return 1;
    }
    const store = new EventStore(cfg.dbPath, { readOnly: true });
    try {
      const events = store.allEventsSorted();
      const episodes = buildEpisodes(events, cfg);
      const summary = await runReplay(episodes, store);
      console.log(formatReplayTable(summary));
    } finally {
      store.close();
    }
    return 0;
  }

  if (cmd === "mcp") {
    await runStdioMcpServer();
    return 0;
  }

  if (cmd === "web" || cmd === "label") {
    const portArg = flag(args, "--port") ?? process.env.GADGET_PORT;
    const port = portArg ? Number(portArg) : 4321;
    const started = await startWorkbenchServer(cfg, { port });
    console.log(`gadget tagging workbench & chrome capture listening at ${started.url}`);
    console.log(`active report directory: ${started.getReportDir()}`);
    await new Promise(() => {});
    return 0;
  }

  if (cmd === "tts") {
    if (args.includes("--list-voices")) {
      const voices = listVoices();
      for (const v of voices) console.log(`${v.name}\t${v.locale}\t# ${v.sampleText}`);
      return 0;
    }
    const outPath = flag(args, "--out");
    const voice = flag(args, "--voice");
    const rateArg = flag(args, "--rate");
    const text = args.filter((a, i) => a !== "--out" && a !== "--voice" && a !== "--rate" && args[i - 1] !== "--out" && args[i - 1] !== "--voice" && args[i - 1] !== "--rate").join(" ").trim();
    if (!text) {
      console.error("usage: npm run mine -- tts <text> [--out file.wav] [--voice VoiceName] [--rate WPM] | --list-voices");
      return 2;
    }
    if (outPath) {
      const res = synthesizeSpeech({
        text,
        outputPath: outPath,
        ...(voice ? { voice } : {}),
        ...(rateArg ? { rateWpm: Number(rateArg) } : {}),
      });
      console.log(JSON.stringify(res));
    } else {
      speakAloud({
        text,
        ...(voice ? { voice } : {}),
        ...(rateArg ? { rateWpm: Number(rateArg) } : {}),
      });
      console.log(JSON.stringify({ spoken: true, text }));
    }
    return 0;
  }

  if (cmd === "stt") {
    const audioPath = args[0];
    if (!audioPath) {
      console.error("usage: npm run mine -- stt <audio.wav> [--model path/to/ggml.bin]");
      return 2;
    }
    const modelPath = flag(args, "--model");
    const captureJsonlPath = join(dirname(cfg.zshHook), "audio.jsonl");
    const res = transcribeAudio({
      audioPath,
      ...(modelPath ? { modelPath } : {}),
      captureJsonlPath,
    });
    console.log(JSON.stringify(res));
    return 0;
  }

  if (cmd === "record-audio") {
    if (args.includes("--list-devices")) {
      console.log(JSON.stringify(listAudioDevices(), null, 2));
      return 0;
    }
    const durationSec = Number(flag(args, "--duration") ?? args[0] ?? "5");
    const outPath = flag(args, "--out");
    const deviceIdx = flag(args, "--device");
    const transcribe = !args.includes("--no-transcribe");
    const captureJsonlPath = join(dirname(cfg.zshHook), "audio.jsonl");
    const res = recordAudioClip({
      durationSec,
      ...(outPath ? { outputPath: outPath } : {}),
      ...(deviceIdx !== undefined ? { audioDeviceIndex: Number(deviceIdx) } : {}),
      transcribe,
      captureJsonlPath,
    });
    console.log(JSON.stringify(res));
    return 0;
  }

  if (cmd === "capture-screen") {
    const outPath = flag(args, "--out");
    const keepImage = args.includes("--keep") || Boolean(outPath);
    const captureJsonlPath = join(dirname(cfg.zshHook), "screen.jsonl");
    const res = captureScreenAndOcr({
      ...(outPath ? { outputPath: outPath } : {}),
      keepImage,
      captureJsonlPath,
    });
    console.log(JSON.stringify(res));
    return 0;
  }

  if (cmd === "capture-clipboard") {
    const captureJsonlPath = join(dirname(cfg.zshHook), "clipboard.jsonl");
    const res = captureClipboardOnce({ captureJsonlPath });
    console.log(JSON.stringify(res));
    return 0;
  }

  console.error(
    "usage: npm run mine -- ingest | report [--seed N] [--out DIR] | probe | replay | mcp | web [--port N] | tts | stt | record-audio | capture-screen | capture-clipboard",
  );
  return 2;
}

// exitCode, not exit(): stdout to a pipe is asynchronous and must drain first.
main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
