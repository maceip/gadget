// Validates the JSONL written by driver.zsh. Usage: node check.mjs <log path>
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

const log = process.argv[2];
const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
const records = lines.map((l, i) => {
  try {
    return JSON.parse(l);
  } catch (e) {
    throw new Error(`line ${i + 1} is not valid JSON: ${l}`);
  }
});

const expected = [
  { cmd: "echo plain", exit: 0 },
  { cmd: 'echo "quoted" back\\slash', exit: 0 },
  { cmd: "echo line1\necho line2", exit: 0 },
  { cmd: "echo héllo 日本", exit: 0 },
  { cmd: "make build", exit: 3 },
  { cmd: "tab\there" + "ctl", exit: 0 },
];

assert.equal(records.length, expected.length, `expected ${expected.length} records, got ${records.length}`);
records.forEach((r, i) => {
  assert.equal(r.v, 1);
  assert.equal(r.cmd, expected[i].cmd, `record ${i + 1} cmd`);
  assert.equal(r.exit, expected[i].exit, `record ${i + 1} exit`);
  assert.equal(typeof r.cwd, "string");
  assert.ok(r.cwd.length > 0);
  assert.ok(Number.isInteger(r.start_ms) && r.start_ms > 1.6e12, `record ${i + 1} start_ms`);
  assert.ok(Number.isInteger(r.end_ms) && r.end_ms >= r.start_ms, `record ${i + 1} end_ms`);
});
assert.ok(!records.some((r) => r.cmd.includes("SECRET")), "space-prefixed command was recorded");

const mode = statSync(log).mode & 0o777;
assert.equal(mode, 0o600, `log mode is ${mode.toString(8)}, want 600`);
const dirMode = statSync(dirname(log)).mode & 0o777;
assert.equal(dirMode, 0o700, `log dir mode is ${dirMode.toString(8)}, want 700`);

console.log(`zsh hook: OK (${records.length} records, modes 600/700)`);
