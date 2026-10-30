import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RecallMcpServer } from "../src/mcp/server.js";
import { defaultConfig } from "../src/miner/config.js";
import { buildEpisodes, commandKey } from "../src/miner/episodes.js";
import { makeEvent } from "../src/miner/event.js";
import { ingest } from "../src/miner/ingest.js";
import { findAntigravityTranscripts, parseAntigravityTranscript } from "../src/miner/parsers/antigravity.js";
import { parseCodexSession } from "../src/miner/parsers/codex.js";
import { signature } from "../src/miner/probe.js";
import { writeReport } from "../src/miner/report.js";
import { classifyEvent, classifyEventAll, docsSiteQuery, withSeeks } from "../src/miner/seek.js";
import { EventStore } from "../src/miner/store.js";
import { emptyCounts } from "../src/miner/types.js";
import { CalibratedAnticipator } from "../src/runtime/anticipator.js";
import { formatReplayTable, runReplay } from "../src/runtime/replay.js";
import { proposeScopedRule, ReviewQueue } from "../src/runtime/review.js";
import {
  filterOutboundQuery,
  FtsEventsSearcher,
  GitPickaxeSearcher,
  RepoGrepSearcher,
  SessionsSearcher,
  WebPublicSearcher,
} from "../src/runtime/searchers.js";
import { BriefWorkspaceSink } from "../src/runtime/sink.js";
import { VerifiedSurfacer } from "../src/runtime/surfacer.js";
import { hitToClaim, verifyClaim } from "../src/runtime/verify.js";
import { evaluateCeiling } from "../src/miner/ceiling.js";
import { startWorkbenchServer } from "../src/web/server.js";
import { fakeHome } from "./fixtures/fake_home.js";
import { DAY, ev, MIN, stored, T0, tmp } from "./helpers.js";

const params = defaultConfig("/nonexistent");

test("review fixes: probe redacts undocumented enum values and UUID keys", () => {
  const sig = signature({
    type: "secret_project_alpha",
    role: "custom_owner_name",
    "bd3bc97c-e274-42c5-8ce6-268c05e55094": 1,
    payload: {
      type: "internal_tool_name",
      role: "private_role",
      content: [{ type: "secret_block_type", text: "hidden" }],
    },
  });
  assert.doesNotMatch(sig, /secret_project_alpha|custom_owner_name|internal_tool_name|private_role|secret_block_type|bd3bc97c/);
  assert.match(sig, /type=string/);
  assert.match(sig, /payload\.type=string/);
  assert.match(sig, /payload\.role=string/);
  assert.match(sig, /payload\.content\[\]\.type=\{string\}/);
});

test("review fixes: commandKey skips option values so monorepo workspace flags do not collide", () => {
  const mk = (cmd: string) =>
    stored(
      makeEvent({
        source: "zsh_hook",
        timestampMs: T0,
        workspacePath: "/w/mono",
        contentText: cmd,
        sourceUri: "hook:1",
        metadataJson: JSON.stringify({ exit: 1, end_ms: T0 + 100 }),
      }),
    );

  assert.notEqual(commandKey(mk("npm --workspace api test")), commandKey(mk("npm --workspace api install")));
  assert.equal(commandKey(mk("npm --workspace api test")), commandKey(mk("npm -w api test")));
  assert.equal(commandKey(mk("npm --workspace api test")), commandKey(mk("npm test")));
  assert.notEqual(commandKey(mk("npm run build")), commandKey(mk("npm run lint")));
  assert.notEqual(commandKey(mk("cargo --manifest-path a/Cargo.toml test")), commandKey(mk("cargo --manifest-path a/Cargo.toml build")));
});

test("review fixes: command substitutions inside words and double quotes are classified, single quotes are not", () => {
  assert.deepEqual(classifyEventAll(ev("zsh", T0, "matches=$(rg needle src/)")), [
    { kind: "GREP", query: "needle" },
  ]);
  assert.deepEqual(classifyEventAll(ev("zsh", T0, 'echo "$(git log -Sflag)"')), [
    { kind: "GIT_ARCHAEOLOGY", query: "flag" },
  ]);
  assert.deepEqual(classifyEventAll(ev("zsh", T0, "out=`fd config`")), [
    { kind: "GREP", query: "config" },
  ]);
  assert.deepEqual(classifyEventAll(ev("zsh", T0, "echo '$(rg literal_only)'")), []);
});

test("review fixes: writeReport removes report.md if creating labels.csv fails", () => {
  const dir = tmp();
  // Pre-plant labels.csv so report.md succeeds and labels.csv throws EEXIST.
  writeFileSync(join(dir, "labels.csv"), "existing\n");
  const store = new EventStore(join(tmp(), "e.db"));
  const input = {
    cfg: params,
    counts: [{ source: "zsh", label: "/h", counts: emptyCounts() }],
    events: [],
    episodes: [],
    ceiling: evaluateCeiling([], store),
    generatedAt: new Date(T0),
  };
  assert.throws(() => writeReport(input, dir), /EEXIST/);
  assert.equal(existsSync(join(dir, "report.md")), false, "report.md should be rolled back when labels.csv fails");
  store.close();
});

test("docs-site visits classify as HELP_LOOKUP; blog and root visits do not", () => {
  assert.equal(docsSiteQuery("https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map", "Map - JavaScript\nhttps://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map"), "Map - JavaScript");
  assert.equal(docsSiteQuery("https://docs.rs/tokio/latest/tokio/sync/index.html", "https://docs.rs/tokio/latest/tokio/sync/index.html"), "sync index");
  assert.equal(docsSiteQuery("https://v8.dev/blog/jitless", "Lite mode and --jitless"), null);
  assert.equal(docsSiteQuery("https://v8.dev/", "V8"), null);

  const docVisit = makeEvent({
    source: "chrome",
    timestampMs: T0,
    contentText: "node:sqlite documentation\nhttps://nodejs.org/docs/latest/api/sqlite.html",
    sourceUri: "https://nodejs.org/docs/latest/api/sqlite.html",
    metadataJson: JSON.stringify({ kind: "visit" }),
  });
  assert.deepEqual(classifyEvent(docVisit), {
    kind: "HELP_LOOKUP",
    query: "node:sqlite documentation",
  });
});

test("antigravity parser: parses USER_INPUT, PLANNER_RESPONSE, and run_command tool executions with exit codes", () => {
  const brain = tmp();
  const logsDir = join(brain, "conv-1", ".system_generated", "logs");
  const chunksDir = join(logsDir, "chunks", "transcript_full");
  mkdirSync(chunksDir, { recursive: true });

  const steps = [
    {
      step_index: 0,
      type: "USER_INPUT",
      source: "USER_EXPLICIT",
      status: "DONE",
      created_at: new Date(T0).toISOString(),
      content: "<USER_REQUEST>\nhow do I pass --wasm-tier-up=false?\n</USER_REQUEST>",
    },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      status: "DONE",
      created_at: new Date(T0 + 1000).toISOString(),
      tool_calls: [{ name: "run_command", args: { CommandLine: "npm test", Cwd: "/w/vitre" } }],
    },
    {
      step_index: 2,
      type: "GENERIC",
      source: "MODEL",
      status: "DONE",
      created_at: new Date(T0 + 2000).toISOString(),
      content: `Created At: ${new Date(T0 + 1000).toISOString()}\nCompleted At: ${new Date(T0 + 2000).toISOString()}\nCommand exited with code 1.\n`,
    },
    {
      step_index: 3,
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      status: "DONE",
      created_at: new Date(T0 + 3000).toISOString(),
      content: "Pass --wasm-tier-up=false in NODE_OPTIONS.",
      tool_calls: [{ name: "run_command", args: { CommandLine: "npm test", Cwd: "/w/vitre" } }],
    },
    {
      step_index: 4,
      type: "GENERIC",
      source: "MODEL",
      status: "DONE",
      created_at: new Date(T0 + 4000).toISOString(),
      content: `Created At: ${new Date(T0 + 3000).toISOString()}\nCompleted At: ${new Date(T0 + 4000).toISOString()}\nCommand exited with code 0.\n`,
    },
  ];
  const jsonl = steps.map((s) => JSON.stringify(s)).join("\n") + "\n";
  writeFileSync(join(logsDir, "transcript_full.jsonl"), jsonl);
  writeFileSync(join(logsDir, "transcript.jsonl"), jsonl);
  writeFileSync(join(chunksDir, "00000000.jsonl"), jsonl);

  const found = findAntigravityTranscripts(brain);
  assert.deepEqual(found, [join(logsDir, "transcript_full.jsonl")]);

  const parsed = parseAntigravityTranscript(jsonl, found[0]!);
  assert.equal(parsed.counts.read, 5);
  assert.equal(parsed.counts.parsed, 4); // user turn + failed tool cmd + assistant turn + passed tool cmd
  assert.ok(parsed.events.every((e) => e.workspacePath === "/w/vitre"), "workspacePath should be backfilled across the conversation");

  const eps = buildEpisodes(parsed.events.map(stored), params);
  assert.equal(eps.length, 1);
  assert.equal(eps[0]!.seekActions[0]!.kind, "ASK_AGENT");
  assert.equal(eps[0]!.resolution?.kind, "TEST_PASSED");
});

test("codex parser: parses CommandExecution and exec_command tool outputs for resolution matching", () => {
  const lines = [
    { timestamp: new Date(T0).toISOString(), type: "turn_context", payload: { cwd: "/w/vitre" } },
    {
      timestamp: new Date(T0 + 1000).toISOString(),
      type: "event_msg",
      payload: {
        type: "item_completed",
        started_at_ms: T0 + 1000,
        completed_at_ms: T0 + 2000,
        item: { type: "CommandExecution", command: ["/bin/zsh", "-lc", "npm test"], cwd: "/w/vitre", exit_code: 1 },
      },
    },
    {
      timestamp: new Date(T0 + 3000).toISOString(),
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "why is npm test failing?" }] },
    },
    {
      timestamp: new Date(T0 + 4000).toISOString(),
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "c1",
        arguments: JSON.stringify({ cmd: "npm test", workdir: "/w/vitre" }),
      },
    },
    {
      timestamp: new Date(T0 + 5000).toISOString(),
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "c1",
        output: "Chunk ID: 1\nProcess exited with code 0\nOutput:\nPASS\n",
      },
    },
  ]
    .map((o) => JSON.stringify(o))
    .join("\n");

  const r = parseCodexSession(lines, "/c/s.jsonl");
  assert.equal(r.counts.parsed, 3);
  const eps = buildEpisodes(r.events.map(stored), params);
  assert.equal(eps.length, 1);
  assert.equal(eps[0]!.resolution?.kind, "TEST_PASSED");
  assert.equal(eps[0]!.resolution?.atMs, T0 + 5000);
});

test("runtime verifyClaim: enforces exact span equality, strict timestamp cutoff, and CURRENT freshness", () => {
  const store = new EventStore(join(tmp(), "v.db"));
  const commitEv = makeEvent({
    source: "git",
    timestampMs: T0 - DAY,
    workspacePath: "/w/vitre",
    contentText: "Drop --jitless; use --wasm-tier-up=false",
    sourceUri: "git:/w/vitre@abcd",
    metadataJson: "{}",
  });
  store.insert(withSeeks([commitEv]));

  const goodClaim = {
    text: "use --wasm-tier-up=false",
    evidence: [
      {
        sourceEventId: commitEv.eventId,
        quote: "use --wasm-tier-up=false",
        charStart: 16,
        charEnd: 40,
      },
    ],
  };
  const freshMap = new Map([
    [commitEv.eventId, { freshness: "CURRENT" as const, freshnessCheck: "git grep -- --jitless HEAD: 0 hits" }],
  ]);

  assert.deepEqual(verifyClaim(goodClaim, store, { asOfMs: T0, freshnessByEventId: freshMap }), {
    passed: true,
    failures: [],
  });

  // Empty evidence fails.
  assert.equal(verifyClaim({ text: "x", evidence: [] }, store, { asOfMs: T0 }).passed, false);

  // Altered quote fails.
  const fabricated = {
    text: "use --wasm-tier-up=true",
    evidence: [{ sourceEventId: commitEv.eventId, quote: "use --wasm-tier-up=true", charStart: 16, charEnd: 40 }],
  };
  assert.equal(verifyClaim(fabricated, store, { asOfMs: T0, freshnessByEventId: freshMap }).passed, false);

  // Future event (at or after asOfMs) fails.
  assert.equal(
    verifyClaim(goodClaim, store, { asOfMs: T0 - DAY, freshnessByEventId: freshMap }).passed,
    false,
  );

  // Superseded freshness fails.
  const staleMap = new Map([
    [commitEv.eventId, { freshness: "SUPERSEDED" as const, freshnessCheck: "superseded by newer commit" }],
  ]);
  assert.equal(verifyClaim(goodClaim, store, { asOfMs: T0, freshnessByEventId: staleMap }).passed, false);

  store.close();
});

test("runtime searchers: enforce asOfMs cutoff, repo_grep historical commit lookup, and outbound web filter + outbox", async () => {
  const home = fakeHome();
  const cfg = {
    ...defaultConfig(home),
    chromiumRoots: [join(home, "chrome")],
    gitRoots: [join(home, "code")],
  };
  ingest(cfg);
  const store = new EventStore(cfg.dbPath, { readOnly: true });
  const repoPath = join(home, "code", "vitre");

  const fts = new FtsEventsSearcher(store, repoPath);
  const git = new GitPickaxeSearcher(store, repoPath);
  const sessions = new SessionsSearcher(store, repoPath);
  const repoGrep = new RepoGrepSearcher(store, repoPath);

  // Missing/invalid asOfMs throws.
  await assert.rejects(() => fts.search("jitless", NaN), /asOfMs/);

  // Before the commit existed (T0 - 40 * DAY), nothing matches.
  assert.equal((await fts.search("jitless", T0 - 40 * DAY)).length, 0);

  // At T0, both the commit (30 days ago) and the Codex session (11 days ago) match.
  const ftsHits = await fts.search("jitless", T0);
  assert.ok(ftsHits.length >= 2);
  for (const h of ftsHits) {
    const { claim, freshnessByEventId } = hitToClaim(h, store);
    assert.equal(verifyClaim(claim, store, { asOfMs: T0, freshnessByEventId }).passed, true);
  }

  const gitHits = await git.search("jitless", T0);
  assert.equal(gitHits.length, 1);
  assert.match(gitHits[0]!.quote, /--wasm-tier-up=false/);

  const sessionHits = await sessions.search("jitless", T0);
  assert.equal(sessionHits.length, 1);
  assert.match(sessionHits[0]!.quote, /--wasm-tier-up=false/);

  const grepHits = await repoGrep.search("x", T0);
  assert.equal(grepHits.length, 1);
  assert.match(grepHits[0]!.sourceUri, /build\.ts:1$/);

  // Outbound web searcher: blocks private tokens and logs to outbox; allows public tokens.
  const outboxPath = join(tmp(), "outbox.jsonl");
  const policy = {
    publicTokens: new Set(["v8", "jitless", "wasm", "tier", "up", "error"]),
    privateTokens: new Set(["vitre", "maceip"]),
    outboxPath,
  };
  const web = new WebPublicSearcher(policy, async (q) => [
    {
      quote: `Public doc for ${q}`,
      sourceUri: "https://v8.dev/docs/wasm",
      freshness: "CURRENT",
      freshnessCheck: "fetched at cutoff",
    },
  ]);

  const blocked = await web.search("vitre /Users/mac/secret v8 jitless", T0);
  assert.equal(blocked.length, 0);
  const outboxLines = readFileSync(outboxPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(outboxLines.length, 1);
  assert.deepEqual(outboxLines[0].droppedTokens, ["vitre", "/Users/mac/secret"]);
  assert.equal(statSync(outboxPath).mode & 0o777, 0o600);

  const allowed = await web.search("v8 jitless", T0);
  assert.equal(allowed.length, 1);

  store.close();
});

test("runtime replay, sink, review queue, and MCP recall server end-to-end on fakeHome", async () => {
  const home = fakeHome();
  const cfg = {
    ...defaultConfig(home),
    chromiumRoots: [join(home, "chrome")],
    gitRoots: [join(home, "code")],
  };
  ingest(cfg);
  const store = new EventStore(cfg.dbPath, { readOnly: true });

  const events = store.allEventsSorted();
  const episodes = buildEpisodes(events, cfg);
  const replay = await runReplay(episodes, store, { workspacePath: join(home, "code", "vitre") });

  // Anticipator v0 must beat the realistic baseline and have 0 lies.
  assert.ok(
    replay.anticipator.hits > replay.realistic.hits,
    `expected anticipator (${replay.anticipator.hits}) > realistic (${replay.realistic.hits}):\n${formatReplayTable(replay)}`,
  );
  assert.equal(replay.anticipator.lies, 0);
  assert.equal(replay.upperBound.lies, 0);

  // Surfacer + BriefWorkspaceSink: writes .gadget/brief.md and refuses tracked files.
  const ws = join(home, "code", "vitre");
  const sink = new BriefWorkspaceSink(store, () => T0);
  const fts = new FtsEventsSearcher(store, ws);
  const hits = await fts.search("jitless", T0);
  const surfacer = new VerifiedSurfacer(store);
  const ctx = { endMs: T0, eventIds: [], workspacePath: ws };
  const decision = surfacer.decide(ctx, hits);
  assert.equal(decision.action, "SURFACE");

  await sink.write(ws, hits, decision.reason);
  const briefPath = join(ws, ".gadget", "brief.md");
  assert.ok(existsSync(briefPath));
  assert.equal(statSync(briefPath).mode & 0o777, 0o600);
  const briefText = readFileSync(briefPath, "utf8");
  assert.match(briefText, /SECURITY NOTICE/);
  assert.match(briefText, /```untrusted-quote/);
  assert.match(briefText, /--wasm-tier-up=false/);

  // Novelty: if the source event is already in ctx.eventIds, surfacer stays SILENT.
  const nonNovelCtx = { endMs: T0, eventIds: hits.map((h) => h.eventId!).filter(Boolean), workspacePath: ws };
  assert.equal(surfacer.decide(nonNovelCtx, hits).action, "SILENT");

  // Tracked file protection: if someone tracks .gadget/brief.md in git, sink refuses to write it.
  const trackedRepo = join(tmp(), "tracked-repo");
  mkdirSync(join(trackedRepo, ".gadget"), { recursive: true });
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  execFileSync("git", ["init", "-q", trackedRepo], { env: gitEnv });
  writeFileSync(join(trackedRepo, ".gadget", "brief.md"), "tracked\n");
  execFileSync("git", ["-C", trackedRepo, "add", "-f", ".gadget/brief.md"], { env: gitEnv });
  await assert.rejects(() => sink.write(trackedRepo, hits, "test"), /refusing to modify git-tracked file/);

  // ReviewQueue: non-GOOD verdict creates locked fixture, open rework item, and 1-line rule.
  const reviewPath = join(tmp(), "review.json");
  const queue = new ReviewQueue(reviewPath);
  const rec = queue.recordVerdict(ctx, hits, { kind: "STALE", note: "flag was already migrated\nsecond line" }, T0);
  assert.ok(rec.fixture);
  assert.equal(rec.rework?.status, "OPEN");
  assert.ok(rec.proposedRuleOneLine && !rec.proposedRuleOneLine.includes("\n"));
  assert.equal(proposeScopedRule(ctx, hits, { kind: "GOOD" }), "");

  // Cannot close rework if replayPassed is false.
  const { claim, freshnessByEventId } = hitToClaim(hits[0]!, store);
  assert.equal(
    queue.closeRework(rec.rework!.reworkId, {
      replayPassed: false,
      claim,
      store,
      verifyOpts: { asOfMs: T0, freshnessByEventId },
    }).closed,
    false,
  );
  // Closes when replayPassed is true and verifyClaim passes.
  assert.equal(
    queue.closeRework(rec.rework!.reworkId, {
      replayPassed: true,
      claim,
      store,
      verifyOpts: { asOfMs: T0, freshnessByEventId },
    }).closed,
    true,
  );
  assert.equal(queue.openReworkItems().length, 0);

  // MCP Server: initialize, tools/list, tools/call recall(query), and usage logging.
  const mcpLogPath = join(tmp(), "mcp_calls.jsonl");
  const mcp = new RecallMcpServer(store, { logPath: mcpLogPath, workspacePath: ws, nowMs: () => T0 });
  const initResp = await mcp.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal((initResp?.result as { serverInfo: { name: string } }).serverInfo.name, "gadget-recall");

  const listResp = await mcp.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal((listResp?.result as { tools: Array<{ name: string }> }).tools[0]!.name, "recall");

  const callResp = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "recall", arguments: { query: "jitless", asOfMs: T0 } },
  });
  const textOut = ((callResp?.result as { content: Array<{ text: string }> }).content[0]?.text) ?? "";
  assert.match(textOut, /UNTRUSTED RECALLED DATA/);
  assert.match(textOut, /--wasm-tier-up=false/);

  const logs = mcp.readLogs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.query, "jitless");
  assert.equal(logs[0]!.used, null);
  assert.equal(mcp.markUsed(logs[0]!.callId, true), true);
  assert.equal(mcp.readLogs()[0]!.used, true);

  // Anticipator direct check.
  const anticipator = new CalibratedAnticipator(store, { priorEpisodes: episodes });
  const epToday = episodes.at(-1)!;
  const epCtx = { endMs: epToday.seekStartMs, eventIds: epToday.contextEventIds, workspacePath: "/w/vitre" };
  assert.ok(anticipator.score(epCtx).pSeek >= anticipator.threshold);
  const proposals = anticipator.propose(epCtx);
  assert.ok(proposals.some((p) => p.query.includes("jitless")));

  store.close();
});

test("skypanel HUD & chrome/android capture server e2e: serves de minimis 2-row HUD, captures chrome/android events, and composes cards from utterances", async () => {
  const home = fakeHome();
  const cfg = {
    ...defaultConfig(home),
    chromiumRoots: [join(home, "chrome")],
    gitRoots: [join(home, "code")],
  };
  const started = await startWorkbenchServer(cfg, { port: 0 });
  try {
    // 1. HTML Skypanel HUD renders 2-row floating HUD and controls
    const htmlResp = await fetch(`${started.url}/`);
    assert.equal(htmlResp.status, 200);
    const html = await htmlResp.text();
    assert.match(html, /gogogadget · Skypanel HUD/);
    assert.match(html, /class="skypanel-shell"/);

    // 2. Capture Android SMS from Nikesh
    const androidResp = await fetch(`${started.url}/api/capture/android`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            sender: "Nikesh",
            phone: "+14158901234",
            text: "Hey Ryan, free to catch up this week on the rollout?",
            app: "Android SMS",
            timestampMs: T0 + 9 * MIN,
          },
        ],
      }),
    });
    assert.equal(androidResp.status, 200);
    const androidJson = (await androidResp.json()) as { ok: boolean; appended: number };
    assert.equal(androidJson.ok, true);
    assert.equal(androidJson.appended, 1);

    // 3. Utterance trigger composes 2-row Skypanel card
    const uttResp = await fetch(`${started.url}/api/skypanel/utterance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "hey gadget, respond to nikesh and set up a time to meet",
        activeSurface: "desktop",
      }),
    });
    assert.equal(uttResp.status, 200);
    const uttJson = (await uttResp.json()) as {
      ok: boolean;
      card: {
        cardId: string;
        compactLabel: string;
        sourceIcons: string[];
        targetIcons: string[];
        contactName?: string;
      };
    };
    assert.equal(uttJson.ok, true);
    assert.equal(uttJson.card.compactLabel, "set meeting nikesh");
    assert.ok(uttJson.card.sourceIcons.includes("android"));
    assert.ok(uttJson.card.sourceIcons.includes("messages"));
    assert.ok(uttJson.card.targetIcons.includes("calendar"));

    // 4. Chrome Extension capture endpoint writes ~/.gadget/capture/chrome.jsonl (mode 0600)
    const capResp = await fetch(`${started.url}/api/capture/chrome`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "PAGE_VIEW",
            url: "https://www.google.com/search?q=node+sqlite+fts5",
            title: "node sqlite fts5 - Google Search",
            searchQuery: "node sqlite fts5",
            timestampMs: T0 + 10 * MIN,
          },
          {
            type: "HISTORY_VISIT",
            url: "https://nodejs.org/docs/latest/api/sqlite.html",
            title: "SQLite | Node.js Documentation",
            timestampMs: T0 + 11 * MIN,
          },
        ],
      }),
    });
    assert.equal(capResp.status, 200);
    const capJson = (await capResp.json()) as { ok: boolean; appended: number };
    assert.equal(capJson.ok, true);
    assert.equal(capJson.appended, 2);
  } finally {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  }
});
