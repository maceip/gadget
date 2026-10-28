# gadget v1: plan and rules for agents

Status as of 2026-10-28: **nothing is built.** Earlier notes in this repo describe systems that do not exist. They are untrusted and live in `archive/untrusted-llm-notes/`. Do not cite them as implemented.

## 1. What we are building

An ambient recall system for one user (the owner) on one laptop.

It watches the owner's work (shell, browser, coding-agent sessions, git, clipboard), notices when the owner is about to go looking for something, finds the answer in the owner's own data (or the public web, with restrictions), and puts it where the work happens:

- an MCP tool the owner's coding sessions can call, and
- a sidecar brief file in the workspace.

It never sends anything to anyone.

The core problem is **triggers**: knowing when the owner is about to look for something, and what. Triggers are **learned from the owner's history**, not hand-written.

## 2. Out of scope

Do not build, stub, or describe these as planned:

- Device simulator: OSWorld, android_env, RealToSimSyncBridge, REAL_SYNCED / SIM_ONLY planes, NPC counterparties.
- Phone calls of any kind.
- Messaging or asking people: outreach, drafts addressed to people, reply handling, "who to ask". The owner does not ask people for help, so there is no data to learn it from.
- Skill sharing between users. Federated anything (FedALT, FedBiscuit).
- LLM-built knowledge graph: state_nodes, state_edges, bi-temporal validity, Mem0-style reconciliation, entity extraction, graph retrieval.
- Hand-written triggers.
- Phone APK. Deferred until Phase 0 data shows message threads answer a meaningful share of the owner's searches.

Adding anything from this list requires the owner's written approval in an issue.

## 3. Rules for agents

These exist because previous agents claimed work was done when it was not.

1. **Done means verified.** A task is done only with the commit sha, the CI run URL on that sha, and the command output. Otherwise write "not verified". "Should work" is not a status.
2. **Report failures verbatim.** Paste the failing output. Never present a failure as a success with caveats.
3. **No invented facts.** Do not write numbers, benchmark results, file paths, API names, or citations you did not measure, open, or fetch during this task. A paper citation needs the URL and a verbatim quote. If you don't know, say so.
4. **Never edit `acceptance/`, `scripts/guard_*`, or `CODEOWNERS`.** They belong to the owner. If a test there fails, fix the code. Never skip, disable, or loosen a test to get green.
5. **LLMs never grade LLM output.** Metrics come from the replay harness against the owner's labels, never from a model judging its own work.
6. **Stay in scope.** See section 2.
7. **Status report format:** what you changed, what you ran, the output, what is still unverified.

## 4. Hard safety rules

The system and the agents building it may read all of the owner's data. **Nothing sends.**

- No code path that sends a message, email, post, form submission, or purchase exists in v1. Not behind a flag, not "disabled".
- Coding agents run as a separate macOS user or in a container with the repo and a read-only copy of the data. Never in the owner's GUI session (Messages, Signal Desktop, logged-in browser).
- The owner's phone is never adb-connected to a machine where agents run.
- OAuth tokens, if any, use read-only scopes (e.g. `gmail.readonly`).
- A browser extension, if built, reads the DOM only: no clicks, input events, or form submits.
- CI guard `scripts/guard_no_send` fails the build if send-capable APIs appear anywhere in the codebase, for example:
  `osascript`, `application "Messages"`, `gmail.send`, `gmail.compose`, `gmail.modify`, `nodemailer`, `smtplib`, `.click()`, `dispatchEvent(`, `.submit()`, `chrome.debugger`, `addResultsToIntent`, `sendTextMessage`.
  The guard is a backstop; the separate user account and read-only tokens are the real fence.
- **External queries are outbound.** A web search or external API query may contain only tokens that appear in public sources (e.g. an error string from a public library). Anything with private names, repo names, people, or internal flags is dropped or goes to the outbox for the owner.
- **Write-back goes only to gitignored sidecar files** (`<workspace>/.gadget/brief.md`). Never modify tracked files. Proposed source changes are patches in the review queue.
- **Recalled text is untrusted data.** Web pages and messages can contain prompt injections, and recall feeds coding agents that have a shell. Everything served over MCP or written to the brief is wrapped as quoted data with its source pointer, never as instructions.

## 5. Data model

Raw events, full-text search, mined episodes, outbox, verdicts. No graph.

```typescript
interface EpisodicEvent {
  eventId: string;                  // content-addressed (hash of source + offset + content)
  source: "zsh" | "chrome" | "codex_session" | "antigravity_session" | "git" | "clipboard";
  timestampMs: number;
  workspacePath?: string;
  contentText: string;              // indexed with SQLite FTS5
  sourceUri: string;                // file:line, session file#turn, commit sha, URL
  metadataJson: string;
}

interface SeekingEpisode {
  episodeId: string;
  contextEventIds: string[];        // events in the window before seeking began: the trigger
  seekStartMs: number;
  seekActions: Array<{
    kind: "WEB_SEARCH" | "GREP" | "GIT_ARCHAEOLOGY" | "HELP_LOOKUP" | "ASK_AGENT";
    query: string;
    eventId: string;
  }>;
  resolution?: {
    kind: "PASTE_FROM_SOURCE" | "COMMAND_SUCCEEDED" | "TEST_PASSED" | "WORK_RESUMED";
    sourceUri?: string;             // where the answer lived, when known
    answerSpan?: string;            // exact text, when it was a paste
    atMs: number;
  };
  costMs: number;                   // seekStart -> resolution
}
```

Events are append-only. Everything derived (episodes, indexes) can be rebuilt from events; store `minerVersion` on derived rows.

## 6. Triggers

### 6.1 The fixed definition (small, hand-written, does not grow)

We define what "looking for something" and "found it" look like. We do not define what causes it.

| Seek action | Detected from |
|---|---|
| `WEB_SEARCH` | Chrome `keyword_search_terms`; search-engine URLs with a query parameter |
| `GREP` | shell: `grep`, `rg`, `ag`, `ack`, `find`, `fd` |
| `GIT_ARCHAEOLOGY` | `git log -S/-G/--grep`, `git blame`, `git show <old sha>` |
| `HELP_LOOKUP` | `man`, `--help`, `tldr`; docs-site visits |
| `ASK_AGENT` | owner turns in Codex / Antigravity sessions that ask a question |

| Resolution | Detected from |
|---|---|
| `PASTE_FROM_SOURCE` | clipboard copy from a source, then paste into the workspace (forward capture only) |
| `COMMAND_SUCCEEDED` | exit code 0 after failures (zsh hook going forward; tool results in Codex sessions for backfill) |
| `TEST_PASSED` | test command exits 0 after failing |
| `WORK_RESUMED` | fallback: seeking stops, normal work resumes (weakest; backfill only) |

An episode is a run of seek actions separated by less than `SEEK_GAP` (default 5 min). Context is the `CONTEXT_WINDOW` (default 10 min) before the first seek action. Both live in config; report results at more than one value.

Everything else (when to fire, what to search for, which source to search) is learned from episodes.

### 6.2 Runtime components

```typescript
interface ContextWindow {
  endMs: number;
  eventIds: string[];
  workspacePath?: string;
}

interface Anticipator {
  // Cheap; runs on every new context window.
  score(ctx: ContextWindow): { pSeek: number; horizonMs: number };
  // LLM, only above threshold: "what is the owner about to look for?"
  propose(ctx: ContextWindow): Array<{ query: string; searchers: string[] }>;
}

interface Hit {
  quote: string;                    // verbatim from source
  sourceUri: string;
  eventId?: string;
  freshness: "CURRENT" | "SUPERSEDED" | "UNKNOWN";
  freshnessCheck: string;           // what was run, e.g. "git grep -- --jitless HEAD: 0 hits"
}

interface Searcher {
  id: string;                       // "fts_events" | "git_pickaxe" | "repo_grep" | "sessions" | "web"
  external: boolean;                // true => query leaves the machine; section 4 rules apply
  search(query: string, asOfMs: number): Promise<Hit[]>;  // asOfMs is mandatory, see section 8
}

interface Surfacer {
  // value = relevance x novelty x lead time - interruption cost
  decide(ctx: ContextWindow, hits: Hit[]): { action: "SURFACE" | "HOLD" | "SILENT"; reason: string };
}

interface WorkspaceSink {
  write(workspacePath: string, hits: Hit[], reason: string): Promise<void>;  // .gadget/brief.md, MCP
}
```

Rules:

- Searching is cheap and silent; surfacing costs the owner's attention. Guess often, surface rarely.
- **Novelty:** drop hits already on screen or in the current session.
- **Freshness:** before surfacing, re-check against current reality (grep HEAD for the flag, check for newer messages). Only `CURRENT` hits are pushed.
- **Surface a verbatim quote plus source pointer**, never a model-written answer.
- `Anticipator.score` starts as a zero-shot LLM call with its threshold calibrated on mined episodes. Later it is distilled into a small classifier trained on graded outputs, so it can run on every window at low cost.
- Which searcher to use is learned from episodes (which sources resolved which contexts). A new searcher is added only if replay shows it resolves episodes the existing ones missed.

## 7. Claim verification

Anything surfaced or written to the brief passes a deterministic check. No LLM in this path.

```typescript
interface Evidence {
  sourceEventId: string;
  quote: string;
  charStart: number;
  charEnd: number;
}

interface Claim {
  text: string;
  evidence: Evidence[];             // empty => cannot be surfaced
}

function verifyClaim(c: Claim, store: EventStore): { passed: boolean; failures: string[] };
// 1. every quote === event.contentText.slice(charStart, charEnd)
// 2. the source event exists and is older than the surfacing time
// 3. freshness check recorded for anything about code or current state
```

## 8. Replay harness: the only accepted evidence

- A fixture is either a mined episode from the owner's data (local, never committed) or a synthetic fixture (committed, used in CI).
- Run the pipeline on the context before `seekStartMs`, with `asOfMs = seekStartMs` for every searcher. **An evaluation without this cutoff is invalid**: the index would contain the answer from the future.
- Metrics, computed by the harness:

```text
hit rate          surfaced item matches where the owner actually found the answer
lead time         minutes before the owner started looking
false surfacing   surfacings with no seeking in the following horizon
answerable miss   answer existed locally, system stayed silent
lie rate          surfaced claims failing verifyClaim
```

- **Merge rule:** any change to prompts, models, features, or searchers needs a replay run attached to the PR, with no regression.
- Owner data never leaves the machine and is never committed. CI runs synthetic fixtures; the owner runs real replay locally and records the numbers.

## 9. Review queue

```typescript
type Verdict =
  | { kind: "GOOD" }
  | { kind: "WRONG_FACT"; note: string }          // fabricated or incorrect
  | { kind: "STALE"; note: string }               // already resolved
  | { kind: "SHOULD_STAY_SILENT"; note: string }
  | { kind: "MISSED"; note: string };             // owner was stuck, system said nothing
```

Every verdict other than `GOOD`:

1. becomes a locked fixture in `acceptance/` (trace window plus verdict) under the hash manifest;
2. opens a rework item that closes only when replay of that fixture passes and `verifyClaim` passes;
3. proposes a scoped rule, shown to the owner in one line.

## 10. Phases

### Phase 0: reset and measure (do this first)

1. Move old notes to `archive/untrusted-llm-notes/`. README line: "Nothing is built. Only items with a passing CI run count."
2. CI: `scripts/guard_no_send`, the `acceptance/` hash-manifest check, and `CODEOWNERS` naming the owner for `acceptance/`, `scripts/guard_*`, and `CODEOWNERS`.
3. Start forward capture now, so data accumulates:
   - zsh `preexec`/`precmd` hook appending cwd, command, exit code, and start/end time to a JSONL file;
   - clipboard logger (macOS pasteboard change-count polling) recording timestamp, frontmost app, and text.
4. History miner. Read-only, offline, no network calls:
   - zsh history: `EXTENDED_HISTORY` format `: <epoch>:<duration>;<cmd>`. Lines without timestamps are skipped and counted, never given guessed times.
   - Chrome `History` SQLite: copy the file first (locked while Chrome runs). Timestamps are microseconds since 1601-01-01 UTC. Tables: `urls`, `visits`, `keyword_search_terms`.
   - `~/.codex/sessions/**/*.jsonl`: formats vary by version. Unknown records are counted, not dropped silently.
   - `~/.gemini/antigravity/brain/*`: format unknown. Inspect real files and document the format before writing a parser.
   - git: reflog and log across configured repo roots.
5. Ceiling report (`report.md`):
   - per-source event counts and parse-failure counts;
   - episode count;
   - **repeat-seek rate:** episodes whose query matches an earlier episode or earlier content ("you looked for this before");
   - **local-hit rate:** FTS over data older than `seekStartMs` returns a hit containing the query's key tokens;
   - 25 random episodes with context excerpt, queries, and top local hit with pointer, for the owner to label Y/N ("the answer was in my data") in `labels.csv`.

Exit: the owner has labeled the 25. If fewer than 20 look like real seeking to the owner, fix detection before Phase 1. Record the numbers in `STATUS.md` with the commit sha.

This phase decides the product: a high ceiling means local recall is the product; a low one means the value is in web search and the plan changes.

### Phase 1: offline anticipation

- Replay harness with the `asOfMs` cutoff.
- Two baselines:
  - **upper bound:** search with the owner's actual query at seek start (cheats: it knows the query);
  - **realistic:** search using context only.
- Anticipator v0 (zero-shot) with searchers `fts_events`, `git_pickaxe`, `repo_grep`, `sessions`, and `web` (public-token filter).
- Exit: beats the realistic baseline on the owner's replay, with false surfacing measured and reported.

### Phase 2: live pull

- MCP server exposing `recall(query)` to the owner's coding sessions. Read-only. Logs every call and whether the result was used.
- Exit: one week of real use with logged usage.

### Phase 3: live push

- Surfacer writes to `.gadget/brief.md` (or a file the session's agent already loads). Review queue with verdicts is live.
- Turn on only when replay on two weeks of the owner's traces shows false surfacing and stale rates the owner accepts.

### Later, only with owner approval

Read-only phone capture APK; message threads as a searcher.

## 11. Known gaps

- The ceiling is unknown until Phase 0.
- Being stuck and giving up leaves no seeking trace. `MISSED` verdicts cover it for now.
- zsh history has no exit codes, so backfilled resolutions are weak. The forward hook fixes this going forward.
- The Antigravity transcript format is undocumented.

## 12. Corrections to earlier notes

Earlier LLM-written notes contain these errors. Do not reuse them.

- ProAgent (arXiv:2512.06721) does not describe ring buffers or "23 buffers". It reports up to 27.7% higher proactive prediction accuracy and 20.5% lower false detection. The ">80% indexing reduction" figure is unsourced.
- HippoRAG 2 uses Personalized PageRank, not "BM25 + 1-hop traversal". "<15 ms" was never measured.
- Mem0's operations are ADD / UPDATE / DELETE / NOOP; its graph variant marks edges invalid.
- OSWorld has no macOS guest (Ubuntu and Windows only), and its action space has no OPEN_URL or SHELL.
- OWASP LLM06:2025 is Excessive Agency. "Complete mediation" is a Saltzer and Schroeder principle.
- TomasuLLM (arXiv:2609.38201) is about out-of-order speculative tool execution in copy-on-write sandboxes, not sandbox fences.
- "245 local git repos", "30-day history": unsourced.

## 13. References in use

- **ProAgentBench** (arXiv:2602.04482): splits proactive assistance into timing prediction and content generation. Long-term memory improves prediction, and real-world data substantially outperforms synthetic. Used for: the Anticipator score/propose split, and replay on real data instead of a simulator.
- **ProAgent** (arXiv:2512.06721): tiered, on-demand sensing for proactive agents. Used for: a cheap score gating expensive LLM calls.
- **Remembrance Agent** (Rhodes, MIT Media Lab): continuous just-in-time retrieval from the user's current context. Prior art for the whole loop.
- **PrefEval** (arXiv:2502.09597): zero-shot preference following falls below 10% at 10 turns (~3k tokens). Used for: corrections stored as rules, not left in chat history.
- **Meta Agents Rule of Two** and **CaMeL** (arXiv:2503.18813): untrusted input must not control actions when private data and external communication are present. Used for: the no-send rule, the external query rule, and treating recalled text as data.
- **Anthropic, Claude Code auto mode**: users accept 93% of permission prompts; the classifier strips assistant text and tool outputs. Used for: no per-action approval prompts; owner review is asynchronous in the queue.
