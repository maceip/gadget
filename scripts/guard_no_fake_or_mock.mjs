#!/usr/bin/env node
// Mechanical enforcement of AGENTS.md Section 2:
// Fails if any hardcoded demo names/numbers, mocks, stubs, TODO placeholders,
// or hardcoded keyword score hacks appear anywhere under `src/`.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN_SRC_RULES = [
  { name: "hardcoded demo contact 'Dr. Chen'", re: /\bDr\.\s*Chen\b/i },
  { name: "hardcoded demo contact 'Nikesh' in code", re: /["'`]nikesh["'`]/i },
  { name: "hardcoded demo phone '555-'", re: /\b555-\d{4}\b/ },
  { name: "hallucinated citation 'TomasuLLM' / '2609.38201'", re: /\b(?:TomasuLLM|2609\.38201)\b/i },
  { name: "hardcoded keyword score boost (.includes('webview'))", re: /\.includes\(\s*["'`]webview["'`]\s*\)/i },
  { name: "mock/stub/fake/placeholder identifier in src/", re: /\b(?:mockData|fakeData|stubData|dummyData|NotImplementedError)\b/i },
  { name: "unfinished TODO/FIXME in src/", re: /\b(?:TODO|FIXME)\s*:/ },
];

function parseArgs(argv) {
  const i = argv.indexOf("--root");
  return { root: i >= 0 ? argv[i + 1] : process.cwd() };
}

function trackedSrcFiles(root) {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z", "src/"], { encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

export function scanSrcForFakeOrMock(root) {
  const hits = [];
  for (const relPath of trackedSrcFiles(root)) {
    let text;
    try {
      text = readFileSync(join(root, relPath), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      // Skip pure comment lines so docstrings explaining what not to do don't self-trip,
      // while enforcing strictly on all executable lines in src/.
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
      for (const rule of FORBIDDEN_SRC_RULES) {
        if (rule.re.test(line)) {
          hits.push(`${relPath}:${idx + 1}: forbidden ${rule.name}`);
        }
      }
    });
  }
  return hits;
}

const { root } = parseArgs(process.argv.slice(2));
const hits = scanSrcForFakeOrMock(root);
if (hits.length > 0) {
  console.error(`guard_no_fake_or_mock: FAIL (${hits.length} hit${hits.length === 1 ? "" : "s"})`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log("guard_no_fake_or_mock: OK");
