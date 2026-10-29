// Geometry A 3-Pane Split Workbench UI for tagging the 25 Phase 0 episodes
// and monitoring Chrome Extension + Zsh Hook capture.
// Strictly follows data-workbench-ui rules (36px top header, 36px fixed action rail,
// 3 resizable columns with 1px #1E293B borders, zero card-in-card nesting, zero
// vertical accent stripes, max 1 badge per row) and guard_no_send rules.

export function renderWorkbenchHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Gadget Phase 0 Episode Tagging Workbench</title>
    <style>
      :root {
        color-scheme: dark;
        --bg-0: #090d16;
        --bg-1: #0f172a;
        --bg-2: #1e293b;
        --bg-active: #172554;
        --border: #1e293b;
        --border-strong: #334155;
        --text-0: #f8fafc;
        --text-1: #cbd5e1;
        --text-2: #94a3b8;
        --accent: #3b82f6;
        --ok-bg: #052e16;
        --ok-border: #14532d;
        --ok-text: #4ade80;
        --warn-bg: #422006;
        --warn-border: #713f12;
        --warn-text: #facc15;
        --no-bg: #450a0a;
        --no-border: #7f1d1d;
        --no-text: #f87171;
        --left-w: 300px;
        --right-w: 380px;
      }
      * {
        box-sizing: border-box;
      }
      html,
      body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: var(--bg-0);
        color: var(--text-0);
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
      }
      .mono {
        font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
      }
      /* 1. Razor-thin 36px Top Header Bar */
      #top-header {
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 12px;
        background: var(--bg-1);
        border-bottom: 1px solid var(--border);
        gap: 12px;
        user-select: none;
      }
      .header-group {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
      }
      .brand {
        font-weight: 600;
        font-size: 13px;
        color: var(--text-0);
        white-space: nowrap;
      }
      .stat-item {
        font-size: 12px;
        color: var(--text-2);
        white-space: nowrap;
      }
      .stat-item strong {
        color: var(--text-0);
        font-family: "SF Mono", Menlo, monospace;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        height: 20px;
        padding: 0 6px;
        border-radius: 3px;
        font: 500 11px/1 "SF Mono", Menlo, monospace;
        border: 1px solid var(--border-strong);
        background: var(--bg-2);
        color: var(--text-1);
        white-space: nowrap;
      }
      .badge.ok {
        background: var(--ok-bg);
        border-color: var(--ok-border);
        color: var(--ok-text);
      }
      .badge.warn {
        background: var(--warn-bg);
        border-color: var(--warn-border);
        color: var(--warn-text);
      }
      .badge.no {
        background: var(--no-bg);
        border-color: var(--no-border);
        color: var(--no-text);
      }
      .btn {
        height: 26px;
        padding: 0 9px;
        border: 1px solid var(--border-strong);
        background: var(--bg-2);
        color: var(--text-0);
        font: 500 12px/1 -apple-system, BlinkMacSystemFont, sans-serif;
        border-radius: 3px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        white-space: nowrap;
      }
      .btn:hover {
        background: #334155;
      }
      .btn.active-yes {
        background: var(--ok-bg);
        border-color: #22c55e;
        color: var(--ok-text);
      }
      .btn.active-no {
        background: var(--no-bg);
        border-color: #ef4444;
        color: var(--no-text);
      }
      .btn.primary {
        background: #1d4ed8;
        border-color: var(--accent);
        color: #ffffff;
      }
      kbd {
        font: 10px/1 "SF Mono", Menlo, monospace;
        padding: 2px 4px;
        border-radius: 2px;
        background: rgba(15, 23, 42, 0.8);
        border: 1px solid var(--border-strong);
        color: var(--text-2);
      }
      /* 2. Main 3-Column Split Layout */
      #workbench-body {
        display: grid;
        grid-template-columns: var(--left-w) 5px minmax(420px, 1fr) 5px var(--right-w);
        width: 100%;
        height: calc(100vh - 36px);
        overflow: hidden;
      }
      .split-divider {
        background: var(--bg-0);
        border-left: 1px solid var(--border);
        border-right: 1px solid var(--border);
        cursor: ew-resize;
        user-select: none;
      }
      .split-divider:hover,
      .split-divider.dragging {
        background: var(--accent);
      }
      .pane {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-width: 0;
        overflow: hidden;
      }
      .rail-bar {
        height: 36px;
        min-height: 36px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 10px;
        background: var(--bg-1);
        border-bottom: 1px solid var(--border);
        gap: 6px;
      }
      /* Left Rail: Episode Queue */
      #episode-list {
        flex: 1;
        overflow-y: auto;
      }
      .ep-row {
        display: grid;
        grid-template-columns: 32px 1fr auto;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        border-bottom: 1px solid var(--border);
        cursor: pointer;
        user-select: none;
      }
      .ep-row:hover {
        background: #111c33;
      }
      .ep-row.selected {
        background: var(--bg-active);
      }
      .ep-idx {
        font: 600 11px/1 "SF Mono", Menlo, monospace;
        color: var(--text-2);
      }
      .ep-query {
        font-size: 12px;
        color: var(--text-0);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ep-sub {
        font: 11px/1.2 "SF Mono", Menlo, monospace;
        color: var(--text-2);
        margin-top: 2px;
      }
      /* Center Canvas */
      #center-scroll {
        flex: 1;
        overflow-y: auto;
        padding: 0;
      }
      .section-header {
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 12px;
        background: #0c1322;
        border-bottom: 1px solid var(--border);
        font-weight: 600;
        font-size: 12px;
        color: var(--text-1);
      }
      table.data-grid {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }
      table.data-grid th,
      table.data-grid td {
        padding: 6px 12px;
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: top;
        font-size: 12px;
      }
      table.data-grid th {
        background: var(--bg-1);
        color: var(--text-2);
        font-weight: 500;
      }
      .pre-wrap {
        white-space: pre-wrap;
        word-break: break-word;
        font: 12px/1.45 "SF Mono", Menlo, monospace;
        color: var(--text-0);
        max-height: 220px;
        overflow-y: auto;
      }
      .uri-text {
        font: 11px/1.3 "SF Mono", Menlo, monospace;
        color: var(--text-2);
        word-break: break-all;
      }
      /* Right Inspector: 3 Fixed Cards (max card depth = 1) */
      #right-scroll {
        flex: 1;
        overflow-y: auto;
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .inspector-card {
        border: 1px solid var(--border);
        background: var(--bg-1);
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .card-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-weight: 600;
        font-size: 12px;
        color: var(--text-0);
        padding-bottom: 6px;
        border-bottom: 1px solid var(--border);
      }
      .field-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .btn-group {
        display: inline-flex;
        gap: 6px;
      }
      input.note-input {
        width: 100%;
        height: 30px;
        padding: 0 8px;
        background: var(--bg-0);
        border: 1px solid var(--border-strong);
        color: var(--text-0);
        font: 12px/1 "SF Mono", Menlo, monospace;
        border-radius: 3px;
      }
      input.note-input:focus {
        outline: 1px solid var(--accent);
      }
      .quote-box {
        background: var(--bg-0);
        border: 1px solid var(--border);
        padding: 8px;
        font: 11.5px/1.45 "SF Mono", Menlo, monospace;
        color: var(--text-1);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 180px;
        overflow-y: auto;
      }
    </style>
  </head>
  <body>
    <!-- 36px Razor-Thin Header Bar -->
    <header id="top-header">
      <div class="header-group">
        <span class="brand">Gadget Phase 0 Tagging Workbench</span>
        <span class="stat-item">Tagged: <strong id="stat-tagged">0 / 25</strong></span>
        <span class="stat-item">Real Seeking (Y): <strong id="stat-seeking">0</strong></span>
        <span class="stat-item">Answer in Data (Y): <strong id="stat-answer">0</strong></span>
        <span id="gate-badge" class="badge warn">Gate: 0/20 real seeking</span>
      </div>
      <div class="header-group">
        <span class="stat-item">Ceiling: <strong id="stat-ceiling">-</strong></span>
        <span class="stat-item">Zsh Hook: <strong id="stat-zsh">0</strong></span>
        <span class="stat-item">Chrome Ext: <strong id="stat-chrome">0</strong></span>
        <button id="btn-reingest" class="btn" type="button">Re-ingest &amp; Refresh</button>
        <button id="btn-write-status" class="btn primary" type="button">Write STATUS.md</button>
      </div>
    </header>

    <!-- 3-Column Split Body -->
    <div id="workbench-body">
      <!-- Left Column: Sampled Episodes Queue (1..25) -->
      <section class="pane" aria-label="Sampled Episodes">
        <div class="rail-bar">
          <div class="btn-group" role="group" aria-label="Filter episodes">
            <button id="filter-all" class="btn primary" type="button" data-filter="all">All (25)</button>
            <button id="filter-unlabeled" class="btn" type="button" data-filter="unlabeled">Unlabeled</button>
            <button id="filter-labeled" class="btn" type="button" data-filter="labeled">Labeled</button>
          </div>
          <span id="save-indicator" class="badge ok">Saved</span>
        </div>
        <div id="episode-list" role="listbox" aria-label="25 sampled episodes"></div>
      </section>

      <div id="divider-left" class="split-divider" title="Drag to resize; double-click to reset"></div>

      <!-- Center Column: Fixed Action Rail + Episode Trace Tables -->
      <main class="pane" aria-label="Episode Trace Canvas">
        <!-- Fixed 36px Selection Action Rail -->
        <div class="rail-bar">
          <div class="header-group" style="gap:6px">
            <span id="active-ep-seed" class="mono" style="font-size:12px;color:var(--text-1)">#01</span>
            <button id="rail-seek-y" class="btn" type="button">Seek: Y <kbd>Y</kbd></button>
            <button id="rail-seek-n" class="btn" type="button">Seek: N <kbd>N</kbd></button>
            <button id="rail-data-y" class="btn" type="button">Data: Y <kbd>D</kbd></button>
            <button id="rail-data-n" class="btn" type="button">Data: N <kbd>M</kbd></button>
            <button id="rail-both-y" class="btn" type="button">Both Y <kbd>&crarr;</kbd></button>
            <button id="rail-clear" class="btn" type="button">Clear</button>
          </div>
          <div class="header-group" style="gap:6px">
            <button id="btn-prev" class="btn" type="button">&larr; <kbd>K</kbd></button>
            <button id="btn-next" class="btn" type="button"><kbd>J</kbd> &rarr;</button>
          </div>
        </div>

        <div id="center-scroll">
          <div class="section-header">
            <span>Seek Actions in Episode</span>
            <span id="ep-meta-summary" class="mono" style="font-weight:400;color:var(--text-2)"></span>
          </div>
          <table class="data-grid" aria-label="Seek actions">
            <thead>
              <tr>
                <th style="width:130px">Kind</th>
                <th>Query / Prompt</th>
                <th style="width:260px">Source Pointer</th>
              </tr>
            </thead>
            <tbody id="seek-actions-tbody"></tbody>
          </table>

          <div class="section-header">
            <span>Context Window Before Seeking (10 min prior, chronological)</span>
            <span id="ctx-count-summary" class="mono" style="font-weight:400;color:var(--text-2)"></span>
          </div>
          <table class="data-grid" aria-label="Context events before seeking">
            <thead>
              <tr>
                <th style="width:95px">Time (UTC)</th>
                <th style="width:140px">Source</th>
                <th>Verbatim Event Content</th>
              </tr>
            </thead>
            <tbody id="context-events-tbody"></tbody>
          </table>
        </div>
      </main>

      <div id="divider-right" class="split-divider" title="Drag to resize; double-click to reset"></div>

      <!-- Right Column: 3 Fixed Inspector Lenses -->
      <aside class="pane" aria-label="Local Hits &amp; Verdict Inspector">
        <div class="rail-bar">
          <strong style="font-size:12px">Owner Verdict &amp; Local Evidence</strong>
          <label style="font-size:11px;color:var(--text-2);display:flex;align-items:center;gap:4px;cursor:pointer">
            <input id="chk-autonext" type="checkbox" checked /> Auto-advance
          </label>
        </div>
        <div id="right-scroll">
          <!-- Card 1: Persisted labels.csv Verdict -->
          <div class="inspector-card">
            <div class="card-title">
              <span>1. Episode Verdict (labels.csv)</span>
              <span id="card-verdict-badge" class="badge">UNLABELED</span>
            </div>
            <div class="field-row">
              <span>Was this real seeking?</span>
              <div class="btn-group">
                <button id="insp-seek-y" class="btn" type="button">Yes (Y)</button>
                <button id="insp-seek-n" class="btn" type="button">No (N)</button>
              </div>
            </div>
            <div class="field-row">
              <span>Was the answer in your data?</span>
              <div class="btn-group">
                <button id="insp-data-y" class="btn" type="button">Yes (Y)</button>
                <button id="insp-data-n" class="btn" type="button">No (N)</button>
              </div>
            </div>
            <div>
              <input
                id="note-input"
                class="note-input"
                type="text"
                placeholder="Optional note (saved on Enter or blur)..."
                aria-label="Episode label note"
              />
            </div>
            <div id="labels-path-readout" class="uri-text"></div>
          </div>

          <!-- Card 2: Best Local Hit Before Seek -->
          <div class="inspector-card">
            <div class="card-title">
              <span>2. Top Local Hit (&lt; seekStartMs)</span>
              <span id="hit-all-badge" class="badge">none</span>
            </div>
            <div id="hit-all-uri" class="uri-text"></div>
            <div id="hit-all-quote" class="quote-box">No FTS match strictly before seekStartMs.</div>
          </div>

          <!-- Card 3: Local Hit Older Than 1 Day & Episode Resolution -->
          <div class="inspector-card">
            <div class="card-title">
              <span>3. Hit &gt;1 Day Old &amp; Resolution</span>
              <span id="hit-old-badge" class="badge">none</span>
            </div>
            <div id="hit-old-uri" class="uri-text"></div>
            <div id="hit-old-quote" class="quote-box">No FTS match older than 1 day before seekStartMs.</div>
            <div id="resolution-readout" class="uri-text"></div>
          </div>
        </div>
      </aside>
    </div>

    <script>
      (() => {
        let state = null;
        let selectedIdx = 0;
        let currentFilter = "all";

        const el = (id) => document.getElementById(id);

        function visibleEpisodes() {
          if (!state || !state.episodes) return [];
          return state.episodes.filter((ep) => {
            const isLabeled = ep.label.realSeeking !== "" && ep.label.answerInMyData !== "";
            if (currentFilter === "unlabeled") return !isLabeled;
            if (currentFilter === "labeled") return isLabeled;
            return true;
          });
        }

        function currentEpisode() {
          if (!state || !state.episodes || state.episodes.length === 0) return null;
          return state.episodes[selectedIdx] || state.episodes[0];
        }

        function badgeForEpisode(ep) {
          const rs = ep.label.realSeeking;
          const ad = ep.label.answerInMyData;
          if (!rs && !ad) return { text: "UNLABELED", cls: "badge warn" };
          const text = (rs || "?") + " · " + (ad || "?");
          if (rs === "Y" && ad === "Y") return { text, cls: "badge ok" };
          if (rs === "N") return { text, cls: "badge no" };
          return { text, cls: "badge" };
        }

        function renderHeader() {
          if (!state) return;
          const m = state.metrics;
          el("stat-tagged").textContent = m.labeledCount + " / " + m.totalSampled;
          el("stat-seeking").textContent = m.realSeekingYes + " Y / " + m.realSeekingNo + " N";
          el("stat-answer").textContent = m.answerInDataYes + " Y / " + m.answerInDataNo + " N";
          el("stat-ceiling").textContent = m.ceilingLocalHit;
          el("stat-zsh").textContent = String(state.capture.zshCaptureLines);
          el("stat-chrome").textContent = String(state.capture.chromeCaptureLines);

          const gate = el("gate-badge");
          gate.textContent = "Gate: " + m.realSeekingYes + "/20 real seeking";
          gate.className = m.realSeekingYes >= 20 ? "badge ok" : "badge warn";

          el("filter-all").textContent = "All (" + m.totalSampled + ")";
          el("filter-unlabeled").textContent = "Unlabeled (" + (m.totalSampled - m.labeledCount) + ")";
          el("filter-labeled").textContent = "Labeled (" + m.labeledCount + ")";
        }

        function renderList() {
          const container = el("episode-list");
          container.innerHTML = "";
          const list = visibleEpisodes();
          for (const ep of list) {
            const row = document.createElement("div");
            row.className = "ep-row" + (ep.sampleIndex - 1 === selectedIdx ? " selected" : "");
            row.setAttribute("role", "option");
            row.setAttribute("data-sample-index", String(ep.sampleIndex));
            row.setAttribute("aria-selected", ep.sampleIndex - 1 === selectedIdx ? "true" : "false");

            const idxSpan = document.createElement("div");
            idxSpan.className = "ep-idx";
            idxSpan.textContent = "#" + String(ep.sampleIndex).padStart(2, "0");

            const mid = document.createElement("div");
            mid.style.minWidth = "0";
            const qDiv = document.createElement("div");
            qDiv.className = "ep-query";
            qDiv.textContent = ep.primaryQuery || "(empty query)";
            const subDiv = document.createElement("div");
            subDiv.className = "ep-sub";
            subDiv.textContent = ep.primaryKind + " · " + ep.seekStartIso.slice(0, 16).replace("T", " ");
            mid.appendChild(qDiv);
            mid.appendChild(subDiv);

            const b = badgeForEpisode(ep);
            const badge = document.createElement("span");
            badge.className = b.cls;
            badge.textContent = b.text;

            row.appendChild(idxSpan);
            row.appendChild(mid);
            row.appendChild(badge);

            row.addEventListener("pointerup", () => {
              selectedIdx = ep.sampleIndex - 1;
              renderAll();
            });
            container.appendChild(row);
          }
        }

        function renderCenterAndInspector() {
          const ep = currentEpisode();
          if (!ep) return;

          el("active-ep-seed").textContent = "#" + String(ep.sampleIndex).padStart(2, "0");
          el("ep-meta-summary").textContent =
            ep.episodeId +
            " · " +
            ep.seekStartIso +
            " · tokens: " +
            (ep.keyTokens.length ? ep.keyTokens.join(", ") : "none") +
            (ep.repeatSeek ? " · REPEAT SEEK" : "");

          // Action rail & inspector active button highlights
          const rs = ep.label.realSeeking;
          const ad = ep.label.answerInMyData;
          el("rail-seek-y").className = "btn" + (rs === "Y" ? " active-yes" : "");
          el("rail-seek-n").className = "btn" + (rs === "N" ? " active-no" : "");
          el("rail-data-y").className = "btn" + (ad === "Y" ? " active-yes" : "");
          el("rail-data-n").className = "btn" + (ad === "N" ? " active-no" : "");

          el("insp-seek-y").className = "btn" + (rs === "Y" ? " active-yes" : "");
          el("insp-seek-n").className = "btn" + (rs === "N" ? " active-no" : "");
          el("insp-data-y").className = "btn" + (ad === "Y" ? " active-yes" : "");
          el("insp-data-n").className = "btn" + (ad === "N" ? " active-no" : "");

          const b = badgeForEpisode(ep);
          const vb = el("card-verdict-badge");
          vb.className = b.cls;
          vb.textContent = b.text;

          const noteInput = el("note-input");
          if (document.activeElement !== noteInput) {
            noteInput.value = ep.label.note || "";
          }
          el("labels-path-readout").textContent = "File: " + state.labelsPath;

          // Seek Actions Table
          const seekTbody = el("seek-actions-tbody");
          seekTbody.innerHTML = "";
          for (const a of ep.seekActions) {
            const tr = document.createElement("tr");
            const tdKind = document.createElement("td");
            tdKind.className = "mono";
            tdKind.textContent = a.kind;
            const tdQuery = document.createElement("td");
            const divQ = document.createElement("div");
            divQ.className = "pre-wrap";
            divQ.textContent = a.query;
            tdQuery.appendChild(divQ);
            const tdUri = document.createElement("td");
            tdUri.className = "uri-text";
            tdUri.textContent = a.source + " · " + a.sourceUri;
            tr.appendChild(tdKind);
            tr.appendChild(tdQuery);
            tr.appendChild(tdUri);
            seekTbody.appendChild(tr);
          }

          // Context Events Table
          el("ctx-count-summary").textContent = ep.contextEvents.length + " events";
          const ctxTbody = el("context-events-tbody");
          ctxTbody.innerHTML = "";
          if (ep.contextEvents.length === 0) {
            const tr = document.createElement("tr");
            const td = document.createElement("td");
            td.colSpan = 3;
            td.style.color = "var(--text-2)";
            td.textContent = "No events recorded in the 10-minute context window before seekStartMs.";
            tr.appendChild(td);
            ctxTbody.appendChild(tr);
          } else {
            for (const c of ep.contextEvents) {
              const tr = document.createElement("tr");
              const tdTime = document.createElement("td");
              tdTime.className = "mono";
              tdTime.textContent = c.timeUtc;
              const tdSrc = document.createElement("td");
              tdSrc.className = "mono";
              tdSrc.textContent = c.source + (c.exit !== undefined ? " (exit=" + c.exit + ")" : "");
              const tdText = document.createElement("td");
              const divT = document.createElement("div");
              divT.className = "pre-wrap";
              divT.textContent = c.contentText;
              tdText.appendChild(divT);
              tr.appendChild(tdTime);
              tr.appendChild(tdSrc);
              tr.appendChild(tdText);
              ctxTbody.appendChild(tr);
            }
          }

          // Inspector Card 2: Top Local Hit
          if (ep.topHit) {
            el("hit-all-badge").className = "badge ok";
            el("hit-all-badge").textContent = ep.topHit.source + " · " + ep.topHit.timestampIso.slice(0, 10);
            el("hit-all-uri").textContent = ep.topHit.sourceUri;
            el("hit-all-quote").textContent = ep.topHit.fullText || ep.topHit.snippet;
          } else {
            el("hit-all-badge").className = "badge";
            el("hit-all-badge").textContent = "none";
            el("hit-all-uri").textContent = "";
            el("hit-all-quote").textContent = "No local hit before seekStartMs.";
          }

          // Inspector Card 3: Hit >1 Day Old + Resolution
          if (ep.topHitOlderThanDay) {
            el("hit-old-badge").className = "badge ok";
            el("hit-old-badge").textContent =
              ep.topHitOlderThanDay.source + " · " + ep.topHitOlderThanDay.timestampIso.slice(0, 10);
            el("hit-old-uri").textContent = ep.topHitOlderThanDay.sourceUri;
            el("hit-old-quote").textContent = ep.topHitOlderThanDay.fullText || ep.topHitOlderThanDay.snippet;
          } else {
            el("hit-old-badge").className = "badge";
            el("hit-old-badge").textContent = "none";
            el("hit-old-uri").textContent = "";
            el("hit-old-quote").textContent = "No local hit older than 1 day before seekStartMs.";
          }
          el("resolution-readout").textContent = "Resolution: " + ep.resolutionSummary;
        }

        function renderAll() {
          renderHeader();
          renderList();
          renderCenterAndInspector();
        }

        async function saveLabel(patch, mayAdvance = false) {
          const ep = currentEpisode();
          if (!ep) return;
          const ind = el("save-indicator");
          ind.textContent = "Saving...";
          ind.className = "badge warn";

          const nextLabel = {
            realSeeking: patch.realSeeking !== undefined ? patch.realSeeking : ep.label.realSeeking,
            answerInMyData: patch.answerInMyData !== undefined ? patch.answerInMyData : ep.label.answerInMyData,
            note: patch.note !== undefined ? patch.note : el("note-input").value,
          };

          const resp = await fetch("/api/episodes/" + encodeURIComponent(ep.episodeId) + "/label", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(nextLabel),
          });
          const data = await resp.json();
          if (data && data.ok) {
            ep.label = data.label;
            state.metrics = data.metrics;
            ind.textContent = "Saved";
            ind.className = "badge ok";
            if (
              mayAdvance &&
              el("chk-autonext").checked &&
              ep.label.realSeeking !== "" &&
              ep.label.answerInMyData !== ""
            ) {
              advanceNext();
            } else {
              renderAll();
            }
          } else {
            ind.textContent = "Save Error";
            ind.className = "badge no";
          }
        }

        function advanceNext() {
          if (!state || !state.episodes.length) return;
          // Prefer next unlabeled episode, else next index
          for (let offset = 1; offset <= state.episodes.length; offset++) {
            const idx = (selectedIdx + offset) % state.episodes.length;
            const candidate = state.episodes[idx];
            if (!candidate.label.realSeeking || !candidate.label.answerInMyData) {
              selectedIdx = idx;
              renderAll();
              return;
            }
          }
          selectedIdx = Math.min(state.episodes.length - 1, selectedIdx + 1);
          renderAll();
        }

        function goPrev() {
          if (!state || !state.episodes.length) return;
          selectedIdx = Math.max(0, selectedIdx - 1);
          renderAll();
        }

        function goNext() {
          if (!state || !state.episodes.length) return;
          selectedIdx = Math.min(state.episodes.length - 1, selectedIdx + 1);
          renderAll();
        }

        // Bind Action Rail & Inspector Buttons
        el("rail-seek-y").addEventListener("pointerup", () => saveLabel({ realSeeking: "Y" }, true));
        el("rail-seek-n").addEventListener("pointerup", () =>
          saveLabel({ realSeeking: "N", answerInMyData: currentEpisode()?.label.answerInMyData || "N" }, true),
        );
        el("rail-data-y").addEventListener("pointerup", () => saveLabel({ answerInMyData: "Y" }, true));
        el("rail-data-n").addEventListener("pointerup", () => saveLabel({ answerInMyData: "N" }, true));
        el("rail-both-y").addEventListener("pointerup", () =>
          saveLabel({ realSeeking: "Y", answerInMyData: "Y" }, true),
        );
        el("rail-clear").addEventListener("pointerup", () =>
          saveLabel({ realSeeking: "", answerInMyData: "", note: "" }, false),
        );

        el("insp-seek-y").addEventListener("pointerup", () => saveLabel({ realSeeking: "Y" }, true));
        el("insp-seek-n").addEventListener("pointerup", () =>
          saveLabel({ realSeeking: "N", answerInMyData: currentEpisode()?.label.answerInMyData || "N" }, true),
        );
        el("insp-data-y").addEventListener("pointerup", () => saveLabel({ answerInMyData: "Y" }, true));
        el("insp-data-n").addEventListener("pointerup", () => saveLabel({ answerInMyData: "N" }, true));

        el("btn-prev").addEventListener("pointerup", goPrev);
        el("btn-next").addEventListener("pointerup", goNext);

        el("note-input").addEventListener("change", () => {
          saveLabel({ note: el("note-input").value }, false);
        });
        el("note-input").addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            saveLabel({ note: el("note-input").value }, false);
            el("note-input").blur();
          }
        });

        for (const id of ["filter-all", "filter-unlabeled", "filter-labeled"]) {
          el(id).addEventListener("pointerup", () => {
            currentFilter = el(id).getAttribute("data-filter") || "all";
            for (const oid of ["filter-all", "filter-unlabeled", "filter-labeled"]) {
              el(oid).className = oid === id ? "btn primary" : "btn";
            }
            renderList();
          });
        }

        el("btn-reingest").addEventListener("pointerup", async () => {
          const ind = el("save-indicator");
          ind.textContent = "Ingesting...";
          ind.className = "badge warn";
          const r = await fetch("/api/reingest", { method: "POST" });
          const data = await r.json();
          if (data && data.ok) {
            state = data.state;
            ind.textContent = "Refreshed";
            ind.className = "badge ok";
            renderAll();
          } else {
            ind.textContent = "Ingest Error";
            ind.className = "badge no";
          }
        });

        el("btn-write-status").addEventListener("pointerup", async () => {
          const ind = el("save-indicator");
          ind.textContent = "Writing STATUS.md...";
          ind.className = "badge warn";
          const r = await fetch("/api/write-status", { method: "POST" });
          const data = await r.json();
          if (data && data.ok) {
            ind.textContent = "STATUS.md Written";
            ind.className = "badge ok";
          } else {
            ind.textContent = "Status Error";
            ind.className = "badge no";
          }
        });

        // Keyboard shortcuts when not typing in note input
        window.addEventListener("keydown", (e) => {
          if (document.activeElement === el("note-input")) return;
          if (e.target && e.target.tagName === "INPUT") return;
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          const k = e.key.toLowerCase();
          if (k === "j" || e.key === "ArrowDown") {
            e.preventDefault();
            goNext();
          } else if (k === "k" || e.key === "ArrowUp") {
            e.preventDefault();
            goPrev();
          } else if (k === "y") {
            e.preventDefault();
            saveLabel({ realSeeking: "Y" }, true);
          } else if (k === "n") {
            e.preventDefault();
            saveLabel({ realSeeking: "N", answerInMyData: currentEpisode()?.label.answerInMyData || "N" }, true);
          } else if (k === "d") {
            e.preventDefault();
            saveLabel({ answerInMyData: "Y" }, true);
          } else if (k === "m") {
            e.preventDefault();
            saveLabel({ answerInMyData: "N" }, true);
          } else if (e.key === "Enter") {
            e.preventDefault();
            saveLabel({ realSeeking: "Y", answerInMyData: "Y" }, true);
          }
        });

        // Draggable split-pane dividers (WORKBENCH-NATIVE-05)
        function wireDivider(divId, cssVar, isRight, defaultPx) {
          const div = el(divId);
          let dragging = false;
          div.addEventListener("pointerdown", (e) => {
            dragging = true;
            div.classList.add("dragging");
            div.setPointerCapture(e.pointerId);
          });
          div.addEventListener("pointermove", (e) => {
            if (!dragging) return;
            const raw = isRight ? window.innerWidth - e.clientX : e.clientX;
            const clamped = Math.max(220, Math.min(560, raw));
            document.documentElement.style.setProperty(cssVar, clamped + "px");
          });
          div.addEventListener("pointerup", () => {
            dragging = false;
            div.classList.remove("dragging");
          });
          div.addEventListener("dblclick", () => {
            document.documentElement.style.setProperty(cssVar, defaultPx + "px");
          });
        }
        wireDivider("divider-left", "--left-w", false, 300);
        wireDivider("divider-right", "--right-w", true, 380);

        // Initial load
        fetch("/api/state")
          .then((r) => r.json())
          .then((data) => {
            state = data;
            renderAll();
          });
      })();
    </script>
  </body>
</html>`;
}
