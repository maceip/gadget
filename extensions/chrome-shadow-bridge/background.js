// Gadget Ambient Recall Capture — Chrome MV3 Background Service Worker
// Read-only browser capture (AGENTS.md section 4): forwards page visits, search terms,
// read-only DOM text excerpts, and Chrome History API sync to the local Gadget server
// on 127.0.0.1:4321 (never to external hosts).

const DEFAULT_SERVER_BASE = "http://127.0.0.1:4321";
let serverBase = DEFAULT_SERVER_BASE;

function isLoopbackUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function resolveCaptureUrl(overrideUrl) {
  if (typeof overrideUrl === "string" && isLoopbackUrl(overrideUrl)) {
    try {
      const u = new URL(overrideUrl);
      serverBase = `${u.protocol}//${u.host}`;
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ gadgetServerBase: serverBase }).catch(() => {});
      }
      if (u.pathname && u.pathname !== "/") {
        return overrideUrl;
      }
    } catch {
      // ignore
    }
  }
  return `${serverBase}/api/capture/chrome`;
}

if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
  chrome.storage.local.get(["gadgetServerBase"], (res) => {
    if (res && typeof res.gadgetServerBase === "string" && isLoopbackUrl(res.gadgetServerBase)) {
      serverBase = res.gadgetServerBase;
    }
  });
}

async function postCaptureBatch(events, overrideUrl) {
  const targetUrl = resolveCaptureUrl(overrideUrl);
  if (!isLoopbackUrl(targetUrl)) {
    return { ok: false, error: "refusing non-loopback capture endpoint", targetUrl };
  }
  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
      keepalive: true,
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, targetUrl, ...data };
  } catch (err) {
    return { ok: false, error: String(err), targetUrl };
  }
}

async function syncChromeHistory(maxResults = 2000) {
  if (typeof chrome === "undefined" || !chrome.history || !chrome.history.search) {
    return { ok: false, error: "chrome.history API unavailable" };
  }
  try {
    const items = await chrome.history.search({
      text: "",
      startTime: 0,
      maxResults,
    });
    const events = [];
    for (const item of items) {
      if (!item || typeof item.url !== "string") continue;
      if (!item.url.startsWith("http://") && !item.url.startsWith("https://")) continue;
      const timestampMs = typeof item.lastVisitTime === "number" ? Math.round(item.lastVisitTime) : Date.now();
      events.push({
        type: "HISTORY_VISIT",
        url: item.url,
        title: item.title || item.url,
        timestampMs,
        visitCount: item.visitCount || 1,
      });
    }
    if (events.length === 0) {
      return { ok: true, synced: 0 };
    }
    const res = await postCaptureBatch(events);
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local
        .set({
          gadgetLastSyncMs: Date.now(),
          gadgetLastSyncCount: events.length,
        })
        .catch(() => {});
    }
    return { ...res, synced: events.length };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

if (typeof chrome !== "undefined" && chrome.runtime) {
  if (chrome.runtime.onInstalled) {
    chrome.runtime.onInstalled.addListener(() => {
      syncChromeHistory(2000).catch(() => {});
    });
  }
  if (chrome.runtime.onStartup) {
    chrome.runtime.onStartup.addListener(() => {
      syncChromeHistory(1000).catch(() => {});
    });
  }

  if (chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message !== "object") {
        sendResponse({ ok: false, reason: "invalid_message" });
        return false;
      }

      if (message.type === "GADGET_SET_SHADOW_URL" && typeof message.endpointUrl === "string") {
        const updated = resolveCaptureUrl(message.endpointUrl);
        sendResponse({ ok: true, endpointUrl: updated, serverBase });
        return false;
      }

      if (message.type === "GADGET_SYNC_HISTORY") {
        const maxResults = typeof message.maxResults === "number" ? message.maxResults : 2500;
        syncChromeHistory(maxResults)
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }

      if (message.type === "GADGET_GET_STATUS") {
        fetch(`${serverBase}/api/status`)
          .then(async (r) => {
            const json = await r.json();
            sendResponse({ ok: r.ok, serverBase, status: json });
          })
          .catch((err) => sendResponse({ ok: false, serverBase, error: String(err) }));
        return true;
      }

      if (message.type === "GADGET_CAPTURE_ACTIVE_TAB") {
        chrome.tabs
          .query({ active: true, currentWindow: true })
          .then(async (tabs) => {
            const tab = tabs && tabs[0];
            if (!tab || !tab.url || (!tab.url.startsWith("http://") && !tab.url.startsWith("https://"))) {
              sendResponse({ ok: false, error: "Active tab is not an http(s) page" });
              return;
            }
            const res = await postCaptureBatch([
              {
                type: "PAGE_VIEW",
                url: tab.url,
                title: tab.title || tab.url,
                timestampMs: Date.now(),
              },
            ]);
            sendResponse(res);
          })
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }

      const rawPayload = message.payload && typeof message.payload === "object" ? message.payload : message;
      const endpointUrl = message.endpointUrl || rawPayload.endpointUrl;
      const enriched = {
        ...rawPayload,
        url: rawPayload.url || (sender && sender.tab ? sender.tab.url : ""),
        title: rawPayload.title || (sender && sender.tab ? sender.tab.title : ""),
        timestampMs:
          typeof rawPayload.timestampMs === "number"
            ? rawPayload.timestampMs
            : typeof rawPayload.timestamp === "number"
              ? rawPayload.timestamp
              : Date.now(),
      };

      postCaptureBatch([enriched], endpointUrl)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));

      return true;
    });
  }
}

if (typeof chrome !== "undefined" && chrome.history && chrome.history.onVisited) {
  chrome.history.onVisited.addListener((item) => {
    if (!item || typeof item.url !== "string") return;
    if (!item.url.startsWith("http://") && !item.url.startsWith("https://")) return;
    postCaptureBatch([
      {
        type: "HISTORY_VISIT",
        url: item.url,
        title: item.title || item.url,
        timestampMs: typeof item.lastVisitTime === "number" ? Math.round(item.lastVisitTime) : Date.now(),
      },
    ]).catch(() => {});
  });
}

if (typeof chrome !== "undefined" && chrome.tabs) {
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (!tab || !tab.url || (!tab.url.startsWith("http://") && !tab.url.startsWith("https://"))) {
      return;
    }
    if (changeInfo.status === "complete") {
      postCaptureBatch([
        {
          type: "TAB_UPDATED",
          url: tab.url,
          title: tab.title || tab.url,
          timestampMs: Date.now(),
        },
      ]).catch(() => {});
    }
  });
}
