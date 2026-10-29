import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MinerConfig {
  zshHistory: string;
  zshHook: string;
  chromiumRoots: string[];
  codexDir: string;
  antigravityDir: string;
  gitRoots: string[];
  gitMaxDepth: number;
  maxCommitsPerRepo: number;
  seekGapMs: number;
  contextWindowMs: number;
  resolutionWindowMs: number;
  maxContextEvents: number;
  dbPath: string;
  reportsDir: string;
  sampleSize: number;
  seed: number;
}

const MIN = 60 * 1000;

export function defaultConfig(home: string = homedir(), platform: NodeJS.Platform = process.platform): MinerConfig {
  const appSupport = join(home, "Library", "Application Support");
  const chromiumRoots =
    platform === "darwin"
      ? ["Google/Chrome", "Chromium", "BraveSoftware/Brave-Browser", "Microsoft Edge", "Arc/User Data"].map((p) =>
          join(appSupport, p),
        )
      : [".config/google-chrome", ".config/chromium", ".config/BraveSoftware/Brave-Browser"].map((p) => join(home, p));
  return {
    zshHistory: join(home, ".zsh_history"),
    zshHook: join(home, ".gadget", "capture", "zsh.jsonl"),
    chromiumRoots,
    codexDir: join(home, ".codex", "sessions"),
    antigravityDir: join(home, ".gemini", "antigravity", "brain"),
    gitRoots: [home],
    gitMaxDepth: 4,
    maxCommitsPerRepo: 20000,
    seekGapMs: 5 * MIN,
    contextWindowMs: 10 * MIN,
    resolutionWindowMs: 30 * MIN,
    maxContextEvents: 50,
    dbPath: join(home, ".gadget", "miner.db"),
    reportsDir: join(home, ".gadget", "reports"),
    sampleSize: 25,
    seed: 1,
  };
}

// Defaults, overridden by ~/.gadget/config.json (or GADGET_CONFIG), then by $HISTFILE.
export function loadConfig(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): MinerConfig {
  const cfg = defaultConfig(home);
  const path = env.GADGET_CONFIG ?? join(home, ".gadget", "config.json");
  if (existsSync(path)) {
    const overrides = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    for (const [k, v] of Object.entries(overrides)) {
      if (!(k in cfg)) throw new Error(`${path}: unknown config key ${JSON.stringify(k)}`);
      const current = (cfg as unknown as Record<string, unknown>)[k];
      if (typeof v !== typeof current || Array.isArray(v) !== Array.isArray(current)) {
        throw new Error(`${path}: config key ${JSON.stringify(k)} has the wrong type`);
      }
      (cfg as unknown as Record<string, unknown>)[k] = v;
    }
  }
  if (env.HISTFILE) cfg.zshHistory = env.HISTFILE;
  return cfg;
}
