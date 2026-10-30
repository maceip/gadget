#!/usr/bin/env node
// Starts the gogogadget Skypanel HUD & Capture server.
// Usage: npm run web [-- --port 4321]

import { flag, loadConfig } from "../miner/config.js";
import { startWorkbenchServer } from "./server.js";

async function startWebCli(argv: string[]): Promise<void> {
  process.umask(0o077);
  const cfg = loadConfig();
  const portArg = flag(argv, "--port") ?? process.env.GADGET_PORT;
  const port = portArg ? Number(portArg) : 4321;
  const started = await startWorkbenchServer(cfg, { port });
  console.log(`gogogadget skypanel HUD & capture server listening at ${started.url}`);
}

startWebCli(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
