# Proactive Personal Agent — Build Plan

Status: DRAFT — not yet approved for execution. Owner: append updates under
"Owner updates" at the end of this file, or write `READY TO EXECUTE` there.

## Goal

Build a proactive personal agent that acts in the real world outside a sandbox, per [ideation.md](ideation.md). The agent must (1) use standing permission grants instead of per-action approvals, (2) start work proactively across audio, text, and visual input, and (3) learn from errors in a form that transfers to a second user.

Top finding from research phase: the `deep-research` workflow completed with “No source-backed claims were found” and wrote no plan file. The plan below uses direct re-research (local `~/neural` and `~/cosmo-dev` inspection, plus inspected 2025–2026 primary sources listed under Sources) instead of workflow output.

## Success Criteria

- Permission rule from ideation.md holds in code: first external contact as the user requires approval; a known target, or a disclosed-assistant tag on the message, does not.
- The agent prepares work before an explicit command finishes arriving, and the agent commits no irreversible action during preparation.
- A correction made by user one measurably improves the same skill for user two, without moving user one personal data to user two device.
- Every shipped control passes an automated end-to-end device test and a real-device launch check. Compilation alone never counts as done.

## Approach

**Reuse base: extend FM in `~/neural`, do not start greenfield, do not copy Cosmo.** Local inspection: `~/neural/README.md` describes FM as a clean-room ambient agent with shipping ambient microphone capture, screen text, notifications, a unified `Gatekeeper`, a 22-skill catalog, a fulfillment runner with confirmation policy, encrypted persistent context, and on-device LLM routing with remote fallback. `~/neural/PLAN.md` states the recovered Cosmo material in `~/cosmo-dev` is reference evidence only, not a work queue. FM lacks exactly the three ideation items: standing grants, proactivity, and cross-user learning. Building the three items into FM reuses proven capture and dispatch; a greenfield agent would rebuild capture and dispatch for no gain.

**Permissions: capability grants keyed by action class, target identity, and disclosure mode.** First-use approval creates a revocable standing grant. Later sends to the same target, and any send carrying a disclosed-assistant tag, execute without approval. Every grant, execution, and revocation lands in an append-only audit log with an undo window where the channel supports recall. The capability check runs at tool-call time, outside the model, following CaMeL: explicit control/data-flow extraction from the trusted query plus capability enforcement at tool calls, reported at 77% of AgentDojo tasks solved with provable security versus 84% undefended. FM already places a CaMeL trust layer in `docs/architecture.md` §12 with no code yet, per `~/neural/README.md`; Phase 1 writes the CaMeL code. Assumption, reversible: payments and destructive actions never receive standing grants and always require approval. ideation.md does not name payments or destructive actions.

**Proactivity: cheap gate first, speculative preparation second, commit last.** FM capture sources feed the existing on-device `Gatekeeper`. A new prediction stage splits the proactive decision into timing prediction and assistance-content generation, the decomposition used by ProAgentBench (2026), where long-term memory and historical context significantly raised prediction accuracy and real-world training data beat synthetic data. Perception runs on demand in tiers — cheap always-on signals first, expensive audio/visual reasoning only after a tier fires — following ProAgent (2025), a proactive system design built around on-demand sensory context. While the user types or speaks, the agent stages reversible preparation only: drafts, lookups, prefilled forms. Commit requires either a standing grant or explicit confirmation. An interruptibility budget caps unsolicited actions per hour, and every proactive offer records accept, reject, or ignore as a label.

**Learning: separate personal memory from shared skill and policy.** Personal memory stays on the owner device in the existing encrypted store. Shareable learning consists only of de-identified accept/reject/correction labels, skill success and failure counts, and policy-threshold adjustments. An aggregation step merges shareable learning from opt-in devices into a versioned shared skill/policy bundle; each device downloads the bundle, shadow-tests the bundle against local history, and rolls back on regression. Evidence gap: no primary source for the aggregation mechanism was inspected during research, so the aggregation design stays conditional until Phase 0 research closes the gap. Raw audio, screen content, and message text never enter shareable learning.

**External candidate, evaluation only:** the [OpenClaw repository](https://github.com/openclaw/openclaw), titled “The AI that really does things. Any OS. Any Platform.”, is a candidate reference for a real-world action/channel layer. Phase 0 evaluates the OpenClaw repository against FM fulfillment; the plan does not adopt OpenClaw code without a license and architecture review.

## Steps

1. **Phase 0 — Evidence closure (research only).** Complete the Google Scholar 2025–2026 sweep named in ideation.md (research inspected arXiv primary sources dated 2025–2026, not Google Scholar result pages — recorded as a gap). Audit `~/cosmo-dev` and `~/neural` fragments into a keep/reference/drop table. Evaluate the OpenClaw repository. Pick the shared-learning aggregation mechanism from a primary source. Exit gate: every material claim in the Phase 0 report traces to an inspected source.
2. **Phase 1 — Capability permission engine in FM.** Implement grant storage, first-use approval UI wired to persisted grant state, disclosed-assistant tagging, tool-call enforcement, audit log, and revocation. Replace per-action confirmation in the fulfillment runner for granted pairs only.
3. **Phase 2 — Proactive loop, text and notifications first.** Add timing/content prediction, speculative staging, interruptibility budget, and accept/reject/ignore labeling. No external commit path in Phase 2 beyond Phase 1 grants.
4. **Phase 3 — Multimodal proactivity.** Extend the proactive loop to ambient audio directedness and screen/visual context already captured by FM, with tiered on-demand perception and per-modality false-trigger budgets.
5. **Phase 4 — Local learning loop.** Convert corrections and rejected offers into threshold, ranking, and skill-parameter updates on device. Add a personal scorecard: proactive precision, false-trigger rate, correction rate per skill.
6. **Phase 5 — Cross-user pilot.** Ship opt-in shareable learning and bundle distribution to exactly two users (you, then your dad per ideation.md). Prove transfer on one named skill before widening the pilot.
7. **Phase 6 — Hardening.** Complete the CaMeL layer for untrusted content (email, web, notifications), run prompt-injection regression cases, and freeze a release gate.

## Validation Plan

- Existing FM gates, from `~/neural/PLAN.md`: `scripts/verify-relocation-safety.sh`, `./gradlew detekt lintDebug :app:testDebugUnitTest :app:assembleDebug`, `scripts/run-launch-device-proofs.sh`, `scripts/run-device-core-capability-smoke.sh`.
- New acceptance tests, each automated and run on a real device: first-contact send blocks for approval and sends after approval; second send to the same target executes without approval; disclosed-assistant send to a new target executes without approval and shows the tag; speculative preparation produces a draft and zero external sends; revoked grant blocks the next send; correction on device one changes shared-bundle behavior on device two with zero personal-data transfer (verified by payload inspection).
- Highest-risk validation step: Phase 3 false-trigger measurement on real recorded ambient audio and screen sessions. A proactive agent with a high false-trigger rate fails the core complaint in ideation.md even when every unit test passes. ProAgentBench supports real-session evaluation over synthetic evaluation, so the scorecard uses recorded real sessions, not generated scenarios.

## Risks / Open Questions

- Platform assumption: Android phone first, because FM already runs there. A desktop-first agent would invalidate the reuse decision.
- Consent model for the second user in Phase 5 needs an explicit opt-in design before any bundle ships.
- Google Scholar coverage and the aggregation mechanism remain open until Phase 0 closes both gaps. A 2024 proactive-agent paper surfaced during search and was excluded from recommendations because ideation.md restricts Scholar research to 2025–2026.
- Clean-room boundary: `~/neural/README.md` notes recovered Cosmo artifacts under an interoperability rationale. Phase 0 must confirm no copied Cosmo code enters new phases.

## Sources

- [CaMeL — Defeating Prompt Injections by Design (2025)](https://arxiv.org/abs/2503.18813)
- [ProAgent — Harnessing On-Demand Sensory Contexts for Proactive LLM Agent Systems (2025)](https://arxiv.org/html/2512.06721v1)
- [ProAgentBench — Evaluating LLM Agents for Proactive Assistance with Real-World Data (2026)](https://arxiv.org/abs/2602.04482)
- [OpenClaw repository](https://github.com/openclaw/openclaw)

---

## Owner updates

<!-- Append updates below this line. Write `READY TO EXECUTE` on its own line when the plan is approved for execution. -->
