// End to end: a fake HOME with every source, then `mine ingest` and `mine report`
// exactly as the owner will run them.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fakeHome } from "./fixtures/fake_home.js";
import { REPO, tmp } from "./helpers.js";

const CLI = join(REPO, "dist", "src", "miner", "cli.js");

function mine(home: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.HISTFILE;
  delete env.GADGET_CONFIG;
  return spawnSync("node", ["--disable-warning=ExperimentalWarning", CLI, ...args], { encoding: "utf8", env });
}

test("e2e: ingest then report on a fake home", () => {
  const home = fakeHome();

  const ing = mine(home, "ingest");
  assert.equal(ing.status, 0, ing.stderr);
  for (const src of ["zsh_hook", "zsh", "chrome", "codex_session", "git"]) {
    assert.match(ing.stdout, new RegExp(`^${src}\\s+[1-9]`, "m"), `${src} should have read rows:\n${ing.stdout}`);
  }
  assert.match(ing.stdout, /also_in_zsh_hook=1/);
  assert.match(ing.stdout, /no_timestamp=1/);
  assert.match(ing.stdout, /antigravity_session.*not found/);

  const out = join(tmp(), "report");
  const rep = mine(home, "report", "--out", out);
  assert.equal(rep.status, 0, rep.stderr);
  // Episodes: the old search (3 days before) and today's search + web search + agent question.
  assert.match(rep.stdout, /^episodes: 3$/m);
  // Today's --jitless search repeats the one from 3 days earlier.
  assert.match(rep.stdout, /^repeat-seek rate: 1\/3 /m);
  // Every episode has older non-seek data containing its tokens (commit, session).
  assert.match(rep.stdout, /^local-hit rate: 3\/3 /m);

  const md = readFileSync(join(out, "report.md"), "utf8");
  assert.match(md, /COMMAND_SUCCEEDED/);
  assert.match(md, /Top local hit: (git|codex_session)/);
  assert.ok(existsSync(join(out, "labels.csv")));
});

test("e2e: unknown subcommand prints usage and exits 2", () => {
  const r = mine(tmp(), "nope");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});
