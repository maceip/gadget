// De Minimis 2-Row Skypanel HUD Surface (`src/web/skypanel_ui.ts`).
//
// Renders at most 1–3 verified, high-value Skypanel cards on the active surface
// (Desktop HUD, Browser Overlay, or Mobile Sheet):
//   Row 1: [ {source modality icons}   <2-5 word nugget label>   {target app icons} ]
//   Row 2: [                {revise}   {mode: app | agent}       {go go gadget}     ]
//
// Zero hardcoded contacts/names, zero table-layout:fixed, and every control is
// backed by real SQLite state via /api/skypanel/*.

export function renderSkypanelHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>gogogadget · Skypanel HUD</title>
    <style>
      :root {
        color-scheme: dark;
        --bg-void: #060911;
        --bg-hud: rgba(15, 23, 42, 0.92);
        --bg-card: #0f172a;
        --bg-elevated: #1e293b;
        --border-subtle: #1e293b;
        --border-focus: #3b82f6;
        --text-primary: #f8fafc;
        --text-secondary: #cbd5e1;
        --text-muted: #94a3b8;
        --accent-blue: #3b82f6;
        --accent-emerald: #10b981;
        --accent-amber: #f59e0b;
      }
      * {
        box-sizing: border-box;
      }
      html,
      body {
        margin: 0;
        padding: 0;
        width: 100%;
        min-height: 100vh;
        background: var(--bg-void);
        color: var(--text-primary);
        font: 14px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", sans-serif;
      }
      .mono {
        font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
      }
      .skypanel-shell {
        max-width: 680px;
        margin: 0 auto;
        padding: 16px 14px 40px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      /* Compact top status & utterance bar */
      .hud-topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 12px;
        background: var(--bg-hud);
        border: 1px solid var(--border-subtle);
        border-radius: 12px;
        flex-wrap: wrap;
      }
      .brand-cluster {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .pulse-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--accent-emerald);
        box-shadow: 0 0 8px var(--accent-emerald);
      }
      .brand-title {
        font-weight: 600;
        font-size: 13px;
        letter-spacing: 0.01em;
      }
      .surface-pills {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .surface-pill {
        height: 24px;
        padding: 0 8px;
        border-radius: 999px;
        border: 1px solid var(--border-subtle);
        background: transparent;
        color: var(--text-muted);
        font-size: 11px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
      }
      .surface-pill.active {
        background: rgba(59, 130, 246, 0.16);
        border-color: var(--accent-blue);
        color: var(--text-primary);
      }
      /* Utterance Trigger Bar */
      .utterance-bar {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 12px;
        background: var(--bg-card);
        border: 1px solid var(--border-subtle);
        border-radius: 12px;
      }
      .prefix-chips {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .prefix-chip {
        height: 22px;
        padding: 0 8px;
        border-radius: 6px;
        border: 1px solid #334155;
        background: var(--bg-elevated);
        color: var(--text-secondary);
        font-size: 11px;
        cursor: pointer;
      }
      .prefix-chip:hover {
        border-color: var(--accent-blue);
        color: var(--text-primary);
      }
      .utterance-input-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .utterance-input {
        flex: 1;
        min-width: 180px;
        height: 34px;
        padding: 0 10px;
        border-radius: 8px;
        border: 1px solid #334155;
        background: var(--bg-void);
        color: var(--text-primary);
        font-size: 13px;
      }
      .utterance-input:focus {
        outline: none;
        border-color: var(--accent-blue);
      }
      .btn-trigger {
        height: 34px;
        padding: 0 12px;
        border-radius: 8px;
        border: 1px solid var(--accent-blue);
        background: #1d4ed8;
        color: #ffffff;
        font-weight: 600;
        font-size: 12px;
        cursor: pointer;
        white-space: nowrap;
      }
      /* De Minimis 2-Row Skypanel Cards Stack (Max 1-3) */
      .skypanel-stack {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .skypanel-card {
        background: var(--bg-card);
        border: 1px solid #334155;
        border-radius: 14px;
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
      }
      .skypanel-card.dispatched {
        border-color: var(--accent-emerald);
      }
      /* ROW 1: [ {source icons}   nugget label   {target icons} ] */
      .card-row-1 {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        min-height: 32px;
      }
      .icon-cluster {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
      }
      .mod-icon {
        width: 28px;
        height: 28px;
        border-radius: 7px;
        background: var(--bg-elevated);
        border: 1px solid #334155;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--text-primary);
      }
      .mod-icon svg {
        width: 16px;
        height: 16px;
      }
      .mod-icon.icon-android {
        color: #34d399;
        border-color: rgba(52, 211, 153, 0.35);
      }
      .mod-icon.icon-messages {
        color: #60a5fa;
        border-color: rgba(96, 165, 250, 0.35);
      }
      .mod-icon.icon-calendar {
        color: #f87171;
        border-color: rgba(248, 113, 113, 0.35);
      }
      .mod-icon.icon-agent {
        color: #c084fc;
        border-color: rgba(192, 132, 252, 0.35);
      }
      .nugget-label-wrap {
        flex: 1;
        min-width: 140px;
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
      }
      .nugget-label {
        width: 100%;
        text-align: center;
        font-size: 15px;
        font-weight: 600;
        color: var(--text-primary);
        letter-spacing: -0.01em;
        word-break: normal;
        overflow-wrap: break-word;
      }
      .nugget-sub {
        font-size: 11px;
        color: var(--text-muted);
        margin-top: 2px;
      }
      /* ROW 2: [ {revise}   {mode: app | agent}   {go go gadget} ] */
      .card-row-2 {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        flex-wrap: wrap;
        padding-top: 6px;
        border-top: 1px solid var(--border-subtle);
      }
      .btn-hud {
        height: 30px;
        padding: 0 11px;
        border-radius: 8px;
        border: 1px solid #334155;
        background: var(--bg-elevated);
        color: var(--text-secondary);
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        white-space: nowrap;
      }
      .btn-hud:hover {
        border-color: #64748b;
        color: var(--text-primary);
      }
      .mode-switch {
        display: inline-flex;
        align-items: center;
        background: var(--bg-void);
        border: 1px solid #334155;
        border-radius: 8px;
        padding: 2px;
        gap: 2px;
      }
      .mode-option {
        height: 24px;
        padding: 0 8px;
        border-radius: 6px;
        border: none;
        background: transparent;
        color: var(--text-muted);
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
      }
      .mode-option.active {
        background: var(--bg-elevated);
        color: var(--text-primary);
        border: 1px solid var(--accent-blue);
      }
      .btn-gogogadget {
        height: 30px;
        padding: 0 13px;
        border-radius: 8px;
        border: 1px solid #10b981;
        background: linear-gradient(180deg, #059669 0%, #047857 100%);
        color: #ffffff;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
      }
      .btn-gogogadget:hover {
        filter: brightness(1.08);
      }
      .btn-dismiss {
        width: 26px;
        height: 26px;
        border-radius: 6px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--text-muted);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .btn-dismiss:hover {
        background: var(--bg-elevated);
        color: var(--text-primary);
      }
      /* Inline Revise Drawer */
      .revise-drawer {
        display: none;
        align-items: center;
        gap: 8px;
        padding-top: 6px;
      }
      .revise-drawer.open {
        display: flex;
      }
      .revise-input {
        flex: 1;
        height: 30px;
        padding: 0 9px;
        border-radius: 7px;
        border: 1px solid #475569;
        background: var(--bg-void);
        color: var(--text-primary);
        font-size: 12px;
      }
      /* Verified Context & Execution Receipt Drawer */
      .context-drawer {
        font-size: 12px;
        color: var(--text-secondary);
        background: rgba(6, 9, 17, 0.65);
        border: 1px solid var(--border-subtle);
        border-radius: 8px;
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .receipt-banner {
        font-size: 12px;
        color: #6ee7b7;
        background: rgba(5, 46, 22, 0.7);
        border: 1px solid #14532d;
        border-radius: 8px;
        padding: 8px 10px;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .empty-hud {
        padding: 24px 16px;
        text-align: center;
        color: var(--text-muted);
        border: 1px dashed var(--border-subtle);
        border-radius: 12px;
        font-size: 13px;
      }
      @media (max-width: 480px) {
        .card-row-2 {
          justify-content: space-between;
        }
      }
    </style>
  </head>
  <body>
    <main class="skypanel-shell" id="skypanel-root">
      <header class="hud-topbar">
        <div class="brand-cluster">
          <span class="pulse-dot" aria-hidden="true"></span>
          <span class="brand-title">gogogadget · skypanel</span>
          <span class="mono" id="hud-budget-badge" style="font-size:11px;color:var(--text-muted)">0 / 3 cards</span>
        </div>
        <div class="surface-pills" role="group" aria-label="Active Surface">
          <button type="button" class="surface-pill active" data-surface="desktop" id="surf-desktop">Desktop HUD</button>
          <button type="button" class="surface-pill" data-surface="browser" id="surf-browser">Browser</button>
          <button type="button" class="surface-pill" data-surface="mobile" id="surf-mobile">Mobile</button>
        </div>
      </header>

      <section class="utterance-bar" aria-label="Utterance Trigger">
        <div class="prefix-chips">
          <span style="font-size:11px;color:var(--text-muted)">Prefixes:</span>
          <button type="button" class="prefix-chip" data-prefix="Hey Gadget, ">Hey Gadget</button>
          <button type="button" class="prefix-chip" data-prefix="Note to self, ">Note to self</button>
          <button type="button" class="prefix-chip" data-prefix="Mental note, ">Mental note</button>
          <button type="button" class="prefix-chip" data-prefix="FYI, ">FYI</button>
          <button type="button" class="prefix-chip" data-prefix="PSA, ">PSA</button>
          <button type="button" class="prefix-chip" data-prefix="Remind me to ">Remind me</button>
        </div>
        <div class="utterance-input-row">
          <input
            id="utterance-input"
            class="utterance-input"
            type="text"
            placeholder="Speak or type with a prefix (e.g. Hey Gadget / Note to self / FYI...)"
            aria-label="Utterance Input"
          />
          <button type="button" id="btn-trigger-utterance" class="btn-trigger">Trigger Spine</button>
        </div>
      </section>

      <section id="skypanel-stack" class="skypanel-stack" aria-live="polite"></section>
    </main>

    <script>
      (() => {
        const el = (id) => document.getElementById(id);
        let cards = [];
        let activeSurface = "desktop";

        const ICON_SVGS = {
          android: {
            title: "Android SMS",
            svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 16V10a7 7 0 0 1 14 0v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Z"/><path d="m8 3 1.5 2.5"/><path d="m16 3-1.5 2.5"/><circle cx="9.5" cy="11" r="1"/><circle cx="14.5" cy="11" r="1"/></svg>',
          },
          messages: {
            title: "Messages.app",
            svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/></svg>',
          },
          calendar: {
            title: "Calendar.app",
            svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
          },
          chrome: {
            title: "Browser",
            svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="21.17" y1="8" x2="12" y2="8"/></svg>',
          },
          terminal: {
            title: "Terminal",
            svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
          },
          github: {
            title: "Git / Repo",
            svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>',
          },
          docs: {
            title: "Document",
            svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
          },
          mic: {
            title: "Voice Utterance",
            svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>',
          },
          timer: {
            title: "Timer",
            svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M10 2h4"/></svg>',
          },
          recall: {
            title: "Memory Recall",
            svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
          },
          agent: {
            title: "Action Agent",
            svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
          },
        };

        function createIconBadge(iconId) {
          const spec = ICON_SVGS[iconId] || ICON_SVGS.agent;
          const span = document.createElement("span");
          span.className = "mod-icon icon-" + iconId;
          span.setAttribute("title", spec.title);
          span.setAttribute("data-icon", iconId);
          span.innerHTML = spec.svg;
          return span;
        }

        function renderCards() {
          const stack = el("skypanel-stack");
          stack.innerHTML = "";
          el("hud-budget-badge").textContent = cards.length + " / 3 cards";

          if (cards.length === 0) {
            const empty = document.createElement("div");
            empty.className = "empty-hud";
            empty.textContent =
              "Skypanel quiet — listening for spoken prefixes ('Hey Gadget', 'Note to self', 'FYI') or high-confidence proactive recall.";
            stack.appendChild(empty);
            return;
          }

          for (const card of cards) {
            const cardEl = document.createElement("article");
            cardEl.className = "skypanel-card" + (card.status === "DISPATCHED" ? " dispatched" : "");
            cardEl.setAttribute("data-card-id", card.cardId);

            // ROW 1: [ {source icons}   compact nugget label   {target icons} ]
            const row1 = document.createElement("div");
            row1.className = "card-row-1";

            const leftIcons = document.createElement("div");
            leftIcons.className = "icon-cluster source-icons";
            for (const ic of card.sourceIcons || ["mic"]) {
              leftIcons.appendChild(createIconBadge(ic));
            }

            const centerWrap = document.createElement("div");
            centerWrap.className = "nugget-label-wrap";
            const titleEl = document.createElement("div");
            titleEl.className = "nugget-label";
            titleEl.textContent = card.compactLabel;
            const subEl = document.createElement("div");
            subEl.className = "nugget-sub";
            subEl.textContent = card.proposedTimeLabel
              ? card.proposedTimeLabel + " · " + card.inferredWorkingHours
              : card.contextSummary.slice(0, 72);
            centerWrap.appendChild(titleEl);
            centerWrap.appendChild(subEl);

            const rightIcons = document.createElement("div");
            rightIcons.className = "icon-cluster target-icons";
            for (const ic of card.targetIcons || ["agent"]) {
              rightIcons.appendChild(createIconBadge(ic));
            }

            const dismissBtn = document.createElement("button");
            dismissBtn.type = "button";
            dismissBtn.className = "btn-dismiss";
            dismissBtn.setAttribute("aria-label", "Dismiss card");
            dismissBtn.textContent = "×";
            dismissBtn.addEventListener("pointerup", () => dismissCard(card.cardId));
            rightIcons.appendChild(dismissBtn);

            row1.appendChild(leftIcons);
            row1.appendChild(centerWrap);
            row1.appendChild(rightIcons);
            cardEl.appendChild(row1);

            // Context summary box
            const ctxBox = document.createElement("div");
            ctxBox.className = "context-drawer";
            const ctxLine = document.createElement("div");
            ctxLine.textContent = card.contextSummary;
            ctxBox.appendChild(ctxLine);
            if (card.stagedReply) {
              const replyLine = document.createElement("div");
              replyLine.className = "mono";
              replyLine.style.fontSize = "11px";
              replyLine.style.color = "#93c5fd";
              replyLine.textContent = 'Staged draft: "' + card.stagedReply + '"';
              ctxBox.appendChild(replyLine);
            }
            cardEl.appendChild(ctxBox);

            // Execution receipt banner when DISPATCHED
            if (card.agentReceipt) {
              const recBanner = document.createElement("div");
              recBanner.className = "receipt-banner mono";
              recBanner.setAttribute("data-testid", "execution-receipt");
              recBanner.textContent =
                "DISPATCHED (" +
                card.agentReceipt.mode.toUpperCase() +
                "): " +
                card.agentReceipt.summary +
                " -> " +
                (card.dispatchedPaths[0] || "");
              cardEl.appendChild(recBanner);
            }

            // Inline Revise Drawer
            const revDrawer = document.createElement("div");
            revDrawer.className = "revise-drawer";
            const revInput = document.createElement("input");
            revInput.type = "text";
            revInput.className = "revise-input";
            revInput.placeholder = "Revise time, contact, or instruction (e.g. move to Thursday 2pm)...";
            const revApplyBtn = document.createElement("button");
            revApplyBtn.type = "button";
            revApplyBtn.className = "btn-hud";
            revApplyBtn.textContent = "Apply Revision";
            revApplyBtn.addEventListener("pointerup", () => {
              if (revInput.value.trim()) {
                reviseCard(card.cardId, revInput.value.trim());
              }
            });
            revInput.addEventListener("keydown", (e) => {
              if (e.key === "Enter" && revInput.value.trim()) {
                reviseCard(card.cardId, revInput.value.trim());
              }
            });
            revDrawer.appendChild(revInput);
            revDrawer.appendChild(revApplyBtn);
            cardEl.appendChild(revDrawer);

            // ROW 2: [ {revise}   {mode: app | agent}   {go go gadget} ]
            const row2 = document.createElement("div");
            row2.className = "card-row-2";

            const reviseBtn = document.createElement("button");
            reviseBtn.type = "button";
            reviseBtn.className = "btn-hud btn-revise";
            reviseBtn.textContent = "revise";
            reviseBtn.addEventListener("pointerup", () => {
              revDrawer.classList.toggle("open");
            });

            const modeSwitch = document.createElement("div");
            modeSwitch.className = "mode-switch";
            modeSwitch.setAttribute("role", "group");
            modeSwitch.setAttribute("aria-label", "Execution Mode");

            const modeAppBtn = document.createElement("button");
            modeAppBtn.type = "button";
            modeAppBtn.className = "mode-option mode-app" + (card.selectedMode === "app" ? " active" : "");
            modeAppBtn.textContent = "Mode 1: App";
            modeAppBtn.addEventListener("pointerup", () => setCardMode(card.cardId, "app"));

            const modeAgentBtn = document.createElement("button");
            modeAgentBtn.type = "button";
            modeAgentBtn.className = "mode-option mode-agent" + (card.selectedMode === "agent" ? " active" : "");
            modeAgentBtn.textContent = "Mode 2: Agent";
            modeAgentBtn.addEventListener("pointerup", () => setCardMode(card.cardId, "agent"));

            modeSwitch.appendChild(modeAppBtn);
            modeSwitch.appendChild(modeAgentBtn);

            const gogoBtn = document.createElement("button");
            gogoBtn.type = "button";
            gogoBtn.className = "btn-gogogadget";
            gogoBtn.textContent = card.status === "DISPATCHED" ? "re-run go go gadget" : "go go gadget";
            gogoBtn.addEventListener("pointerup", () => executeCard(card.cardId, card.selectedMode));

            row2.appendChild(reviseBtn);
            row2.appendChild(modeSwitch);
            row2.appendChild(gogoBtn);
            cardEl.appendChild(row2);

            stack.appendChild(cardEl);
          }
        }

        async function loadSkypanel() {
          const resp = await fetch("/api/skypanel?surface=" + encodeURIComponent(activeSurface));
          const data = await resp.json();
          if (data && Array.isArray(data.cards)) {
            cards = data.cards;
            renderCards();
          }
        }

        async function triggerUtterance(text) {
          const clean = text.trim();
          if (!clean) return;
          const resp = await fetch("/api/skypanel/utterance", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ utterance: clean }),
          });
          const data = await resp.json();
          if (data && Array.isArray(data.visibleCards)) {
            cards = data.visibleCards;
            el("utterance-input").value = "";
            renderCards();
          }
        }

        async function setCardMode(cardId, mode) {
          const resp = await fetch("/api/skypanel/" + encodeURIComponent(cardId) + "/mode", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode }),
          });
          const data = await resp.json();
          if (data && Array.isArray(data.visibleCards)) {
            cards = data.visibleCards;
            renderCards();
          }
        }

        async function reviseCard(cardId, instruction) {
          const resp = await fetch("/api/skypanel/" + encodeURIComponent(cardId) + "/revise", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ instruction }),
          });
          const data = await resp.json();
          if (data && Array.isArray(data.visibleCards)) {
            cards = data.visibleCards;
            renderCards();
          }
        }

        async function executeCard(cardId, mode) {
          const resp = await fetch("/api/skypanel/" + encodeURIComponent(cardId) + "/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode }),
          });
          const data = await resp.json();
          if (data && Array.isArray(data.visibleCards)) {
            cards = data.visibleCards;
            renderCards();
          }
        }

        async function dismissCard(cardId) {
          const resp = await fetch("/api/skypanel/" + encodeURIComponent(cardId) + "/dismiss", {
            method: "POST",
          });
          const data = await resp.json();
          if (data && Array.isArray(data.visibleCards)) {
            cards = data.visibleCards;
            renderCards();
          }
        }

        // Bind Prefix Chips
        document.querySelectorAll(".prefix-chip").forEach((chip) => {
          chip.addEventListener("pointerup", () => {
            const p = chip.getAttribute("data-prefix") || "";
            const inp = el("utterance-input");
            inp.value = p + inp.value.replace(/^(?:hey gadget|note to self|mental note|fyi|psa|remind me to)[,\\s]*/i, "");
            inp.focus();
          });
        });

        // Bind Surface Switcher Pills
        document.querySelectorAll(".surface-pill").forEach((pill) => {
          pill.addEventListener("pointerup", () => {
            activeSurface = pill.getAttribute("data-surface") || "desktop";
            document.querySelectorAll(".surface-pill").forEach((p) => {
              p.classList.toggle("active", p === pill);
            });
            loadSkypanel();
          });
        });

        el("btn-trigger-utterance").addEventListener("pointerup", () => {
          triggerUtterance(el("utterance-input").value);
        });
        el("utterance-input").addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            triggerUtterance(el("utterance-input").value);
          }
        });

        loadSkypanel();
      })();
    </script>
  </body>
</html>`;
}
