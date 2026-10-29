// A fake HOME containing every source the miner reads, with one realistic story:
// a flag (--jitless) removed in a commit a month ago, discussed with Codex 11 days ago,
// searched for 3 days ago, then searched for again today after a failing build.
//
// Try the miner on it without touching your own data:
//   npm run build
//   HOME=$(node --disable-warning=ExperimentalWarning -e 'import("./dist/test/fixtures/fake_home.js").then(m => console.log(m.fakeHome()))') \
//     node --disable-warning=ExperimentalWarning dist/src/miner/cli.js ingest

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHROME_EPOCH_OFFSET_MS } from "../../src/miner/parsers/chrome.js";
import { DAY, MIN, T0, tmp } from "../helpers.js";

const sec = (ms: number) => Math.floor(ms / 1000);

export function fakeHome(): string {
  const home = tmp("gadget-home-");

  // zsh history: an old search for the flag, then today's search, plus a line without a timestamp.
  writeFileSync(
    join(home, ".zsh_history"),
    [
      `: ${sec(T0 - 3 * DAY)}:0;rg -- --jitless`,
      "untimed old line",
      `: ${sec(T0)}:0;rg -- --jitless`,
      `: ${sec(T0 + 2 * MIN)}:0;vim build.ts`,
      "",
    ].join("\n"),
  );

  // zsh hook: a failing build before the search, then a passing one.
  mkdirSync(join(home, ".gadget", "capture"), { recursive: true });
  writeFileSync(
    join(home, ".gadget", "capture", "zsh.jsonl"),
    [
      { v: 1, start_ms: T0 - 5 * MIN, end_ms: T0 - 5 * MIN + 900, cwd: "/w/vitre", cmd: "npm run build", exit: 1 },
      { v: 1, start_ms: T0 + 1000, end_ms: T0 + 1500, cwd: "/w/vitre", cmd: "rg -- --jitless", exit: 0 },
      { v: 1, start_ms: T0 + 5 * MIN, end_ms: T0 + 5 * MIN + 900, cwd: "/w/vitre", cmd: "npm run build", exit: 0 },
    ]
      .map((o) => JSON.stringify(o))
      .join("\n") + "\n",
  );

  // Codex: an old session where the assistant gave the answer.
  const sessions = join(home, ".codex", "sessions", "2026", "09", "20");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    join(sessions, "rollout-a.jsonl"),
    [
      { timestamp: new Date(T0 - 11 * DAY).toISOString(), type: "session_meta", payload: { cwd: "/w/vitre" } },
      {
        timestamp: new Date(T0 - 11 * DAY).toISOString(),
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "why does --jitless break the wasm build?" }] },
      },
      {
        timestamp: new Date(T0 - 11 * DAY + MIN).toISOString(),
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "--jitless was dropped; use --wasm-tier-up=false." }] },
      },
    ]
      .map((o) => JSON.stringify(o))
      .join("\n") + "\n",
  );

  // Chrome: one search, one docs visit.
  const chromeRoot = join(home, "chrome");
  mkdirSync(join(chromeRoot, "Default"), { recursive: true });
  const db = new DatabaseSync(join(chromeRoot, "Default", "History"));
  db.exec(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
           CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER);
           CREATE TABLE keyword_search_terms (keyword_id INTEGER, url_id INTEGER, term TEXT, normalized_term TEXT);`);
  const ct = (ms: number) => (BigInt(ms) + BigInt(CHROME_EPOCH_OFFSET_MS)) * 1000n;
  db.prepare("INSERT INTO urls VALUES (?, ?, ?)").run(1, "https://www.google.com/search?q=v8+jitless", "v8 jitless - Google Search");
  db.prepare("INSERT INTO urls VALUES (?, ?, ?)").run(2, "https://v8.dev/blog/jitless", "Lite mode and --jitless");
  db.prepare("INSERT INTO visits VALUES (?, ?, ?)").run(1, 1, ct(T0 + MIN));
  db.prepare("INSERT INTO visits VALUES (?, ?, ?)").run(2, 2, ct(T0 + MIN + 20_000));
  db.prepare("INSERT INTO keyword_search_terms VALUES (?, ?, ?, ?)").run(2, 1, "v8 jitless", "v8 jitless");
  db.close();

  // git: the commit that removed the flag, a month earlier.
  const repo = join(home, "code", "vitre");
  mkdirSync(repo, { recursive: true });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  execFileSync("git", ["init", "-q", repo], { env });
  writeFileSync(join(repo, "build.ts"), "x\n");
  execFileSync("git", ["-C", repo, "add", "."], { env });
  const date = new Date(T0 - 30 * DAY).toISOString();
  execFileSync(
    "git",
    ["-C", repo, "-c", "user.name=Owner", "-c", "user.email=o@example.com", "commit", "-q", "-m", "Drop --jitless; use --wasm-tier-up=false"],
    { env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } },
  );

  writeFileSync(
    join(home, ".gadget", "config.json"),
    JSON.stringify({ chromiumRoots: [chromeRoot], gitRoots: [join(home, "code")] }),
  );
  return home;
}
