# Running the history miner

Phase 0 of AGENTS.md: measure how often the answer to something you went looking for was already in your own data. Everything runs on your machine, reads your files without changing them, and makes no network calls (CI enforces the last part with `scripts/guard_no_send.mjs`).

Needs Node 22.13 or newer (`node --version`).

## 1. Start the zsh capture hook (once)

Add to `~/.zshrc`:

```bash
source /path/to/gadget/capture/zsh/gadget.zsh
setopt EXTENDED_HISTORY
```

The hook writes one JSON line per command (with exit code and cwd) to `~/.gadget/capture/zsh.jsonl`, mode 600. `EXTENDED_HISTORY` makes future history lines carry timestamps; older lines without one are skipped, never guessed. Commands that start with a space are not recorded.

## 2. Look at the structure of your agent transcripts

```bash
npm ci
npm run mine -- probe
```

Prints record types, key names, and counts for `~/.codex/sessions` and `~/.gemini/antigravity/brain`. No content; undocumented string values and UUID keys are redacted.

## 3. Ingest and report

```bash
npm run mine -- ingest
npm run mine -- report
```

`ingest` rebuilds `~/.gadget/miner.db` from zsh history, the zsh hook log, Chrome-family browser history (copied before reading; search queries become `WEB_SEARCH` and documentation visits become `HELP_LOOKUP`), Codex sessions (`~/.codex/sessions/**/*.jsonl`, including user turns, assistant turns, and `CommandExecution` / `exec_command` tool exit codes), Antigravity transcripts (`~/.gemini/antigravity/brain/<convId>/.system_generated/logs/transcript_full.jsonl`, including `USER_INPUT`, `PLANNER_RESPONSE`, and `run_command` tool exit codes), and `git log` of repos under your home directory (depth 4). It prints, per source, how many records it read, kept, skipped (with reasons), and did not recognize.

`report` writes `~/.gadget/reports/<timestamp>/report.md` and `labels.csv`, outside the repo (it refuses to write inside it). The summary printed to the terminal has counts and rates only.

## 4. Offline replay and MCP recall server

```bash
npm run mine -- replay
npm run mine -- mcp
```

`replay` evaluates the upper-bound oracle, the realistic context-only baseline, and `CalibratedAnticipator` across all mined episodes with a strict `asOfMs = seekStartMs` cutoff and deterministic `verifyClaim` checks.

`mcp` starts the read-only JSON-RPC 2.0 MCP server on stdio exposing `recall(query)` and logging tool calls to `~/.gadget/mcp_calls.jsonl`.

Overrides go in `~/.gadget/config.json`, for example:

```json
{ "gitRoots": ["/Users/me/code"], "gitMaxDepth": 3, "sampleSize": 25, "seed": 7 }
```

## 5. Label the sample

Open `report.md`, then fill in `labels.csv` for the 25 sampled episodes: was it real seeking (Y/N), and was the answer already in your data (Y/N). If fewer than 20 look like real seeking, seek detection gets fixed before anything else.

## Try it on fake data first

```bash
npm run build
HOME=$(node --disable-warning=ExperimentalWarning -e 'import("./dist/test/fixtures/fake_home.js").then(m => console.log(m.fakeHome()))') sh -c '
  node --disable-warning=ExperimentalWarning dist/src/miner/cli.js ingest &&
  node --disable-warning=ExperimentalWarning dist/src/miner/cli.js report'
```
