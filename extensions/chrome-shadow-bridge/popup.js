// Gadget Ambient Recall Capture — Popup Controller
(() => {
  const connPill = document.getElementById("conn-pill");
  const chromeCount = document.getElementById("chrome-count");
  const zshCount = document.getElementById("zsh-count");
  const labelCount = document.getElementById("label-count");
  const feedback = document.getElementById("feedback");
  const btnSync = document.getElementById("btn-sync");
  const btnTab = document.getElementById("btn-tab");

  function refreshStatus() {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) return;
    chrome.runtime.sendMessage({ type: "GADGET_GET_STATUS" }, (res) => {
      if (!res || !res.ok || !res.status) {
        connPill.textContent = "Offline";
        connPill.className = "pill err";
        feedback.textContent = "Start workbench: npm run web";
        return;
      }
      connPill.textContent = "127.0.0.1:4321";
      connPill.className = "pill ok";
      const st = res.status;
      chromeCount.textContent = String(st.chromeCaptureLines ?? 0);
      zshCount.textContent = String(st.zshCaptureLines ?? 0);
      labelCount.textContent = `${st.labeledCount ?? 0} / ${st.totalSampled ?? 25}`;
    });
  }

  btnSync.addEventListener("pointerup", () => {
    feedback.textContent = "Syncing Chrome history...";
    chrome.runtime.sendMessage({ type: "GADGET_SYNC_HISTORY", maxResults: 2500 }, (res) => {
      if (res && res.ok) {
        feedback.textContent = `Synced ${res.synced ?? 0} visits (${res.appended ?? 0} new).`;
        refreshStatus();
      } else {
        feedback.textContent = `Sync failed: ${(res && res.error) || "server unreachable"}`;
      }
    });
  });

  btnTab.addEventListener("pointerup", () => {
    feedback.textContent = "Capturing active tab...";
    chrome.runtime.sendMessage({ type: "GADGET_CAPTURE_ACTIVE_TAB" }, (res) => {
      if (res && res.ok) {
        feedback.textContent = "Captured active tab.";
        refreshStatus();
      } else {
        feedback.textContent = `Capture failed: ${(res && res.error) || "unknown error"}`;
      }
    });
  });

  refreshStatus();
})();
