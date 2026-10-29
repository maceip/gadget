// Gadget Ambient Recall Capture — Chrome MV3 Content Script
// Strictly read-only DOM observer (AGENTS.md section 4):
// "A browser extension, if built, reads the DOM only: no clicks, input events, or form submits."
// All network transmission to 127.0.0.1:4321 happens in the background service worker so HTTPS
// pages never trigger Mixed Content / Private Network Access errors.

(() => {
  function extractSearchQuery() {
    try {
      const u = new URL(window.location.href);
      return (
        u.searchParams.get("q") ||
        u.searchParams.get("query") ||
        u.searchParams.get("search") ||
        u.searchParams.get("p") ||
        ""
      );
    } catch {
      return "";
    }
  }

  function sendToBackground(payload) {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      return;
    }
    try {
      chrome.runtime.sendMessage({
        type: "GADGET_BROWSER_EVENT",
        payload: {
          ...payload,
          url: window.location.href,
          title: document.title || window.location.href,
          timestampMs: Date.now(),
        },
      });
    } catch {
      // Extension context invalidated on reload; ignore cleanly.
    }
  }

  function emitPageView() {
    if (!window.location.href.startsWith("http://") && !window.location.href.startsWith("https://")) {
      return;
    }
    const visibleText =
      document.body && typeof document.body.innerText === "string"
        ? document.body.innerText.slice(0, 1500)
        : "";

    sendToBackground({
      type: "PAGE_VIEW",
      visibleText,
      searchQuery: extractSearchQuery(),
    });
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    emitPageView();
  } else {
    window.addEventListener("DOMContentLoaded", emitPageView, { once: true });
  }

  window.addEventListener("popstate", emitPageView);
  window.addEventListener("hashchange", emitPageView);

  // Read-only text selection capture on mouseup (no input or keydown listeners).
  let lastSelection = "";
  document.addEventListener(
    "mouseup",
    () => {
      try {
        const sel = window.getSelection ? String(window.getSelection().toString()).trim() : "";
        if (sel && sel.length >= 3 && sel !== lastSelection) {
          lastSelection = sel;
          sendToBackground({
            type: "TEXT_SELECTION",
            selectedText: sel.slice(0, 800),
          });
        }
      } catch {
        // Ignore selection errors.
      }
    },
    true,
  );
})();
