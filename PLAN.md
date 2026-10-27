# Proactive Personal Agent — Research Plan

Status: RESEARCH ONLY — no implementation decision has been requested or made.
Owner: append updates under "Owner updates" at the end of this file, or write
`READY TO EXECUTE` there when research should move to a next stage the owner names.

Correction record (2026-10-27): an earlier draft of this file recommended
extending FM in `~/neural` on Android instead of a greenfield build. The
owner did not request implementation advice, a mobile decision, or a reuse
decision. That recommendation is withdrawn in full. `~/neural` (FM) and
`~/cosmo-dev` are research evidence about one attempted architecture, not a
proposed solution base.

## Research Goal

Understand the problem named in [ideation.md](ideation.md) and how other
people are solving the problem, before any build decision:

1. Agents fail to act proactively and fail to take real actions outside a sandbox.
2. Permissions default to repeated approvals. The owner rule is narrower:
   first contact as the owner requires approval; a previously used target, or
   a message tagged as from the owner's assistant, does not.
3. Proactivity should work across visual, text, and audio input, starting work
   while a request is still being formed rather than after a command completes.
4. Errors and learning: a system that starts imperfect must improve from
   corrections, and training from one user (the owner) should help a second
   user (the owner's dad) without assuming a single-user, single-instance model.

The research areas named by the owner are: Google Scholar work from 2025 and
2026 only; GitHub projects doing interesting work in the space; and the local
Cosmo/FM artifacts in `~/cosmo-dev` and `~/neural` as thinking material about
the problem and one set of attempted solutions. Copy what works is a research
filter, not an instruction to copy a codebase.

## Out of Scope for This Document

- No implementation architecture, stack, framework, or build sequence.
- No platform decision. Mobile, laptop/desktop, and multi-device operation
  are all open research questions. The owner notes the described needs could
  have worked on a laptop; mobile must not be assumed.
- No greenfield-versus-reuse decision, and no advocacy for `~/neural`, FM,
  Cosmo, or any GitHub project as a base.
- No treatment of README capability claims in any repository as proof that a
  system works or was designed correctly.

## Local Evidence and Owner Caveat: Cosmo and FM

Owner-supplied context for interpreting the local directories:

- Cosmo was Google's ambient agent app, publicly available in the Google Play
  Store. Cosmo never worked for the owner because login was not possible.
- The owner reverse engineered Cosmo, extracted the Cosmo architecture, and
  attempted a reimplementation in `~/neural`, named FM.
- FM was never designed correctly. FM is a partial reverse-engineering attempt.
- FM is mobile-only.

Research use of `~/cosmo-dev` and `~/neural`: study the Cosmo architecture and
the FM attempt for problem structure — capture sources, directedness gating,
intent extraction, fulfillment, confirmation, memory, presence — and for
failure modes of a partial reimplementation. Do not weight FM as a solution
because FM exists locally. Do not infer a mobile requirement from FM.

## Research Questions

### 1. Permissions without approval fatigue

- How do recent systems express standing consent: by target, by action class,
  by disclosure ("sent by an assistant"), by reversibility, by value at risk?
- What evidence exists that first-use approval plus standing grants stays safe
  when an agent reads untrusted email, web, and notification content?
- Where do capability and information-flow designs (for example CaMeL, 2025)
  succeed or fail at keeping untrusted content from turning into actions?
- What audit, undo, and revocation patterns do real projects use after an
  agent sends, posts, calls, or writes as the user?

### 2. Proactivity across visual, text, and audio input

- How do 2025–2026 proactive-agent papers define the decision to act:
  timing, content, interruptibility, confidence, and cost of a false trigger?
- How do recent systems handle continuous perception without continuous
  expensive reasoning (for example tiered or on-demand sensing)?
- What separates speculative preparation (drafts, lookups, staging) from
  commitment in published systems, and what goes wrong at the boundary?
- What do benchmarks with real human sessions show that synthetic benchmarks
  miss about when help is wanted?

### 3. Errors, learning, and transfer to a second user

- What is learned from a correction in recent work: preferences, thresholds,
  skills, policies, reward models, or shared representations?
- Which parts of learning are personal, which parts transfer between users,
  and what privacy mechanisms separate personal data from transferable learning?
- What evaluation proves transfer helped a second user rather than merely
  changed behavior on a second device?
- How do systems roll back a bad shared update, and how do systems handle
  conflicting corrections from different users?

### 4. Platform as an open question

- Which parts of the problem actually require a phone (ambient audio, calls,
  notifications, wearables), which parts fit a laptop (typing, files, browser,
  messaging, email), and which parts require both surfaces cooperating?
- What do GitHub personal-agent projects assume about the host surface, and
  what breaks when the host surface changes?

## Research Steps

1. **Scholar sweep, 2025–2026 only.** Complete the Google Scholar search the
   owner named. Record paper, year, problem claim, method, evaluation data
   (real sessions versus synthetic), and stated limits for each included paper.
   Exclude pre-2025 work from recommendations; name any excluded influential
   paper only as excluded, with the year shown.
2. **GitHub sweep.** Find projects doing interesting work on proactive action,
   standing permissions, ambient capture, and cross-user learning. For each
   project record: host surface, action channels, permission model, evidence
   of real use, license, and failure/limitation notes from issues or docs.
   Repository popularity alone does not count as evidence a project works.
3. **Cosmo/FM architecture read as research.** Extract the Cosmo problem
   decomposition from `~/cosmo-dev` and `~/neural`. Separately record where
   the FM reimplementation is partial, incorrectly designed, or mobile-bound,
   using the owner caveat in this file rather than README claims as authority.
4. **Comparative synthesis.** Compare papers, GitHub projects, and Cosmo/FM
   on the three owner problems only: permissions, proactivity, learning
   transfer. Mark every claim as owner requirement, inspected source evidence,
   or unresolved gap.
5. **Open-decision report.** End research with the decisions research could
   not settle — platform, host surface, reuse versus greenfield, consent model
   for a second user — stated as owner decisions with the evidence for each
   option. Research output must not smuggle a decision in as a recommendation
   the owner did not ask for.

## Evidence So Far (preliminary, to be completed by the sweeps)

- The `deep-research` workflow run for this topic completed with
  "No source-backed claims were found" and produced no usable findings.
- Direct inspection has covered: `ideation.md`; top-level structure and
  README/PLAN documents in `~/cosmo-dev` and `~/neural`; and the primary
  sources listed under Sources. The Google Scholar sweep and the GitHub sweep
  named by the owner are not yet complete and must not be reported as done.
- CaMeL (2025) reports a capability/information-flow layer around an LLM agent
  solving 77% of AgentDojo tasks with provable security versus 84%
  undefended — relevant evidence for Research Question 1, not a chosen design.
- ProAgent (2025) studies proactive agents with on-demand sensory context —
  relevant evidence for Research Question 2, not a chosen design.
- ProAgentBench (2026) evaluates proactive assistance on real user sessions
  and splits the task into timing prediction and assistance-content
  generation — relevant evidence for Research Questions 2 and 3, not a chosen
  benchmark commitment.
- The OpenClaw GitHub repository is one candidate entry for the GitHub sweep.
  No conclusion about OpenClaw quality, fit, or reuse has been drawn.

## Risks / Open Questions

- Platform remains fully open: mobile, laptop/desktop, or both.
- Consent and privacy terms for learning transfer to a second user remain open.
- The shared-learning aggregation mechanism has no inspected primary source yet.
- Google Scholar coverage for 2025–2026 remains incomplete until Research
  Step 1 finishes.
- Clean-room and licensing boundaries for any Cosmo-derived material require
  research before any future build discussion.

## Sources (inspected so far)

- [CaMeL — Defeating Prompt Injections by Design (2025)](https://arxiv.org/abs/2503.18813)
- [ProAgent — Harnessing On-Demand Sensory Contexts for Proactive LLM Agent Systems (2025)](https://arxiv.org/html/2512.06721v1)
- [ProAgentBench — Evaluating LLM Agents for Proactive Assistance with Real-World Data (2026)](https://arxiv.org/abs/2602.04482)
- [OpenClaw repository](https://github.com/openclaw/openclaw)

---

## Owner updates

<!-- Append updates below this line. Write `READY TO EXECUTE` on its own line when the plan is approved for execution. -->
