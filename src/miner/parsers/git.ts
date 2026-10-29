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

export function parseGitLog(output: string, repo: string): ParseResult {
  const counts = emptyCounts();
  const events: EpisodicEvent[] = [];
  for (const raw of output.split(RECORD)) {
    const rec = raw.replace(/^\n+/, "");
    if (!rec) continue;
    counts.read++;
    const [sha, at, author, subject, body] = rec.split(FIELD);
    if (!sha || !at || !/^[0-9a-f]{40}$/.test(sha) || !/^\d+$/.test(at)) {
      bump(counts.skipped, "malformed_record");
      continue;
    }
    events.push(
      makeEvent({
        source: "git",
        timestampMs: Number(at) * 1000,
        workspacePath: repo,
        contentText: `${subject ?? ""}\n${body ?? ""}`.trim(),
        sourceUri: `git:${repo}@${sha}`,
        metadataJson: JSON.stringify({ author: author ?? "" }),
      }),
    );
    counts.parsed++;
  }
  return { events, counts };
}

// Read-only: `git log` with --no-optional-locks so it never takes the index lock.
// Events use the committer time (%ct), not the author time: a rebased, cherry-picked,
// or imported commit can carry an author date long before it existed here, which
// would leak it into replays of earlier moments. (Fetch time would be stricter still;
// it is not recorded in the log.)
export function readGitRepo(repo: string, maxCommits: number): ParseResult {
  let out: string;
  try {
    out = execFileSync(
      "git",
      [
        "--no-optional-locks",
        "-C",
        repo,
        "log",
        "--all",
        "--no-color",
        `--max-count=${maxCommits}`,
        `--format=%H${FIELD}%ct${FIELD}%an${FIELD}%s${FIELD}%b${RECORD}`,
      ],
      { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    const counts = emptyCounts();
    bump(counts.unknown, "git_log_failed");
    return { events: [], counts };
  }
  const result = parseGitLog(out, repo);
  if (result.counts.parsed >= maxCommits) bump(result.counts.skipped, "truncated_at_max_commits");
  return result;
}
