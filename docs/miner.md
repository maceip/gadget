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

Prints record types, key names, and counts for `~/.codex/sessions` and `~/.gemini/antigravity/brain`. No content. Paste it back so the Codex parser can be checked and an Antigravity parser written against your real files.

## 3. Ingest and report

```bash
npm run mine -- ingest
npm run mine -- report
```

`ingest` rebuilds `~/.gadget/miner.db` from zsh history, the zsh hook log, Chrome-family browser history (copied before reading), Codex sessions, and `git log` of repos under your home directory (depth 4). It prints, per source, how many records it read, kept, skipped (with reasons), and did not recognize.

`report` writes `~/.gadget/reports/<timestamp>/report.md` and `labels.csv`, outside the repo (it refuses to write inside it). The summary printed to the terminal has counts and rates only.

Overrides go in `~/.gadget/config.json`, for example:

```json
{ "gitRoots": ["/Users/me/code"], "gitMaxDepth": 3, "sampleSize": 25, "seed": 7 }
```

## 4. Label the sample

Open `report.md`, then fill in `labels.csv` for the 25 sampled episodes: was it real seeking (Y/N), and was the answer already in your data (Y/N). If fewer than 20 look like real seeking, seek detection gets fixed before anything else.

## Try it on fake data first

```bash
npm run build
HOME=$(node --disable-warning=ExperimentalWarning -e 'import("./dist/test/fixtures/fake_home.js").then(m => console.log(m.fakeHome()))') sh -c '
  node --disable-warning=ExperimentalWarning dist/src/miner/cli.js ingest &&
  node --disable-warning=ExperimentalWarning dist/src/miner/cli.js report'
```
