import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { RecallMcpServer } from "../src/mcp/server.js";
import { defaultConfig } from "../src/miner/config.js";
import { makeEvent } from "../src/miner/event.js";
import {
  parseAndroidCapture,
  parseCalendarCapture,
  parseMessagesCapture,
} from "../src/miner/parsers/messages_calendar.js";
import { withSeeks } from "../src/miner/seek.js";
import { EventStore } from "../src/miner/store.js";
import type { SkypanelCard } from "../src/triggers/skypanel_composer.js";
import {
  executeCardOnSpine,
  reviseCardOnSpine,
  runFunctionalSpine,
} from "../src/triggers/spine.js";
import { startWorkbenchServer } from "../src/web/server.js";
import { fakeHome } from "./fixtures/fake_home.js";
import { MIN, tmp } from "./helpers.js";

test("Stage 1–4 Connected Functional Spine: Android SMS + Calendar -> 'hey gadget, respond to nikesh and set up a time to meet' -> 2-row Skypanel Card -> Revise -> Mode 1 (App) & Mode 2 (Agent)", async () => {
  const dir = tmp("spine-e2e");
  const dbPath = join(dir, "miner.db");
  const workspaceDir = join(dir, "workspace");
  mkdirSync(workspaceDir, { recursive: true });

  const store = new EventStore(dbPath);
  try {
    // 1. Ingest historical activity events to establish owner's empirical working hours (09:00..18:00)
    const workDayBase = Date.parse("2026-10-29T16:00:00Z");
    const historyEvents = [0, 1, 2, 3, 4].map((i) =>
      makeEvent({
        source: "zsh_hook",
        timestampMs: workDayBase + i * 30 * MIN,
        workspacePath: workspaceDir,
        contentText: `git status # check rollout branch step ${i}`,
        sourceUri: `zsh:history#${i}`,
        metadataJson: JSON.stringify({ cmd: "git status", exit: 0 }),
      }),
    );
    store.insert(withSeeks(historyEvents));

    // 2. Parse and insert real Android SMS from Nikesh + macOS Messages + Calendar busy slot
    const androidJsonl = JSON.stringify({
      sender: "Nikesh Arora",
      phone: "+14159901122",
      text: "Hey Ryan, can we set up a time to meet this week about the Q4 rollout?",
      app: "Android SMS",
      timestampMs: workDayBase + 60 * MIN,
    });
    const androidParsed = parseAndroidCapture(androidJsonl, join(dir, "android.jsonl"));
    assert.equal(androidParsed.events.length, 1);
    store.insert(withSeeks(androidParsed.events));

    const messagesJsonl = JSON.stringify({
      sender: "Nikesh Arora",
      handle: "nikesh@example.com",
      text: "Following up on iMessage as well — let me know what slot works.",
      service: "iMessage",
      timestampMs: workDayBase + 65 * MIN,
    });
    const messagesParsed = parseMessagesCapture(messagesJsonl, join(dir, "messages.jsonl"));
    assert.equal(messagesParsed.events.length, 1);
    store.insert(withSeeks(messagesParsed.events));

    const calendarJsonl = JSON.stringify({
      title: "Architecture Review",
      startIso: "2026-10-30T10:00:00.000Z",
      endIso: "2026-10-30T11:00:00.000Z",
      attendees: ["team@example.com"],
      location: "Room 4B",
      timestampMs: workDayBase + 30 * MIN,
    });
    const calendarParsed = parseCalendarCapture(calendarJsonl, join(dir, "calendar.jsonl"));
    assert.equal(calendarParsed.events.length, 1);
    store.insert(withSeeks(calendarParsed.events));

    // 3. Run the connected spine on the explicit utterance:
    //    "hey gadget, respond to nikesh and set up a time to meet"
    const spineOut = await runFunctionalSpine({
      store,
      dbPath,
      utteranceText: "hey gadget, respond to nikesh and set up a time to meet",
      workspacePath: workspaceDir,
      nowMs: workDayBase + 70 * MIN,
    });

    assert.ok(spineOut.slot, "Expected Cosmo spoken slot to be extracted");
    assert.equal(spineOut.slot.triggerPrefix, "Hey Gadget");
    assert.equal(spineOut.slot.socialMode, "alone_wake_word");

    assert.ok(spineOut.card, "Expected 2-row Skypanel card to be composed");
    const card = spineOut.card;
    // Row 1: [ {android icon}{Messages.app icon} set meeting nikesh {calendar.app icon} ]
    assert.equal(card.compactLabel, "set meeting nikesh");
    assert.ok(card.sourceIcons.includes("android"), `Expected android in sourceIcons: ${card.sourceIcons.join(",")}`);
    assert.ok(card.sourceIcons.includes("messages"), `Expected messages in sourceIcons: ${card.sourceIcons.join(",")}`);
    assert.ok(card.targetIcons.includes("calendar"), `Expected calendar in targetIcons: ${card.targetIcons.join(",")}`);
    assert.ok(card.contactName?.toLowerCase().includes("nikesh"));
    assert.ok(card.inferredWorkingHours, "Expected empirical working hours to be inferred");
    assert.ok(card.proposedTimeLabel, "Expected conflict-free calendar slot to be proposed");

    // 4. Test {revise} on the spine
    const revised = await reviseCardOnSpine({
      store,
      cardId: card.cardId,
      instruction: "move to Thursday at 14:00 and include zoom link",
      workspacePath: workspaceDir,
    });
    assert.ok(revised);
    assert.equal(revised.revisions.length, 1);
    assert.match(revised.stagedAgentBrief, /move to Thursday at 14:00 and include zoom link/);

    // 5. Test {go go gadget} Mode 1 (app — Scoped Native App / Draft Launch)
    const mode1Res = await executeCardOnSpine({
      store,
      dbPath,
      cardId: card.cardId,
      modeOverride: "app",
      workspacePath: workspaceDir,
    });
    assert.ok(mode1Res);
    assert.equal(mode1Res.card.selectedMode, "app");
    assert.equal(mode1Res.card.status, "DISPATCHED");
    assert.ok(mode1Res.writtenPaths.length > 0);
    for (const p of mode1Res.writtenPaths) {
      assert.ok(existsSync(p), `Expected staged artifact to exist on disk: ${p}`);
    }
    const icsPath = mode1Res.writtenPaths.find((p) => p.endsWith(".ics"));
    assert.ok(icsPath, "Expected .ics calendar invite to be staged");
    assert.match(readFileSync(icsPath, "utf8"), /BEGIN:VCALENDAR/);
    assert.ok(existsSync(join(workspaceDir, ".gadget", "brief.md")), "Expected workspace .gadget/brief.md to be written");

    // 6. Test {go go gadget} Mode 2 (agent — Scoped Go-Go-Gadget Action Agent)
    const mode2Res = await executeCardOnSpine({
      store,
      dbPath,
      cardId: card.cardId,
      modeOverride: "agent",
      workspacePath: workspaceDir,
    });
    assert.ok(mode2Res);
    assert.equal(mode2Res.card.selectedMode, "agent");
    assert.ok(mode2Res.card.agentReceipt, "Expected Scoped Action Agent receipt on card");
    assert.equal(mode2Res.card.agentReceipt.mode, "agent");
    for (const p of mode2Res.card.agentReceipt.artifactPaths) {
      assert.ok(existsSync(p), `Expected agent receipt artifact on disk: ${p}`);
    }

    // Verify persisted state in SQLite
    const persisted = store.getSkypanelCard(card.cardId);
    assert.ok(persisted);
    assert.equal(persisted.selectedMode, "agent");
    assert.ok(persisted.agentReceipt);
    assert.equal(persisted.agentReceipt.mode, "agent");
  } finally {
    store.close();
  }
});

test("HTTP Skypanel Loopback API + Display Budget <= 3 + MCP list_skypanel_cards", async () => {
  const home = fakeHome();
  const cfg = {
    ...defaultConfig(home),
    chromiumRoots: [join(home, "chrome")],
    gitRoots: [join(home, "code")],
  };
  const started = await startWorkbenchServer(cfg, { port: 0 });
  try {
    // 1. Post 4 distinct utterances to verify strict display budget (max 3 cards returned)
    const utterances = [
      "hey gadget, respond to nikesh and set up a time to meet",
      "Note to self: verify sqlite wal checkpoint latency before release",
      "Remind me to send the benchmark receipt to alex tomorrow",
      "FYI we locked the port to 4321 for loopback skypanel",
    ];
    for (const u of utterances) {
      const resp = await fetch(`${started.url}/api/skypanel/utterance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ utterance: u }),
      });
      assert.equal(resp.status, 200);
      const data = (await resp.json()) as { ok: boolean; card: SkypanelCard };
      assert.equal(data.ok, true);
      assert.ok(data.card);
    }

    // 2. GET /api/skypanel returns at most 3 cards (Strict Display Budget)
    const listResp = await fetch(`${started.url}/api/skypanel`);
    assert.equal(listResp.status, 200);
    const listData = (await listResp.json()) as { ok: boolean; cards: SkypanelCard[] };
    assert.equal(listData.ok, true);
    assert.ok(listData.cards.length <= 3, `Expected at most 3 cards, got ${listData.cards.length}`);
    assert.equal(listData.cards.length, 3);

    // 3. Revise top card via HTTP API
    const topCardId = listData.cards[0]!.cardId;
    const revResp = await fetch(`${started.url}/api/skypanel/${encodeURIComponent(topCardId)}/revise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: "make it 15:30 PST" }),
    });
    assert.equal(revResp.status, 200);
    const revData = (await revResp.json()) as { ok: boolean; card: SkypanelCard };
    assert.equal(revData.ok, true);
    assert.equal(revData.card.revisions.length, 1);

    // 4. Execute top card in Mode 2 (agent) via HTTP API
    const execResp = await fetch(`${started.url}/api/skypanel/${encodeURIComponent(topCardId)}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "agent" }),
    });
    assert.equal(execResp.status, 200);
    const execData = (await execResp.json()) as {
      ok: boolean;
      card: SkypanelCard;
      writtenPaths: string[];
    };
    assert.equal(execData.ok, true);
    assert.equal(execData.card.selectedMode, "agent");
    assert.equal(execData.card.status, "DISPATCHED");
    assert.ok(execData.card.agentReceipt);
    assert.ok(execData.writtenPaths.length > 0);

    // 5. MCP list_skypanel_cards returns remaining PENDING cards
    const store = new EventStore(cfg.dbPath, { readOnly: true });
    try {
      const mcp = new RecallMcpServer(store, {
        logPath: join(home, ".gadget", "mcp_calls.jsonl"),
      });
      const mcpResp = await mcp.handleRequest({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "list_skypanel_cards", arguments: {} },
      });
      assert.ok(mcpResp && !mcpResp.error);
      const resultObj = mcpResp.result as { content: Array<{ text: string }> };
      const mcpCards = JSON.parse(resultObj.content[0]!.text) as SkypanelCard[];
      assert.ok(mcpCards.length <= 3);
      assert.ok(mcpCards.every((c) => c.status === "PENDING"));
    } finally {
      store.close();
    }
  } finally {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  }
});

test("Playwright Real Browser Geometry & Interactive E2E across Desktop (1280x800) and Mobile (390x844)", async (t) => {
  const chromeBin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const pwPath = "/Users/mac/outbox/web/node_modules/playwright-core";
  if (!existsSync(chromeBin) || !existsSync(pwPath)) {
    t.skip("Local Chrome or playwright-core not present in CI environment");
    return;
  }

  const req = createRequire(import.meta.url);
  const { chromium } = req(pwPath) as {
    chromium: {
      launch: (opts: { executablePath: string; headless: boolean }) => Promise<{
        newContext: (opts: { viewport: { width: number; height: number } }) => Promise<{
          newPage: () => Promise<{
            goto: (url: string, opts?: { waitUntil?: string }) => Promise<unknown>;
            waitForSelector: (sel: string) => Promise<unknown>;
            evaluate: <R>(fn: () => R) => Promise<R>;
            mouse: { click: (x: number, y: number) => Promise<void> };
            keyboard: { type: (text: string) => Promise<void>; press: (key: string) => Promise<void> };
            screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>;
          }>;
          close: () => Promise<void>;
        }>;
        close: () => Promise<void>;
      }>;
    };
  };

  const home = fakeHome();
  const cfg = {
    ...defaultConfig(home),
    chromiumRoots: [join(home, "chrome")],
    gitRoots: [join(home, "code")],
  };
  const started = await startWorkbenchServer(cfg, { port: 0 });
  const browser = await chromium.launch({ executablePath: chromeBin, headless: true });

  try {
    // Seed Android SMS from Nikesh + trigger utterance
    await fetch(`${started.url}/api/capture/android`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: "Nikesh Arora",
        phone: "+14158901234",
        text: "Hey Ryan, free to catch up this week on the rollout?",
        app: "Android SMS",
        timestampMs: Date.now() - 5 * MIN,
      }),
    });
    await fetch(`${started.url}/api/skypanel/utterance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        utterance: "hey gadget, respond to nikesh and set up a time to meet",
      }),
    });

    const scratchDir =
      "/Users/mac/.gemini/antigravity/brain/12803bd1-a7e7-4ba4-93e6-1d709367699b/scratch";
    mkdirSync(scratchDir, { recursive: true });

    // 1. Desktop (1280x800) Geometry & Interactive Verification
    const desktopCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const desktopPage = await desktopCtx.newPage();
    await desktopPage.goto(started.url, { waitUntil: "networkidle" });
    await desktopPage.waitForSelector(".skypanel-card");

    const desktopGeom = await desktopPage.evaluate(() => {
      const card = document.querySelector(".skypanel-card")!;
      const row1 = card.querySelector(".card-row-1")!;
      const row2 = card.querySelector(".card-row-2")!;
      const srcIcons = card.querySelector(".source-icons")!;
      const label = card.querySelector(".nugget-label")!;
      const tgtIcons = card.querySelector(".target-icons")!;
      const reviseBtn = card.querySelector(".btn-revise")!;
      const modeAgentBtn = card.querySelector(".mode-agent")!;
      const gogogadgetBtn = card.querySelector(".btn-gogogadget")!;

      const rect = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
      };
      return {
        card: rect(card),
        row1: rect(row1),
        row2: rect(row2),
        srcIcons: rect(srcIcons),
        label: rect(label),
        labelText: label.textContent?.trim() ?? "",
        tgtIcons: rect(tgtIcons),
        reviseBtn: rect(reviseBtn),
        modeAgentBtn: rect(modeAgentBtn),
        gogogadgetBtn: rect(gogogadgetBtn),
      };
    });

    assert.ok(desktopGeom.card.width >= 400, `Desktop card width ${desktopGeom.card.width} < 400`);
    assert.ok(desktopGeom.label.width >= 150, `Desktop label width ${desktopGeom.label.width} < 150`);
    assert.equal(desktopGeom.labelText, "set meeting nikesh");
    // Row 1 strictly above Row 2
    assert.ok(desktopGeom.row1.bottom <= desktopGeom.row2.y + 4);
    // Row 2 buttons non-overlapping and visible
    assert.ok(desktopGeom.reviseBtn.width >= 50 && desktopGeom.reviseBtn.height >= 24);
    assert.ok(desktopGeom.gogogadgetBtn.width >= 90 && desktopGeom.gogogadgetBtn.height >= 24);
    assert.ok(desktopGeom.reviseBtn.right <= desktopGeom.modeAgentBtn.x + 2);

    await desktopPage.screenshot({
      path: join(scratchDir, "skypanel-desktop-1280x800.png"),
      fullPage: true,
    });

    // Exercise Mode 2 (agent) switch + {revise} + {go go gadget} via real mouse coordinates
    await desktopPage.mouse.click(
      desktopGeom.modeAgentBtn.x + desktopGeom.modeAgentBtn.width / 2,
      desktopGeom.modeAgentBtn.y + desktopGeom.modeAgentBtn.height / 2,
    );
    await new Promise((r) => setTimeout(r, 150));

    // Re-read revise button position and open revise drawer
    const revBox = await desktopPage.evaluate(() => {
      const r = document.querySelector(".btn-revise")!.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await desktopPage.mouse.click(revBox.x, revBox.y);
    await desktopPage.waitForSelector(".revise-drawer.open .revise-input");
    const inputBox = await desktopPage.evaluate(() => {
      const r = document.querySelector(".revise-drawer.open .revise-input")!.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await desktopPage.mouse.click(inputBox.x, inputBox.y);
    await desktopPage.keyboard.type("move to Thursday at 15:00");
    await desktopPage.keyboard.press("Enter");
    await new Promise((r) => setTimeout(r, 250));

    // Verify revision persisted in SQLite
    const afterRevResp = await fetch(`${started.url}/api/skypanel`);
    const afterRevJson = (await afterRevResp.json()) as { cards: SkypanelCard[] };
    assert.equal(afterRevJson.cards[0]!.revisions.length, 1);
    assert.equal(afterRevJson.cards[0]!.selectedMode, "agent");

    // Trigger {go go gadget} via mouse coordinates
    const gggBox = await desktopPage.evaluate(() => {
      const r = document.querySelector(".btn-gogogadget")!.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await desktopPage.mouse.click(gggBox.x, gggBox.y);
    await new Promise((r) => setTimeout(r, 400));

    await desktopPage.screenshot({
      path: join(scratchDir, "skypanel-desktop-dispatched-1280x800.png"),
      fullPage: true,
    });
    await desktopCtx.close();

    // 2. Mobile (390x844) Viewport Geometry Verification
    await fetch(`${started.url}/api/skypanel/utterance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        utterance: "Remind me to send the rollout summary to nikesh tomorrow",
      }),
    });

    const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await mobileCtx.newPage();
    await mobilePage.goto(started.url, { waitUntil: "networkidle" });
    await mobilePage.waitForSelector(".skypanel-card");

    const mobileGeom = await mobilePage.evaluate(() => {
      const card = document.querySelector(".skypanel-card")!;
      const label = card.querySelector(".nugget-label")!;
      const gggBtn = card.querySelector(".btn-gogogadget")!;
      const cr = card.getBoundingClientRect();
      const lr = label.getBoundingClientRect();
      const gr = gggBtn.getBoundingClientRect();
      return {
        cardWidth: cr.width,
        cardRight: cr.right,
        labelWidth: lr.width,
        gggWidth: gr.width,
        gggHeight: gr.height,
        docScrollWidth: document.documentElement.scrollWidth,
      };
    });

    assert.ok(mobileGeom.cardWidth >= 320, `Mobile card width ${mobileGeom.cardWidth} < 320`);
    assert.ok(mobileGeom.labelWidth >= 120, `Mobile label width ${mobileGeom.labelWidth} < 120`);
    assert.ok(mobileGeom.gggWidth >= 90 && mobileGeom.gggHeight >= 24);
    assert.ok(mobileGeom.docScrollWidth <= 395, `Mobile horizontal overflow: ${mobileGeom.docScrollWidth}`);

    await mobilePage.screenshot({
      path: join(scratchDir, "skypanel-mobile-390x844.png"),
      fullPage: true,
    });
    await mobileCtx.close();
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  }
});
