import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeEvent } from "../event.js";
import { bump, emptyCounts, type EpisodicEvent, type ParseResult } from "../types.js";

const SKIP_DIRS = new Set(["node_modules", "Library", "Applications", "Pictures", "Music", "Movies"]);

// Finds git work trees under the roots, down to maxDepth. Does not descend into a
// repo once found (vendored clones inside it are skipped) or into hidden directories.
export function discoverRepos(roots: string[], maxDepth: number): string[] {
  const repos: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (existsSync(join(dir, ".git"))) {
      repos.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots) if (existsSync(r)) walk(r, 0);
  return [...new Set(repos)].sort();
}

const FIELD = "\u001f";
const RECORD = "\u001e";

// When each commit became available on this machine, from the reflogs: every local
// move of HEAD, a branch, or a remote-tracking ref (commit, clone, fetch, pull, merge)
// is logged with its local time. A commit is available from the first reflog entry
// whose target reaches it. Committer time is not enough: `git fetch` today brings in
// upstream commits with committer times from months ago, and a replay of those months
// must not find them.
export interface ReflogEntry {
  sha: string;
  atMs: number;
}

// `git log -g` prints each ref's entries newest first; they are reversed before the
// (stable) sort so entries within the same second stay in the order they happened.
export function parseReflog(output: string): ReflogEntry[] {
  const entries: ReflogEntry[] = [];
  for (const line of output.split("\n").reverse()) {
    const [sha, selector] = line.split(FIELD);
    const at = /@\{(\d+)\}$/.exec(selector ?? "");
    if (sha && /^[0-9a-f]{40}$/.test(sha) && at) entries.push({ sha, atMs: Number(at[1]) * 1000 });
  }
  return entries.sort((a, b) => a.atMs - b.atMs);
}

// Earliest reflog time reaching each commit. Entries are taken in time order; each one
// marks the commits it reaches that no earlier entry reached. Ancestors of a marked
// commit are always marked already, so the walk stops there.
// Known gap: `git fetch --unshallow` adds ancestors without moving any ref, so it
// leaves no reflog entry (nor any other durable trace: .git/shallow is removed, and
// pack mtimes are reset by every gc). Those ancestors get the shallow clone's time.
export function availabilityTimes(parents: Map<string, string[]>, reflog: ReflogEntry[]): Map<string, number> {
  const at = new Map<string, number>();
  for (const { sha, atMs } of reflog) {
    const stack = [sha];
    while (stack.length > 0) {
      const c = stack.pop()!;
      if (at.has(c) || !parents.has(c)) continue;
      at.set(c, atMs);
      stack.push(...parents.get(c)!);
    }
  }
  return at;
}

// `ownerEmail` is the repo's user.email. A commit with no reflog time (reachable only
// from a tag, or from a ref without a reflog) is kept at its committer time only if
// the owner committed it; anyone else's is skipped, since when it arrived is unknown.
export function parseGitLog(output: string, repo: string, reflog: ReflogEntry[] = [], ownerEmail = ""): ParseResult {
  const counts = emptyCounts();
  const events: EpisodicEvent[] = [];
  const records: Array<{ sha: string; parents: string[]; committedMs: number; committer: string; author: string; text: string }> = [];
  for (const raw of output.split(RECORD)) {
    const rec = raw.replace(/^\n+/, "");
    if (!rec) continue;
    counts.read++;
    const [sha, parents, at, committer, author, subject, body] = rec.split(FIELD);
    if (!sha || !at || !/^[0-9a-f]{40}$/.test(sha) || !/^\d+$/.test(at) || parents === undefined) {
      bump(counts.skipped, "malformed_record");
      continue;
    }
    records.push({
      sha,
      parents: parents.split(" ").filter(Boolean),
      committedMs: Number(at) * 1000,
      committer: committer ?? "",
      author: author ?? "",
      text: `${subject ?? ""}\n${body ?? ""}`.trim(),
    });
  }
  const available = availabilityTimes(new Map(records.map((r) => [r.sha, r.parents])), reflog);
  for (const r of records) {
    const reflogMs = available.get(r.sha);
    const ownCommit = ownerEmail !== "" && r.committer.toLowerCase() === ownerEmail.toLowerCase();
    if (reflogMs === undefined && !ownCommit) {
      bump(counts.skipped, "no_local_time");
      continue;
    }
    events.push(
      makeEvent({
        source: "git",
        // The reflog time is this machine's clock at arrival. A later committer time
        // comes from another clock (skew or a future-dated commit) and is kept only as
        // metadata.
        timestampMs: reflogMs ?? r.committedMs,
        workspacePath: repo,
        contentText: r.text,
        sourceUri: `git:${repo}@${r.sha}`,
        metadataJson: JSON.stringify({
          author: r.author,
          committed_ms: r.committedMs,
          time_from: reflogMs === undefined ? "committer" : "reflog",
        }),
      }),
    );
    counts.parsed++;
  }
  return { events, counts };
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["--no-optional-locks", "-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Read-only: `git log` and `git log -g` with --no-optional-locks, so it never takes the
// index lock. Event times are local availability times (see parseReflog); a commit's
// author time is never used, since a rebased or cherry-picked commit keeps its old one.
export function readGitRepo(repo: string, maxCommits: number): ParseResult {
  let out: string;
  try {
    out = git(repo, [
      "log",
      "--all",
      "--no-color",
      `--max-count=${maxCommits}`,
      `--format=%H${FIELD}%P${FIELD}%ct${FIELD}%ce${FIELD}%an${FIELD}%s${FIELD}%b${RECORD}`,
    ]);
  } catch {
    const counts = emptyCounts();
    bump(counts.unknown, "git_log_failed");
    return { events: [], counts };
  }
  let reflog: ReflogEntry[] = [];
  try {
    reflog = parseReflog(git(repo, ["log", "-g", "--all", "--date=unix", `--format=%H${FIELD}%gD`]));
  } catch {
    // no reflogs at all: only the owner's own commits keep a time
  }
  let ownerEmail = "";
  try {
    ownerEmail = git(repo, ["config", "user.email"]).trim();
  } catch {
    // unset
  }
  const result = parseGitLog(out, repo, reflog, ownerEmail);
  if (result.counts.read >= maxCommits) bump(result.counts.skipped, "truncated_at_max_commits");
  return result;
}
