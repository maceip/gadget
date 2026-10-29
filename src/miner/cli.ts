#!/usr/bin/env node
// gadget history miner. Usage:
//   npm run mine -- ingest                      rebuild ~/.gadget/miner.db from your files
//   npm run mine -- report [--seed N] [--out D] write the ceiling report and labels.csv
//   npm run mine -- probe                       print Codex/Antigravity file structure (no content)
// Offline and read-only on every source. Config overrides: ~/.gadget/config.json.

import { existsSync } from "node:fs";
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

function main(argv: string[]): number {
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

  console.error("usage: npm run mine -- ingest | report [--seed N] [--out DIR] | probe");
  return 2;
}

process.exit(main(process.argv.slice(2)));
