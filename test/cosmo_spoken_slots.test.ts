import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeEvent } from "../src/miner/event.js";
import { withSeeks } from "../src/miner/seek.js";
import { EventStore } from "../src/miner/store.js";
import { BriefWorkspaceSink, renderSidecarBrief } from "../src/runtime/sink.js";
import {
  classifyCosmoSlots,
  extractSpokenSlotFromEvent,
  matchSpokenTriggerPrefix,
  SPOKEN_TRIGGER_PREFIXES,
} from "../src/triggers/cosmo_spoken_slots.js";

describe("Cosmo Spoken Commitment & Gatekeeper Slot Engine", () => {
  it("supports 'Hey Gadget' for alone use AND human-safe non-'Hey' prefixes for around other humans", () => {
    const aloneMatch = matchSpokenTriggerPrefix("Hey Gadget, don't forget about your court case on Wednesday");
    assert.ok(aloneMatch);
    assert.equal(aloneMatch.spec.id, "hey_gadget");
    assert.equal(aloneMatch.spec.socialMode, "alone_wake_word");
    assert.equal(aloneMatch.bodyText, "don't forget about your court case on Wednesday");

    const humanSafeCases: Array<{ input: string; expectedId: string; expectedMode: string }> = [
      {
        input: "Note to self, don't forget about your court case on Wednesday",
        expectedId: "note_to_self",
        expectedMode: "human_safe_self_note",
      },
      {
        input: "Mental note, send the brief by Friday at 5pm",
        expectedId: "mental_note",
        expectedMode: "human_safe_self_note",
      },
      {
        input: "FYI, food time at 6pm",
        expectedId: "fyi",
        expectedMode: "human_safe_acronym",
      },
      {
        input: "PSA, deploy freeze starts tomorrow morning",
        expectedId: "psa",
        expectedMode: "human_safe_acronym",
      },
      {
        input: "Bookmark, check this GitHub issue later tonight",
        expectedId: "bookmark",
        expectedMode: "human_safe_self_note",
      },
      {
        input: "Lock it in, court hearing next Tuesday at 9am",
        expectedId: "lock_it_in",
        expectedMode: "human_safe_self_note",
      },
      {
        input: "Remind me to call the clerk tomorrow morning",
        expectedId: "remind_me",
        expectedMode: "human_safe_self_note",
      },
      {
        input: "ADR, go make me some cheeseburgers",
        expectedId: "adr",
        expectedMode: "human_safe_acronym",
      },
    ];

    for (const tc of humanSafeCases) {
      const m = matchSpokenTriggerPrefix(tc.input);
      assert.ok(m, `Expected prefix match for: ${tc.input}`);
      assert.equal(m.spec.id, tc.expectedId);
      assert.equal(m.spec.socialMode, tc.expectedMode);
    }

    // Ordinary conversation without a prefix must NOT trigger
    assert.equal(matchSpokenTriggerPrefix("Yeah I think we should grab lunch soon"), null);
  });

  it("classifies utterances across Cosmo's multi-head gatekeeper slots (Tasks, Timers, TBCs, Recall, Event/Person context)", () => {
    // 1. Task: "go make me some cheeseburgers"
    const taskRes = classifyCosmoSlots("go make me some cheeseburgers");
    assert.equal(taskRes.primarySlot, "ADD_TASK");
    assert.ok(taskRes.allSlots.includes("ADD_TASK"));
    assert.ok(taskRes.allSlots.includes("ADD_TO_MEMORY"));

    // 2. Timer: "food time in 20 minutes"
    const timerRes = classifyCosmoSlots("food time in 20 minutes");
    assert.equal(timerRes.primarySlot, "ADD_TIMER");
    assert.ok(timerRes.allSlots.includes("ADD_TIMER"));
    assert.ok(timerRes.allSlots.includes("CREATE_CALENDAR_EVENT"));
    assert.equal(timerRes.isTimeBoundCommitment, true);

    // 3. Time-bound event commitment: "don't forget about your court case on Wednesday"
    const courtRes = classifyCosmoSlots("don't forget about your court case on Wednesday");
    assert.equal(courtRes.primarySlot, "CREATE_CALENDAR_EVENT");
    assert.ok(courtRes.allSlots.includes("PROVIDE_EVENT_CONTEXT"));
    assert.ok(courtRes.allSlots.includes("ADD_TASK"));
    assert.equal(courtRes.extractedTimeText?.toLowerCase(), "on wednesday");
    assert.equal(courtRes.isTimeBoundCommitment, true);

    // 4. ProvideRecall (hasProvideRecallIntent): "what did I say two weeks ago about the court case?"
    const recallRes = classifyCosmoSlots("what did I say two weeks ago about the court case?");
    assert.equal(recallRes.primarySlot, "PROVIDE_RECALL");
    assert.ok(recallRes.allSlots.includes("PROVIDE_RECALL"));
    assert.equal(recallRes.isTimeBoundCommitment, false);

    // 5. AddToList: "add sparkling water to my grocery list"
    const listRes = classifyCosmoSlots("add sparkling water to my grocery list");
    assert.equal(listRes.primarySlot, "ADD_TO_LIST");

    // 6. DeepResearch & CreateDoc
    const researchRes = classifyCosmoSlots("research how Conformer gatekeeping thresholds work and write a design doc");
    assert.ok(researchRes.allSlots.includes("DEEP_RESEARCH"));
    assert.ok(researchRes.allSlots.includes("CREATE_DOC"));
  });

  it("staples concurrent screen OCR, active app, window title, and clipboard context to spoken slots and renders to brief.md", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gadget-cosmo-slots-"));
    try {
      const dbPath = join(tmp, "miner.db");
      const store = new EventStore(dbPath);
      const t0 = 1_760_000_000_000;

      const screenEv = makeEvent({
        source: "screen",
        timestampMs: t0 - 2000,
        workspacePath: tmp,
        contentText: "Superior Court of California - Case #24-CV-99182 - Filing Deadline Friday 5:00 PM",
        sourceUri: "capture:screen.jsonl:1",
        metadataJson: JSON.stringify({
          app: "Google Chrome",
          windowTitle: "Case #24-CV-99182 Docket",
        }),
      });
      const clipEv = makeEvent({
        source: "clipboard",
        timestampMs: t0 - 5000,
        workspacePath: tmp,
        contentText: "Case #24-CV-99182",
        sourceUri: "capture:clipboard.jsonl:1",
        metadataJson: "{}",
      });
      const audioEv = makeEvent({
        source: "audio",
        timestampMs: t0,
        workspacePath: tmp,
        contentText: "[audio transcript] Note to self, don't forget about your court case by Friday",
        sourceUri: "capture:audio.jsonl:1",
        metadataJson: "{}",
      });

      store.insert(withSeeks([screenEv, clipEv, audioEv]));

      const slot = extractSpokenSlotFromEvent(audioEv, [screenEv, clipEv, audioEv]);
      assert.ok(slot);
      assert.equal(slot.triggerPrefix, "Note to self");
      assert.equal(slot.socialMode, "human_safe_self_note");
      assert.equal(slot.primarySlot, "CREATE_CALENDAR_EVENT");
      assert.ok(slot.allSlots.includes("PROVIDE_EVENT_CONTEXT"));
      assert.ok(slot.allSlots.includes("ADD_TASK"));
      assert.equal(slot.isTimeBoundCommitment, true);
      assert.equal(slot.extractedTimeText?.toLowerCase(), "by friday");
      assert.equal(slot.context.activeApp, "Google Chrome");
      assert.equal(slot.context.windowTitle, "Case #24-CV-99182 Docket");
      assert.ok(slot.context.screenSnippet?.includes("Case #24-CV-99182"));
      assert.equal(slot.context.clipboardSnippet, "Case #24-CV-99182");

      store.upsertSpokenSlot(slot);
      const listed = store.listSpokenSlots({ status: "ACTIVE" });
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.slotId, slot.slotId);
      assert.equal(listed[0]?.context.activeApp, "Google Chrome");

      const sink = new BriefWorkspaceSink(store, () => t0 + 1000);
      await sink.write(tmp, [], "Surfacing 1 active spoken commitment/slot(s)", listed);

      const briefMd = readFileSync(join(tmp, ".gadget", "brief.md"), "utf8");
      assert.ok(briefMd.includes("## Active Spoken Commitments & Gatekeeper Slots"));
      assert.ok(briefMd.includes("`CREATE_CALENDAR_EVENT` via `Note to self` (`human_safe_self_note`)"));
      assert.ok(briefMd.includes("Case #24-CV-99182 Docket"));
      assert.ok(briefMd.includes("> don't forget about your court case by Friday"));

      // Resolve slot
      assert.equal(store.resolveSpokenSlot(slot.slotId), true);
      assert.equal(store.listSpokenSlots({ status: "ACTIVE" }).length, 0);
      store.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
