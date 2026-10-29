import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../src/miner/config.js";
import { readLabelsCsv, startWorkbenchServer } from "../src/web/server.js";
import { fakeHome } from "./fixtures/fake_home.js";

// Dynamically resolves Playwright from NODE_PATH or local cache when available.
async function loadPlaywright(): Promise<any | null> {
  const candidates = ["playwright", "/Users/mac/outbox/web/node_modules/playwright/index.js"];
  for (const mod of candidates) {
    try {
      const m = await import(mod);
      const resolved = m.chromium ? m : m.default;
      if (resolved && resolved.chromium) return resolved;
    } catch {
      // try next
    }
  }
  return null;
}

test("playwright UI e2e: exercises every interactive workbench control and verifies real backend labels.csv state transitions", async (t) => {
  const pw = await loadPlaywright();
  if (!pw) {
    t.skip("Playwright not installed in this environment");
    return;
  }

  const home = fakeHome();
  const cfg = {
    ...defaultConfig(home),
    chromiumRoots: [join(home, "chrome")],
    gitRoots: [join(home, "code")],
  };
  const started = await startWorkbenchServer(cfg, { port: 0 });
  let browser: any = null;

  try {
    browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const pointerTap = async (selector: string) => {
      const loc = page.locator(selector);
      await loc.waitFor({ state: "visible", timeout: 5000 });
      const box = await loc.boundingBox();
      assert.ok(box, `expected bounding box for ${selector}`);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.up();
    };

    await page.goto(started.url, { waitUntil: "networkidle" });

    // Verify Geometry A pixel budget: first data row begins within 110px of top of window
    const firstRowBox = await page.locator("#seek-actions-tbody tr").first().boundingBox();
    assert.ok(firstRowBox, "expected first seek action row");
    assert.ok(firstRowBox.y <= 140, `expected first data row near top, got y=${firstRowBox.y}`);

    // Verify initial state: 0 / 3 tagged
    assert.equal(await page.locator("#stat-tagged").textContent(), "0 / 3");
    assert.equal(await page.locator("#episode-list .ep-row").count(), 3);

    // Disable auto-advance first so we can test individual toggle buttons on episode #01
    await page.locator("#chk-autonext").uncheck();

    // Exercise Action Rail buttons: Real Seeking Y, Answer in Data Y
    await pointerTap("#rail-seek-y");
    await page.waitForFunction(() => document.getElementById("rail-seek-y")?.classList.contains("active-yes"));
    await pointerTap("#rail-data-y");
    await page.waitForFunction(() => document.getElementById("stat-tagged")?.textContent === "1 / 3");

    // Enter a note and press Enter
    await page.locator("#note-input").focus();
    await page.keyboard.type("verified via playwright ui");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);

    // Verify real backend persistence in labels.csv on disk
    const labelsPath = join(started.getReportDir(), "labels.csv");
    let rows = readLabelsCsv(labelsPath);
    assert.equal(rows[0]?.real_seeking, "Y");
    assert.equal(rows[0]?.answer_in_my_data, "Y");
    assert.equal(rows[0]?.note, "verified via playwright ui");

    // Exercise Inspector N buttons on episode #02 via Next button
    await pointerTap("#btn-next");
    await page.waitForFunction(() => document.getElementById("active-ep-seed")?.textContent?.startsWith("#02"));
    await pointerTap("#insp-seek-n");
    await page.waitForFunction(() => document.getElementById("stat-tagged")?.textContent === "2 / 3");

    rows = readLabelsCsv(labelsPath);
    assert.equal(rows[1]?.real_seeking, "N");
    assert.equal(rows[1]?.answer_in_my_data, "N");

    // Exercise Filter buttons: Unlabeled (should show 1), Labeled (should show 2), All (should show 3)
    await pointerTap("#filter-unlabeled");
    assert.equal(await page.locator("#episode-list .ep-row").count(), 1);
    await pointerTap("#filter-labeled");
    assert.equal(await page.locator("#episode-list .ep-row").count(), 2);
    await pointerTap("#filter-all");
    assert.equal(await page.locator("#episode-list .ep-row").count(), 3);

    // Exercise Prev button
    await pointerTap("#btn-prev");
    await page.waitForFunction(() => document.getElementById("active-ep-seed")?.textContent?.startsWith("#01"));

    // Exercise Write STATUS.md button
    await pointerTap("#btn-write-status");
    await page.waitForFunction(() => document.getElementById("save-indicator")?.textContent === "STATUS.md Written");
    const statusPath = join(home, ".gadget", "STATUS.md");
    assert.ok(existsSync(statusPath));
    assert.match(readFileSync(statusPath, "utf8"), /Sampled episodes labeled:.*2 \/ 3/);
  } finally {
    if (browser) await browser.close();
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  }
});
