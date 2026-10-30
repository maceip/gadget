# AGENTS.md — Declarative Architecture, Scope Fence & Anti-Deceit Laws

> **READ THIS FIRST.** Every rule in this file exists because a past agent broke it—by faking completion in 3.5 minutes, hardcoding demo strings (`"Dr. Chen"`, `"Sarah"`, `if (query.includes("webview"))`), writing tests that passed while the UI rendered a `6px` 1-character-wide column, testing the wrong target folder, inventing fake arXiv papers, or handing the owner clerical CSV homework. Violating any rule in this file invalidates your work.

---

## 1. Tightened Project Scope (What We Build vs. What Is Forbidden)

`gogogadget` has **one job**: capture human utterances and ambient context, resolve the relevant people/modalities/schedule/history from real local SQLite data, and surface **at most 1–3 verified, actionable nuggets** in a de minimis 2-row Skypanel HUD and `.gadget/brief.md` so the human or an agent can execute with one click.

### Strictly In Scope (The 4-Stage Functional Spine Only)
1. **Stage 1 — Local Sensory & History Capture (`src/media/`, `src/miner/`):**
   - Local mic (`ffmpeg` + `/opt/homebrew/bin/whisper-cli` with `~/Documents/ggml-base.en.bin`), Screen Vision OCR (`macos_sensory.swift`), concealed-safe Clipboard, Keyboard focus/bursts, Zsh hook (`gadget.zsh`), Chrome history/capture, Git reflog/commits, Codex/Antigravity session logs, Android SMS/notification bridge (`~/.gadget/capture/android.jsonl`), and read-only macOS Messages/Calendar snapshots.
2. **Stage 2 — Dual Trigger Gatekeeper (`src/triggers/`):**
   - **Path A (Explicit Utterance):** `"Hey Gadget"` (alone) + human-safe prefixes (`"Note to self"`, `"Mental note"`, `"FYI"`, `"PSA"`, `"Remind me"`, `"Bookmark"`, `"Lock it in"`, `"VIP"`, `"ASAP"`, `"ADR"`, `"TBC"`) slotted across Cosmo's 13 Conformer + 6 Regex heads, stapled to the concurrent screen/window/clipboard snapshot.
   - **Path B (Proactive Anticipator):** `CalibratedAnticipator` scoring live context windows (`zsh_hook` failures, window switches, active repo) using empirical statistics from `EventStore`.
3. **Stage 3 — Proactive Engine & Deterministic Verification (`src/runtime/`):**
   - Dynamic entity/contact, source/target modality icon, working-hours, and conflict-free calendar slot resolution from real SQLite events.
   - Multi-searcher recall (`FtsEventsSearcher`, `GitPickaxeSearcher`, `RepoGrepSearcher`, `SessionsSearcher`) gated by `VerifiedSurfacer` (max 1–3 cards) and deterministic `verifyClaim(asOfMs)`.
4. **Stage 4 — De Minimis 2-Row Skypanel Surface & Dual-Mode Execution (`src/web/`, `src/mcp/`, `src/runtime/action_agent.ts`):**
   ```text
   [ {source modality icons}   <2–5 word nugget label>   {target app icons} ]
   [                {revise}   {mode: app | agent}       {go go gadget}     ]
   ```
   - Routed only to the single surface Ryan is actively using (`desktop`, `browser`, or `mobile`).
   - `{revise}` recomposes the card in SQLite from natural-language feedback.
   - `{go go gadget}` executes the card's selected mode:
     - **Mode 1 (`app` — Native App / Draft Launch):** Stages and opens/copies the concrete `.ics` calendar invite, reply draft, or task file in `~/.gadget/staged/` and `.gadget/brief.md`.
     - **Mode 2 (`agent` — Scoped Action Agent):** Runs `ActionAgent` over the card's verified brief + local searchers and attaches the verified execution receipt back to the card in SQLite.

### Strictly Out of Scope (Forbidden Bloat)
- **NO** multi-pane manual data-labeling dashboards or clerical CSV grading forms (`labels.csv` homework).
- **NO** standalone academic paper ports, graph databases, or uncalled research experiments sitting in `src/`.
- **NO** cloud LLM dependencies, external network calls in `src/miner/` or `capture/`, or autonomous outbound message sending.

---

## 2. Absolute Ban on Mocking, Hardcoding, and Fake App Code (`scripts/guard_no_fake_or_mock.mjs`)

**Mocking, hardcoding demo values, or shipping stub/placeholder logic in `src/` is illegal.**

1. **Zero Hardcoded Entities, Contacts, Queries, or Canned Outputs in `src/`:**
   - **Never** hardcode example names (`"Nikesh"`, `"Dr. Chen"`, `"Sarah"`, `"Alex"`), phone numbers (`"555-"`), fake window titles, canned replies, or keyword boosts (`if (query.includes("webview"))`) anywhere inside `src/`.
   - Every contact name, modality icon, working-hour window, proposed time slot, and recall quote rendered by `src/` **must** be computed dynamically from the actual input utterance and real rows in `EventStore`.
2. **Zero Mocks, Stubs, Placeholders, or Dead Controls in App Code:**
   - **Never** write `mock`, `stub`, `fake`, ` dummy`, `placeholder`, `TODO`, or `not implemented` inside `src/`.
   - **Never** wire a UI button, mode switch (`app` vs `agent`), `{revise}` input, or `{go go gadget}` trigger to a no-op, `console.log`, or client-only state variable. Every control must mutate and read back real SQLite rows in `EventStore`.
3. **Zero Fake Machine Learning / Fake Heuristics:**
   - Do not claim a model or scorer is "calibrated" or "learned" if it is a hardcoded constant table. Any score or working-hour inference must be computed from actual event distributions in SQLite (with documented mathematical formulas).

---

## 3. Clean Repository Structure (`gogogadget`)

Every file in the repository must belong to one of these directories along the functional spine:

```text
gogogadget/
├── AGENTS.md                        # This charter
├── package.json                     # Zero external runtime dependencies; Node >= 22.13 (node:sqlite)
├── tsconfig.json
├── capture/
│   └── zsh/gadget.zsh               # Zero-fork zsh preexec/precmd hook
├── scripts/
│   ├── guard_no_send.mjs            # Blocks outbound send APIs & unauthorized network calls
│   ├── guard_no_fake_or_mock.mjs    # Blocks hardcoded demo names, mocks, stubs, and TODOs in src/
│   └── guard_acceptance_manifest.mjs
├── src/
│   ├── media/                       # Stage 1a: Native macOS Sensory & Audio I/O
│   │   ├── macos_sensory.swift      # Vision OCR, Pasteboard (concealed-safe), AX Focus, CGEvent tap
│   │   ├── native_helper.ts         # Compiles & runs kernel-sandboxed GadgetSensoryCapture.app
│   │   ├── audio_recorder.ts        # AVFoundation mic capture
│   │   ├── stt.ts                   # Local whisper-cli Metal speech-to-text
│   │   ├── tts.ts                   # Local /usr/bin/say synthesis
│   │   ├── screen.ts                # Screen capture + Vision OCR
│   │   ├── clipboard.ts             # Concealed-safe clipboard capture
│   │   └── keyboard.ts              # Focused text & burst key watcher
│   ├── miner/                       # Stage 1b: Episodic EventStore & Local Source Parsers
│   │   ├── store.ts                 # SQLite WAL store (events, events_fts, spoken_slots, skypanel_cards)
│   │   ├── ingest.ts                # Incremental & batch ingestion
│   │   ├── parsers/                 # zsh, chrome, codex, antigravity, git, clipboard, sensory, messages_calendar
│   │   ├── seek.ts, episodes.ts, ceiling.ts, shell.ts, config.ts, event.ts, paths.ts, types.ts
│   │   └── cli.ts                   # Unified CLI entrypoint
│   ├── triggers/                    # Stage 2: Utterance & Activity Triggers + Skypanel Composer
│   │   ├── cosmo_spoken_slots.ts    # "Hey Gadget" + human-safe prefixes + Cosmo 13/19-head slotter
│   │   ├── skypanel_composer.ts     # Dynamic contact/modality/working-hours resolver + 2-row card composer
│   │   ├── spine.ts                 # Connected spine: Utterance/Context -> Trigger -> Engine -> Skypanel
│   │   ├── desktop_activity_commitments.ts
│   │   └── governed_loop_cadence.ts
│   ├── runtime/                     # Stage 3: Proactive Recall Engine, Verification, Action Agent & Daemon
│   │   ├── anticipator.ts           # CalibratedAnticipator
│   │   ├── searchers.ts             # FtsEventsSearcher, GitPickaxeSearcher, RepoGrepSearcher, SessionsSearcher
│   │   ├── surfacer.ts              # VerifiedSurfacer (novelty, freshness, interruption budget <= 3 cards)
│   │   ├── verify.ts                # Deterministic verifyClaim(asOfMs)
│   │   ├── sink.ts                  # Writes verified <workspace>/.gadget/brief.md
│   │   ├── action_agent.ts          # Mode 2 Scoped Go-Go-Gadget Action Agent runner & receipt recorder
│   │   └── daemon.ts                # Continuous AmbientCatalogDaemon loop
│   ├── mcp/                         # Stage 4a: Agent Pull Surface
│   │   └── server.ts                # Read-only stdio MCP server (recall, list_skypanel_cards, mark_recall_used)
│   └── web/                         # Stage 4b: De Minimis Skypanel HUD Surface
│       ├── skypanel_ui.ts           # 2-row Skypanel HUD (Desktop HUD, Browser Overlay, Mobile Sheet)
│       ├── server.ts                # Loopback server (127.0.0.1:4321) with Skypanel + capture endpoints
│       └── cli.ts
└── test/                            # End-to-End Spine, Guard & Playwright Geometry Suite
```

---

## 4. Anti-Shitty-Test & Verification Laws

A test is **worthless** if it passes while the real user workflow or UI is broken.

1. **Test the Connected Spine, Never Disconnected Helpers:**
   - Every feature must be tested through the actual connected spine (`EventStore` $\to$ `runFunctionalSpine` / HTTP API $\to$ persisted `skypanel_cards` & `.gadget/brief.md` $\to$ `{revise}` & `{go go gadget}` Mode 1 and Mode 2 execution).
   - Testing a mocked function in isolation while the server or daemon never calls it is a violation of this charter.
2. **Real Visual & Geometry Assertions for UI (No `6px` Column Collapses):**
   - Ban `table-layout: fixed` multi-column tables inside narrow containers.
   - Every Playwright test must assert real rendered bounding boxes (`getBoundingClientRect().width >= 200` on card/text containers, non-overlapping buttons, visible Row 1 icons/label and Row 2 `{revise}`, `{mode: app | agent}`, and `{go go gadget}` controls) across Desktop (`1280×800`) and Mobile (`390×844`) viewports, and save real screenshots inspected via `read_file`.
3. **Never Weaken a Failing Test:**
   - When a test fails or times out, fix the bug in the application code—never delete the assertion, widen a tolerance to pass broken output, or rename a label to dodge a layout collision.
4. **Verify Target & Obey `STOP` Immediately:**
   - Always check `pwd`, `git remote -v`, and `git diff --stat` before testing or committing.
   - When the user says `hold`, `stop`, or `just commit`, stop all extra work immediately.
5. **"Done" Requires Verbatim Proof:**
   - `npm test`, `node scripts/guard_no_send.mjs`, `node scripts/guard_no_fake_or_mock.mjs`, and `node scripts/guard_acceptance_manifest.mjs` must all exit `0`, followed by `git commit`, `git push`, and reporting the verbatim commit SHA and test output.
