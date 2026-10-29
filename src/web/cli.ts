#!/usr/bin/env node
// Starts the Gadget Episode Tagging Workbench & Chrome Extension Capture server.
// Usage: npm run web [-- --port 4321]

import { loadConfig } from "../miner/config.js";
import { startWorkbenchServer } from "./server.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<void> {
  process.umask(0o077);
  const cfg = loadConfig();
  const portArg = flag(argv, "--port") ?? process.env.GADGET_PORT;
  const port = portArg ? Number(portArg) : 4321;
  const started = await startWorkbenchServer(cfg, { port });
  console.log(`gadget tagging workbench & chrome capture listening at ${started.url}`);
  console.log(`active report directory: ${started.getReportDir()}`);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
