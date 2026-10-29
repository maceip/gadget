#!/usr/bin/env node
// Owner-owned guard (see AGENTS.md section 4). Fails if send-capable APIs appear
// anywhere in tracked files, or network APIs appear under src/miner/ or src/capture/.
//
// Usage: node scripts/guard_no_send.mjs [--root <git work tree>]
//
// This is a backstop. A pattern scan can be beaten with string tricks; the real
// fence is running agents as a separate user with read-only tokens.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SEND_PATTERNS = [
  "osascript",
  'application "Messages"',
  "gmail.send",
  "gmail.compose",
  "gmail.modify",
  "nodemailer",
  "smtplib",
  ".click()",
  "dispatchEvent(",
  ".submit()",
  "chrome.debugger",
  "addResultsToIntent",
  "sendTextMessage",
  "sendMultipartTextMessage",
];

const NETWORK_SCOPES = ["src/miner/", "src/capture/"];
const NETWORK_PATTERNS = [
  { name: "http/https/http2/net/dgram/tls/undici module", re: /["'](node:)?(http|https|http2|net|dgram|tls|undici)["']/ },
  { name: "fetch(", re: /\bfetch\s*\(/ },
  { name: "WebSocket", re: /\bWebSocket\b/ },
  { name: "curl/wget", re: /\b(curl|wget)\b/ },
];

// The only exclusions. Do not add more without owner review.
const EXCLUDED = (path) =>
  path === "AGENTS.md" || path.startsWith("archive/") || path === "scripts/guard_no_send.mjs";

function parseArgs(argv) {
  const i = argv.indexOf("--root");
  return { root: i >= 0 ? argv[i + 1] : process.cwd() };
}

function trackedFiles(root) {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

export function scan(root) {
  const hits = [];
  for (const path of trackedFiles(root)) {
    if (EXCLUDED(path)) continue;
    let buf;
    try {
      buf = readFileSync(join(root, path));
    } catch {
      continue; // deleted in the work tree but still in the index
    }
    if (buf.includes(0)) continue; // binary
    const lines = buf.toString("utf8").split("\n");
    const networkScoped = NETWORK_SCOPES.some((s) => path.startsWith(s));
    lines.forEach((line, idx) => {
      for (const p of SEND_PATTERNS) {
        if (line.includes(p)) hits.push(`${path}:${idx + 1}: send pattern ${JSON.stringify(p)}`);
      }
      if (networkScoped) {
        for (const p of NETWORK_PATTERNS) {
          if (p.re.test(line)) hits.push(`${path}:${idx + 1}: network pattern ${p.name}`);
        }
      }
    });
  }
  return hits;
}

const { root } = parseArgs(process.argv.slice(2));
const hits = scan(root);
if (hits.length > 0) {
  console.error(`guard_no_send: FAIL (${hits.length} hit${hits.length === 1 ? "" : "s"})`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log("guard_no_send: OK");
