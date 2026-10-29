import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { defaultConfig, type MinerConfig } from "../src/miner/config.js";
import { readLabelsCsv, requestAllowed, startWorkbenchServer } from "../src/web/server.js";
import { fakeHome } from "./fixtures/fake_home.js";
import { loadPlaywright, REPO, tmp } from "./helpers.js";

const EXT_ORIGIN = "chrome-extension://ooahpppegciihlejmjpcafjnhehkmdbn";

function workbenchConfig(): { home: string; cfg: MinerConfig } {
  const home = fakeHome();
  return { home, cfg: { ...defaultConfig(home), chromiumRoots: [join(home, "chrome")], gitRoots: [join(home, "code")] } };
}

function captureLog(cfg: MinerConfig): string {
  return join(dirname(cfg.zshHook), "chrome.jsonl");
}

function raw(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("requestAllowed: own page, typed URL, extension, and local clients pass; other sites do not", () => {
  const p = 4321;
  const own = { host: "127.0.0.1:4321" };
  const cases: Array<[Record<string, string>, string, boolean]> = [
    [own, "/api/state", true], // curl, node fetch
    [{ ...own, "sec-fetch-site": "none" }, "/", true], // typed URL or bookmark
    [{ ...own, origin: "http://127.0.0.1:4321", "sec-fetch-site": "same-origin" }, "/api/state", true],
    [{ host: "localhost:4321", origin: "http://localhost:4321" }, "/api/reingest", true],
    [{ ...own, origin: EXT_ORIGIN, "sec-fetch-site": "none" }, "/api/capture/chrome", true],
    [{ ...own, origin: "https://evil.test" }, "/api/state", false],
    [{ ...own, origin: "null" }, "/api/episodes/x/label", false], // sandboxed iframe, no-referrer
    [{ ...own, origin: "http://localhost:4321" }, "/api/state", false], // other loopback name is another origin
    [{ ...own, "sec-fetch-site": "cross-site" }, "/api/state", false], // <img>/<script> GET, no Origin
    [{ ...own, "sec-fetch-site": "same-site" }, "/api/state", false], // another localhost port
    [{ host: "evil.test:4321" }, "/api/state", false], // DNS rebinding
    [{ host: "127.0.0.1:9999" }, "/api/state", false],
    [{}, "/api/state", false],
    [{ ...own, origin: EXT_ORIGIN }, "/api/state", false], // the extension only needs capture and status
    [{ ...own, origin: EXT_ORIGIN }, "/api/episodes/x/label", false],
  ];
  for (const [headers, path, want] of cases) {
    assert.equal(requestAllowed(headers, p, path), want, `${JSON.stringify(headers)} ${path}`);
  }
  // On port 80, Host and Origin carry no port.
  assert.equal(requestAllowed({ host: "127.0.0.1", origin: "http://127.0.0.1" }, 80, "/api/state"), true);
  assert.equal(requestAllowed({ host: "localhost" }, 80, "/"), true);
  assert.equal(requestAllowed({ host: "127.0.0.1" }, 4321, "/api/state"), false);
  assert.equal(requestAllowed({ host: "evil.test" }, 80, "/api/state"), false);
});

test("workbench refuses other origins and rebinding hosts, sends no CORS headers, and changes nothing for them", async () => {
  const { cfg } = workbenchConfig();
  const started = await startWorkbenchServer(cfg, { port: 0 });
  const { port } = started;
  const labelsPath = join(started.getReportDir(), "labels.csv");
  try {
    const own = { host: `127.0.0.1:${port}` };
    const ok = await raw(port, "GET", "/api/state", { ...own, origin: `http://127.0.0.1:${port}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["access-control-allow-origin"], undefined);
    const episodeId = (JSON.parse(ok.body) as { episodes: Array<{ episodeId: string }> }).episodes[0]!.episodeId;
    const labelsBefore = readFileSync(labelsPath, "utf8");

    const crossRead = await raw(port, "GET", "/api/state", { ...own, origin: "https://evil.test" });
    assert.equal(crossRead.status, 403);
    assert.equal(crossRead.headers["access-control-allow-origin"], undefined);
    assert.doesNotMatch(crossRead.body, /jitless/);

    const preflight = await raw(port, "OPTIONS", "/api/state", {
      ...own,
      origin: "https://evil.test",
      "access-control-request-private-network": "true",
    });
    assert.equal(preflight.status, 403);
    assert.equal(preflight.headers["access-control-allow-private-network"], undefined);

    const rebound = await raw(port, "GET", "/api/state", { host: `evil.test:${port}` });
    assert.equal(rebound.status, 403);

    const body = JSON.stringify({ realSeeking: "Y", answerInMyData: "Y", note: "set by another site" });
    const label = `/api/episodes/${encodeURIComponent(episodeId)}/label`;
    const crossLabel = await raw(port, "POST", label, { ...own, origin: "https://evil.test", "content-type": "text/plain" }, body);
    assert.equal(crossLabel.status, 403);
    const extLabel = await raw(port, "POST", label, { ...own, origin: EXT_ORIGIN, "content-type": "application/json" }, body);
    assert.equal(extLabel.status, 403);
    assert.equal(readFileSync(labelsPath, "utf8"), labelsBefore);

    const planted = JSON.stringify({ events: [{ type: "PAGE_VIEW", url: "https://evil.test/x", title: "planted" }] });
    const crossCapture = await raw(port, "POST", "/api/capture/chrome", { ...own, origin: "https://evil.test" }, planted);
    assert.equal(crossCapture.status, 403);
    assert.equal(existsSync(captureLog(cfg)), false);

    const extCapture = await raw(port, "POST", "/api/capture/chrome", { ...own, origin: EXT_ORIGIN, "content-type": "application/json" }, planted);
    assert.equal(extCapture.status, 200);
    assert.match(readFileSync(captureLog(cfg), "utf8"), /evil\.test\/x/);
  } finally {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  }
});

test("browser: another site's page can neither read the workbench nor write to it; the workbench's own page still works", async (t) => {
  const pw = await loadPlaywright();
  if (!pw) {
    t.skip("Playwright not installed in this environment");
    return;
  }
  const { cfg } = workbenchConfig();
  const started = await startWorkbenchServer(cfg, { port: 0 });
  const target = started.url;
  const labelsPath = join(started.getReportDir(), "labels.csv");
  const labelsBefore = readFileSync(labelsPath, "utf8");
  const episodeId = readLabelsCsv(labelsPath)[0]!.episode_id;
  // The page another site would serve: read state, then try a label and a capture write
  // with text/plain bodies (no preflight).
  const attackerHtml = `<script>
    (async () => {
      const out = {};
      try { out.read = (await (await fetch("${target}/api/state")).text()).length; } catch (e) { out.read = "blocked"; }
      try {
        await fetch("${target}/api/episodes/${encodeURIComponent(episodeId)}/label", { method: "POST", headers: { "Content-Type": "text/plain" }, body: '{"realSeeking":"Y"}' });
        out.label = "sent";
      } catch (e) { out.label = "blocked"; }
      try {
        await fetch("${target}/api/capture/chrome", { method: "POST", headers: { "Content-Type": "text/plain" }, body: '{"events":[{"url":"https://evil.test/x"}]}' });
        out.capture = "sent";
      } catch (e) { out.capture = "blocked"; }
      try { out.rebound = (await fetch("/api/state")).status; } catch (e) { out.rebound = "blocked"; }
      document.title = "DONE " + JSON.stringify(out);
    })();
  </script>`;
  const attacker = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(attackerHtml);
  });
  await new Promise<void>((resolve) => attacker.listen(0, "127.0.0.1", () => resolve()));
  const attackerPort = (attacker.address() as { port: number }).port;
  const browser = await pw.chromium.launch({ args: ["--host-resolver-rules=MAP evil.test 127.0.0.1"] });
  try {
    const page = await browser.newPage();
    const doneTitle = () => page.waitForFunction(() => document.title.startsWith("DONE"), null, { timeout: 15000 });

    await page.goto(`http://evil.test:${attackerPort}/`);
    await doneTitle();
    const cross = JSON.parse((await page.title()).slice(5)) as Record<string, unknown>;
    assert.equal(cross.read, "blocked");

    // DNS rebinding: evil.test now names the workbench's own address and port, so the
    // page's fetch("/api/state") is same-origin to the browser. Chromium first sends a
    // Private Network Access preflight, which the workbench no longer grants ("blocked");
    // a browser without that preflight reaches the Host check (403, tested directly above).
    const rebindPage = await browser.newPage();
    await rebindPage.route(`http://evil.test:${started.port}/`, (route: any) =>
      route.fulfill({ status: 200, contentType: "text/html", body: attackerHtml }),
    );
    await rebindPage.goto(`http://evil.test:${started.port}/`);
    await rebindPage.waitForFunction(() => document.title.startsWith("DONE"), null, { timeout: 15000 });
    const rebound = JSON.parse((await rebindPage.title()).slice(5)) as Record<string, unknown>;
    assert.ok(rebound.rebound === "blocked" || rebound.rebound === 403, `rebound: ${rebound.rebound}`);

    // Writes may be sent (no-cors), but the server refuses them: nothing changed on disk.
    assert.equal(readFileSync(labelsPath, "utf8"), labelsBefore);
    assert.equal(existsSync(captureLog(cfg)), false);

    // The workbench's own page still loads its state.
    const own = await browser.newPage();
    await own.goto(target, { waitUntil: "networkidle" });
    await own.waitForFunction(() => document.getElementById("stat-tagged")?.textContent === "0 / 3");
  } finally {
    await browser.close();
    attacker.close();
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  }
});

test("browser: the capture extension still reaches the workbench and its page views land in chrome.jsonl", async (t) => {
  const pw = await loadPlaywright();
  if (!pw) {
    t.skip("Playwright not installed in this environment");
    return;
  }
  const { cfg } = workbenchConfig();
  const started = await startWorkbenchServer(cfg, { port: 0 });
  const site = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<title>docs page</title><body>rope bytes are stored inline</body>");
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", () => resolve()));
  const sitePort = (site.address() as { port: number }).port;
  const ext = join(REPO, "extensions", "chrome-shadow-bridge");
  // Extensions need the full Chromium build (channel "chromium"), not the headless shell.
  const context = await pw.chromium.launchPersistentContext(tmp("gadget-pw-"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--host-resolver-rules=MAP site.test 127.0.0.1"],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 10000 }));
    // Point the extension at this test's workbench port instead of 4321. serverBase is a
    // top-level `let` in background.js, so it is assigned by name, not through globalThis.
    await worker.evaluate(`serverBase = ${JSON.stringify(started.url)}`);
    const status = await worker.evaluate(`fetch(serverBase + "/api/status").then((r) => r.status)`);
    assert.equal(status, 200);

    const page = await context.newPage();
    await page.goto(`http://site.test:${sitePort}/docs`);
    const log = captureLog(cfg);
    const deadline = Date.now() + 10000;
    while (!(existsSync(log) && /rope bytes are stored inline/.test(readFileSync(log, "utf8")))) {
      assert.ok(Date.now() < deadline, "the extension's PAGE_VIEW never reached chrome.jsonl");
      await page.waitForTimeout(100);
    }
  } finally {
    await context.close();
    site.close();
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  }
});
