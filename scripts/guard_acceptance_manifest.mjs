#!/usr/bin/env node
// Owner-owned guard (see AGENTS.md sections 3 and 8). Fails if any file in
// acceptance/ is missing from, extra to, or differs from acceptance/MANIFEST.sha256.
//
// Usage:
//   node scripts/guard_acceptance_manifest.mjs [--root <dir>]
//   node scripts/guard_acceptance_manifest.mjs --write [--root <dir>]   (owner only)
//
// The manifest catches drift. It does not stop someone who edits a file and the
// manifest together; CODEOWNERS plus branch protection on main does that.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const MANIFEST = "MANIFEST.sha256";

function parseArgs(argv) {
  const i = argv.indexOf("--root");
  return { root: i >= 0 ? argv[i + 1] : process.cwd(), write: argv.includes("--write") };
}

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function actualHashes(accDir) {
  const map = new Map();
  for (const full of walk(accDir)) {
    const rel = relative(accDir, full).split(sep).join("/");
    if (rel === MANIFEST) continue;
    map.set(rel, createHash("sha256").update(readFileSync(full)).digest("hex"));
  }
  return map;
}

function readManifest(path) {
  const map = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) throw new Error(`malformed manifest line: ${JSON.stringify(line)}`);
    map.set(m[2], m[1]);
  }
  return map;
}

const { root, write } = parseArgs(process.argv.slice(2));
const accDir = join(root, "acceptance");
const manifestPath = join(accDir, MANIFEST);
const actual = actualHashes(accDir);

if (write) {
  const lines = [...actual.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, h]) => `${h}  ${p}`);
  writeFileSync(manifestPath, lines.join("\n") + "\n");
  console.log(`guard_acceptance_manifest: wrote ${lines.length} entries`);
  process.exit(0);
}

let expected;
try {
  expected = readManifest(manifestPath);
} catch (e) {
  console.error(`guard_acceptance_manifest: FAIL (${e.message})`);
  process.exit(1);
}

const problems = [];
for (const [p, h] of expected) {
  if (!actual.has(p)) problems.push(`missing: ${p}`);
  else if (actual.get(p) !== h) problems.push(`changed: ${p}`);
}
for (const p of actual.keys()) if (!expected.has(p)) problems.push(`not in manifest: ${p}`);

if (problems.length > 0) {
  console.error(`guard_acceptance_manifest: FAIL (${problems.length})`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`guard_acceptance_manifest: OK (${expected.size} files)`);
