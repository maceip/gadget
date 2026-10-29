import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { discoverRepos, parseGitLog, readGitRepo } from "../src/miner/parsers/git.js";
import { tmp } from "./helpers.js";

function initRepo(dir: string, commits: Array<{ msg: string; date: string; authorDate?: string }>) {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      stdio: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
  git("init", "-q");
  git("config", "user.name", "Owner");
  git("config", "user.email", "owner@example.com");
  commits.forEach((c, i) => {
    writeFileSync(join(dir, `f${i}.txt`), c.msg);
    git("add", ".");
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", c.msg], {
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_DATE: c.authorDate ?? c.date,
        GIT_COMMITTER_DATE: c.date,
      },
    });
  });
}

test("git: discovers repos to maxDepth, skips node_modules and hidden dirs, stops at a repo", () => {
  const root = tmp();
  initRepo(join(root, "code", "proj"), [{ msg: "init", date: "2026-01-02T03:04:05Z" }]);
  initRepo(join(root, "code", "proj", "vendor", "inner"), [{ msg: "vendored", date: "2026-01-02T03:04:05Z" }]);
  initRepo(join(root, "node_modules", "dep"), [{ msg: "dep", date: "2026-01-02T03:04:05Z" }]);
  initRepo(join(root, ".hidden", "repo"), [{ msg: "hidden", date: "2026-01-02T03:04:05Z" }]);
  initRepo(join(root, "a", "b", "c", "d", "deep"), [{ msg: "deep", date: "2026-01-02T03:04:05Z" }]);
  assert.deepEqual(discoverRepos([root], 4), [join(root, "code", "proj")]);
  assert.deepEqual(discoverRepos([root], 5), [join(root, "a", "b", "c", "d", "deep"), join(root, "code", "proj")]);
});

test("git: log is parsed with exact commit times; truncation is flagged", () => {
  const repo = join(tmp(), "proj");
  initRepo(repo, [
    { msg: "Add build", date: "2026-01-02T03:04:05Z" },
    { msg: "Drop --jitless\n\nUse --wasm-tier-up=false instead.", date: "2026-02-03T04:05:06Z" },
  ]);
  const r = readGitRepo(repo, 100);
  assert.equal(r.counts.parsed, 2);
  const byTime = [...r.events].sort((a, b) => a.timestampMs - b.timestampMs);
  assert.equal(byTime[0]!.timestampMs, Date.UTC(2026, 0, 2, 3, 4, 5));
  assert.equal(byTime[1]!.contentText, "Drop --jitless\nUse --wasm-tier-up=false instead.");
  assert.match(byTime[1]!.sourceUri, new RegExp(`^git:${repo}@[0-9a-f]{40}$`));
  assert.equal(JSON.parse(byTime[1]!.metadataJson).author, "Owner");

  const truncated = readGitRepo(repo, 1);
  assert.equal(truncated.counts.parsed, 1);
  assert.equal(truncated.counts.skipped.truncated_at_max_commits, 1);
});

test("git: malformed records are counted, not guessed", () => {
  const r = parseGitLog("garbage\u001e\n" + "a".repeat(40) + "\u001fnot-a-time\u001fx\u001fy\u001f\u001e", "/r");
  assert.equal(r.counts.parsed, 0);
  assert.equal(r.counts.skipped.malformed_record, 2);
});

test("git: a path that is not a repo is reported, not thrown", () => {
  const r = readGitRepo(tmp(), 10);
  assert.equal(r.counts.unknown.git_log_failed, 1);
});

test("git: events use committer time, so a rebased commit with an old author date is not back-dated", () => {
  const repo = join(tmp(), "proj");
  initRepo(repo, [{ msg: "Cherry-picked fix", authorDate: "2025-01-01T00:00:00Z", date: "2026-03-04T05:06:07Z" }]);
  const r = readGitRepo(repo, 10);
  assert.equal(r.events[0]!.timestampMs, Date.UTC(2026, 2, 4, 5, 6, 7));
});
