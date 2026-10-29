import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { availabilityTimes, discoverRepos, parseGitLog, parseReflog, readGitRepo } from "../src/miner/parsers/git.js";
import { EventStore } from "../src/miner/store.js";
import { RepoGrepSearcher } from "../src/runtime/searchers.js";
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
  assert.equal(byTime[0]!.timestampMs, Date.UTC(2026, 0, 2, 3, 4, 5) + 999);
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

test("git: a rebased commit with an old author date is not back-dated", () => {
  const repo = join(tmp(), "proj");
  initRepo(repo, [{ msg: "Cherry-picked fix", authorDate: "2025-01-01T00:00:00Z", date: "2026-03-04T05:06:07Z" }]);
  const r = readGitRepo(repo, 10);
  assert.equal(r.events[0]!.timestampMs, Date.UTC(2026, 2, 4, 5, 6, 7) + 999);
});

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function at(dir: string, date: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: "pipe",
    env: { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  }).trim();
}

test("git: fetched commits are dated when they arrived here, not when upstream committed them", () => {
  const root = tmp();
  const up = join(root, "up");
  const mine = join(root, "mine");
  mkdirSync(up);
  at(up, "2001-01-01T00:00:00Z", "init", "-q");
  at(up, "2001-01-01T00:00:00Z", "-c", "user.email=other@example.com", "-c", "user.name=Other", "commit", "-q", "--allow-empty", "-m", "upstream: old fix");
  at(root, "2026-05-01T00:00:00Z", "clone", "-q", up, mine);
  at(mine, "2026-05-01T00:00:00Z", "config", "user.email", "owner@example.com");
  at(mine, "2026-05-01T00:00:00Z", "config", "user.name", "Owner");
  at(up, "2001-06-01T00:00:00Z", "-c", "user.email=other@example.com", "-c", "user.name=Other", "commit", "-q", "--allow-empty", "-m", "upstream: second fix");
  at(mine, "2026-06-01T00:00:00Z", "fetch", "-q");
  at(mine, "2026-07-01T00:00:00Z", "commit", "-q", "--allow-empty", "-m", "mine: local work");
  // Reachable only from a tag, which has no reflog: when it arrived is unknown.
  const tagged = at(up, "2001-07-01T00:00:00Z", "-c", "user.email=other@example.com", "-c", "user.name=Other", "commit-tree", "-m", "upstream: tagged only", "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  at(up, "2001-07-01T00:00:00Z", "tag", "lone", tagged);
  at(mine, "2026-08-01T00:00:00Z", "fetch", "-q", "--tags");

  const r = readGitRepo(mine, 100);
  const byText = new Map(r.events.map((e) => [e.contentText, e]));
  assert.equal(byText.get("upstream: old fix")!.timestampMs, Date.UTC(2026, 4, 1) + 999);
  assert.equal(byText.get("upstream: second fix")!.timestampMs, Date.UTC(2026, 5, 1) + 999);
  assert.equal(byText.get("mine: local work")!.timestampMs, Date.UTC(2026, 6, 1) + 999);
  assert.deepEqual(JSON.parse(byText.get("upstream: second fix")!.metadataJson), {
    author: "Other",
    committed_ms: Date.UTC(2001, 5, 1),
  });
  assert.equal(byText.has("upstream: tagged only"), false);
  assert.equal(r.counts.skipped.no_local_time, 1);
});

test("git: availability is the earliest reflog entry that reaches a commit", () => {
  // a <- b <- c (main), a <- d (side); reflog: main at b (t=10), side at d (t=20), main at c (t=30)
  const parents = new Map([
    ["a", []],
    ["b", ["a"]],
    ["c", ["b"]],
    ["d", ["a"]],
  ]);
  const t = availabilityTimes(parents, [
    { sha: "b", atMs: 10 },
    { sha: "d", atMs: 20 },
    { sha: "c", atMs: 30 },
    { sha: "unknown", atMs: 40 },
  ]);
  assert.deepEqual([...t.entries()].sort(), [
    ["a", 10],
    ["b", 10],
    ["c", 30],
    ["d", 20],
  ]);
});

test("git: reflog lines are parsed and sorted by time; a commit with no reflog time is skipped, even the owner's", () => {
  const sha = (c: string) => c.repeat(40);
  const reflog = parseReflog(
    [`${sha("b")}\u001fHEAD@{200}`, `${sha("a")}\u001frefs/heads/main@{100}`, "garbage", `${sha("c")}\u001fHEAD@{not-a-time}`].join("\n"),
  );
  assert.deepEqual(reflog, [
    { sha: sha("a"), atMs: 100_999 },
    { sha: sha("b"), atMs: 200_999 },
  ]);
  const rec = (s: string, author: string) => `${s}\u001f\u001f50\u001f${author}\u001fsubject ${author}\u001f\u001e`;
  const r = parseGitLog(rec(sha("d"), "Owner") + rec(sha("e"), "Other"), "/r", [{ sha: sha("e"), atMs: 60_999 }]);
  assert.deepEqual(
    r.events.map((e) => [e.contentText, e.timestampMs]),
    [["subject Other", 60_999]],
  );
  assert.equal(r.counts.skipped.no_local_time, 1);
});

test("runtime repo grep at a past moment uses the checkout HEAD had then, not a commit fetched later", async () => {
  const root = tmp();
  const up = join(root, "up");
  const mine = join(root, "mine");
  mkdirSync(up);
  at(up, "2026-01-01T00:00:00Z", "init", "-q");
  writeFileSync(join(up, "build.ts"), "export const flags = [];\n");
  at(up, "2026-01-01T00:00:00Z", "add", ".");
  at(up, "2026-01-01T00:00:00Z", "-c", "user.email=other@example.com", "-c", "user.name=Other", "commit", "-q", "-m", "init");
  at(root, "2026-01-01T00:00:00Z", "clone", "-q", up, mine);
  writeFileSync(join(up, "build.ts"), "export const flags = ['--tier-up-flag'];\n");
  // Committed upstream in February, but only fetched and checked out here in June.
  at(up, "2026-02-01T00:00:00Z", "-c", "user.email=other@example.com", "-c", "user.name=Other", "commit", "-q", "-am", "add flag");
  at(mine, "2026-06-01T00:00:00Z", "fetch", "-q");
  at(mine, "2026-06-01T00:00:00Z", "merge", "-q", "--ff-only", "origin/HEAD");

  const store = new EventStore(join(tmp(), "s.db"));
  try {
    const grep = new RepoGrepSearcher(store, mine);
    assert.deepEqual(await grep.search("--tier-up-flag", Date.UTC(2026, 2, 1)), []);
    const later = await grep.search("--tier-up-flag", Date.UTC(2026, 6, 1));
    assert.equal(later.length, 1);
    assert.match(later[0]!.sourceUri, /build\.ts:1$/);
    // Before the clone there is no local state at all.
    assert.deepEqual(await grep.search("--tier-up-flag", Date.UTC(2025, 11, 1)), []);
  } finally {
    store.close();
  }
});

test("git: a committer time later than local arrival does not postpone the commit", () => {
  const sha = "f".repeat(40);
  const rec = `${sha}\u001f\u001f500\u001fOther\u001ffuture-dated\u001f\u001e`;
  const r = parseGitLog(rec, "/r", [{ sha, atMs: 100_000 }]);
  assert.equal(r.events[0]!.timestampMs, 100_000);
  assert.equal(JSON.parse(r.events[0]!.metadataJson).committed_ms, 500_000);
});

test("git: whole-second times are dated at the end of their second", () => {
  // A fetch logged at second 100 may have happened at 100.9; a seek at 100.5 must not see it.
  const sha = "e".repeat(40);
  const [entry] = parseReflog(`${sha}\u001fHEAD@{100}`);
  assert.equal(entry!.atMs, 100_999);
  assert.ok(!(entry!.atMs < 100_500));
});
