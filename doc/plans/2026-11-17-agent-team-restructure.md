# Atlas agent team restructure

Status: approved by Prasanna in conversation on 2026-11-17 (shadow mode for D3 confirmed). This document is the design and the build brief.

## Intent

Atlas is the Paperclip company that turns a Jira ticket or a product ask into reviewed, locally verified GitLab MRs. Today its agents follow instructions literally, carry roughly 100 KB of duplicated instructions, and ship large changes. The restructure makes the team behave like a small group of senior colleagues: they challenge vague asks, find the root cause before coding, deliver in small reviewable steps, and load only the context a task needs.

## Goals

- Product Lead and Delivery Lead are peers reporting to the board. Either can take a task; they debate or help each other when needed.
- Agents are generic roles (persona, DOOH context, how to work). Epic, repo and Tactics knowledge loads on demand from an index.
- Challenge before building: one batched round of pushback and questions, then autonomous work on logged defaults.
- Root cause first: no code before a written problem, evidence, cause, chosen fix and an explicit "what I will not build".
- Small stacked delivery: small MRs into a feature branch, each reviewed and tested, then one final MR to main for the board.
- Quality gates in review: SOLID, KISS, YAGNI, DRY, Law of Demeter, diff-size cap, no speculative code.
- A D3 triage tool agents can call to check whether a task needs splitting and whether it hits a plan gate. Shadow mode first.
- Per-agent learnings the board can read and edit.
- Read-only external research and data access.

## Non-goals

- D3 does not gate or split anything in this release. It only advises, and its answers are logged next to the agent's own.
- No change to budget enforcement. Budget awareness comes from small tasks and tiered models.
- No agent merges to main or pushes to a default branch.

## Anti-goals (failure even if it technically works)

- Agents that ask more questions than before and stall.
- A larger context than today.
- Self-edited instructions with no human review.

## Approaches considered

1. Instructions only, no Paperclip code. Cheapest, but cannot satisfy the D3 requirement.
2. Instructions plus a new agent-callable D3 triage route with fixed server-owned questions, shadow-logged. Chosen: it is the smallest change that makes D3 usable and measurable.
3. Instructions plus a general D3 execution endpoint. Rejected: `doc/decision-models.md` deliberately has no general endpoint, and free-form prompts leak scope.

Evidence from the cited blog (karun.me, 2026-11-10): the author could not get a dedicated classifier working because of a short context window. D3 takes at most 32 KB of state, so the same risk applies. That is why it ships in shadow mode.

## Design

### A. Paperclip: D3 triage route (this repo, TDD)

- `POST /api/companies/:companyId/decision-model/triage`, callable by an agent in an active run or by the board.
- Fixed, server-owned question catalogue under a registered feature `tasks.triage`. Callers supply task text and optional context, never prompts.
- Questions: `single_repo` (boolean), `fits_one_small_mr` (boolean), `touches_gated_area` (boolean: schema or API contract, multi-repo, bidder/RTB/pacing/budget/billing, irreversible, auth), `size` (score: small, medium, large), and an optional caller-supplied `pack` choice over the pack names it passes.
- Optional `agentAnswers` in the request holds the agent's own call. The server records D3 answers, the agent's answers and a per-question agreement flag in the activity log (`decision_model.triage_shadow`) and returns D3's answers.
- Shared types and validators in `packages/shared`, route in `server/src/routes/decision-models.ts`, service in `server/src/services`, OpenAPI entry, skill documentation in `skills/paperclip/SKILL.md`, behaviour doc in `doc/decision-models.md`.
- When D3 is unavailable the route returns the unavailable reason and agents continue on their own judgement.

### B. Agent instructions (claude-workspace and live agent files)

- `context/agents/CORE.md`: the shared principles every agent reads once (challenge protocol, root-cause gate, quality principles, stacked delivery, triage).
- `context/agents/INDEX.md`: one-screen router from task signal to the file to load.
- Each live `AGENTS.md` shrinks to: persona, DOOH context, how this role works, who it talks to, and pointers to CORE and INDEX.
- `WAY-OF-WORKING.md` updated for peers, challenge-first, stacked MRs, merge authority into the feature branch only, and the D3 shadow step.
- Hierarchy: Delivery Lead reports to the board, not the Product Lead. Chain-of-command text updated to match.
- Model tiers pinned per agent: Product Lead, Delivery Lead, Code Reviewer, Story Analyst, Deep-systems Engineer on Opus; engineers, QA, DOOH Planner, UX Advisor on Sonnet; Summarizer on Haiku. Escalate a tier only after a failure.

### C. Memory

Use Paperclip's native learnings loop (`$AGENT_HOME/learnings/INDEX.md`, 4 KB index, evidence required, retire not delete). It is already per agent, lazily loaded and editable. Agents may not edit their own `AGENTS.md`; changes go through a proposal the board accepts.

### D. Stacked delivery

- Feature branch `<JIRA-KEY>/<slug>`; step branches `<JIRA-KEY>/<slug>/NN-<step>` each with an MR into the feature branch.
- Per step: implement with TDD, Code Reviewer pass, QA Verifier pass, then the engineer merges the step MR into the feature branch.
- A step MR over about 200 changed lines needs a written reason, or is split.
- Final MR feature branch to main is opened for the board and never merged by an agent.

## Constraints

- Paperclip invariants in `AGENTS.md` section 5 hold: company scope, contract sync across shared/server/ui, activity logging for mutations.
- Agent calls need an active run and an agent connection grant for the D3 connection; verify the Atlas grant covers agents.
- Live agent files are backed up before rewriting.

## Left to the builder

Exact question wording, the shape of the OpenAPI schema, and the wording of each rewritten persona.
