# D3-First Task Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a company run task triage D3-first: for questions D3 is calibrated on, an agent omits its own answer and only reasons about the questions D3 is not confident on.

**Architecture:** A board user records a per-question calibration (bar, samples, accuracy) taken from a human-validated labelled replay. Calibration entries are append-only `decision_model.triage_calibration` activity rows, so no schema change. `triageDecision` trusts D3 on a calibrated question at or above its recorded bar, and agents may omit answers for those questions. A deterministic 1-in-10 audit still requires answers, and live disagreement revokes a calibration.

**Tech Stack:** TypeScript, zod, Drizzle, Express, Vitest (embedded Postgres tests in `server/src/__tests__/task-triage.test.ts`).

**Spec:** the conversation of 2026-11-27 (eval evidence: n=49 random labelled tasks, non-gate answers at ≥0.7 were 58/58 correct; `work_type` 23 answers and `needs_split` 32 answers at ≥0.7 all correct). Existing behaviour: `doc/decision-models.md` "Task triage".

## Global Constraints

- Work on `development`, no side branches. **One commit at the end**, not per task. Run `git status` before staging; never stage unrelated files.
- **No code comments** (user rule). Name things instead.
- Calibratable questions are exactly `work_type`, `size`, `needs_split`, `capability_tier`. `touches_gated_area`, `owner` and `pack` are never calibratable: the gate stays escalate-only (`gate_never_relaxed`).
- Defaults stay: `TASK_TRIAGE_MIN_CONFIDENCE = 0.7`, `TASK_TRIAGE_MIN_SAMPLES = 20`, `TASK_TRIAGE_MIN_AGREEMENT = 0.85`. A calibration is accepted only with `samples >= TASK_TRIAGE_MIN_SAMPLES` and `accuracy >= TASK_TRIAGE_MIN_AGREEMENT`.
- Constants: `TASK_TRIAGE_CALIBRATION_MAX_AGE_DAYS = 90`, `TASK_TRIAGE_AUDIT_ONE_IN = 10`.
- Core carries no company domain (AGENTS.md rule 5): no company gated areas, branch names or agent names in `server/` or `packages/`. Deployment-specific wording lives only in the deployment's own agent context.
- Every mutating route logs activity (AGENTS.md rule 3) and checks company access.
- `skills/paperclip/SKILL.md` is pinned by tests: after editing run `pnpm vitest run server/src/__tests__/paperclip-skill-utils.test.ts` from the repo root, then `pnpm run generate:capability-contract` and `pnpm run check:capability-contract` in `packages/paperclip-runner`. Do not claim `check:capability-inventory` is clean; it already fails at HEAD.
- Final gate: `pnpm verify`. No repo-wide typecheck/build/test unless it exits 2 and a focused check cannot close the gap.
- Replay harness and labelled sheet live outside the repo, in the deployment's eval folder. Never run the replay through `POST /triage` (it would write shadow-log rows); call `runDecisionProvider` directly.

## Review Focus

1. Agent omits an answer for a calibrated question and D3 is below the bar: `value` is `null`, `use` is `agent`, and the skill says to decide yourself. Pinned in Task 2.
2. Agent omits an answer for a question that is not calibrated: still 400 naming it. Pinned in Task 3.
3. A calibration older than 90 days is ignored. Pinned in Task 2.
4. Calibration for `touches_gated_area`, `owner` or `pack` is rejected. Pinned in Task 2.
5. Live agreement below 0.85 over at least 20 confident answers revokes a calibration (`low_agreement`). Pinned in Task 2.
6. An audited call requires answers for every question; the same `issueId` is always audited or never audited. Pinned in Task 3.
7. A board user may omit answers exactly as before. Pinned in Task 3.

---

### Task 1: Sharper questions and named state

**Files:**
- Modify: `packages/shared/src/decision-models.ts` (`TASK_TRIAGE_WORK_TYPE_CRITERIA`, `TASK_TRIAGE_QUESTIONS.size` criteria, `taskTriageRequestSchema`)
- Modify: `server/src/services/task-triage.ts` (`taskTriageDecisionRequest`)
- Test: `server/src/__tests__/task-triage.test.ts`

**Interfaces:**
- Produces: `taskTriageRequestSchema` accepts optional `title: string` (trimmed, 1–300). `taskTriageDecisionRequest(input).state` is `{ title?, task, context? }`, with `title` present only when sent.

- [ ] **Step 1: Write failing tests** in `task-triage.test.ts`:
  - `it("sends the title as its own state field")`: a request with `title: "Release: version 2"` and `task: "body"` sends `state` equal to `{ title: "Release: version 2", task: "body" }`; without `title`, `state` is `{ task: "body" }`.
  - `it("tells D3 operations covers running and releasing systems and not building the change")`: the `operations` criterion contains `Not for` and `merge` and `implementation`.
  - `it("anchors size on observable work")`: the `small` criterion contains `one session` and `one repository or document`.
- [ ] **Step 2: Run** `pnpm vitest run server/src/__tests__/task-triage.test.ts -t "title as its own|operations covers|anchors size"` → FAIL.
- [ ] **Step 3: Implement.** Rewrite the `operations` criterion as running, configuring, merging, releasing or restarting something that already exists, ending `Not for: building the change itself (implementation) or writing about it (communication)`. Rewrite size anchors to `Small: one change in one repository or document, finished in one session`, `Medium: several related changes that still ship as one deliverable`, `Large: needs splitting into multiple deliverables`. Add `title` to the schema and to `state`.
- [ ] **Step 4: Run** the full file `pnpm vitest run server/src/__tests__/task-triage.test.ts` → PASS.

### Task 2: Calibration records and the decision rule

**Files:**
- Modify: `packages/shared/src/decision-models.ts`
- Modify: `server/src/services/task-triage.ts`
- Test: `server/src/__tests__/task-triage.test.ts`

**Interfaces:**
- Produces in shared:
  - `TASK_TRIAGE_CALIBRATABLE_QUESTIONS = ["work_type","size","needs_split","capability_tier"] as const`
  - `taskTriageCalibrationSchema` (strict): `{ question: enum of the above; minConfidence: number 0.5–1; samples: int ≥ 1; accuracy: number 0–1; source: string 1–200 }`; `type TaskTriageCalibration`
  - `TaskTriageDecisionReason` gains `"calibrated"`
  - constants `TASK_TRIAGE_CALIBRATION_MAX_AGE_DAYS`, `TASK_TRIAGE_AUDIT_ONE_IN`
- Produces in `task-triage.ts`:
  - `recordTriageCalibration(db: Db, caller: TaskTriageCaller, input: TaskTriageCalibration): Promise<TaskTriageCalibration & { recordedAt: string }>`: rejects with `badRequest` when `samples < TASK_TRIAGE_MIN_SAMPLES` or `accuracy < TASK_TRIAGE_MIN_AGREEMENT`; logs `decision_model.triage_calibration` on the company.
  - `activeTriageCalibration(db: Db, companyId: string, now?: Date): Promise<Partial<Record<TaskTriageQuestion, TaskTriageCalibration & { recordedAt: string }>>>`: latest entry per question, newer than the max age.
  - `triageDecision(question, d3, confidence, agentAnswer, record, calibration?)`: for a non-gate question with `calibration` and `confidence >= calibration.minConfidence`, returns `use: "d3", reason: "calibrated"` unless `record` has at least `TASK_TRIAGE_MIN_SAMPLES` samples and agreement below `TASK_TRIAGE_MIN_AGREEMENT`, which returns `use: "agent", reason: "low_agreement"`. Without calibration, behaviour is unchanged. `triage()` passes each question's calibration.

- [ ] **Step 1: Write failing tests**: calibrated answer at the bar uses D3 with reason `calibrated` and no live history; below the bar returns `use: "agent"`, `reason: "low_confidence"`, `value: null` when the agent sent no answer; a 91-day-old calibration is ignored; `recordTriageCalibration` rejects `touches_gated_area` through the schema, rejects 19 samples and accuracy 0.84; a seeded record of 20 confident answers at 70% agreement revokes (`low_agreement`).
- [ ] **Step 2: Run** the new tests → FAIL.
- [ ] **Step 3: Implement** the interfaces above. Reuse `seedHistory` and `isConfident`; read calibration once per `triage()` call.
- [ ] **Step 4: Run** `pnpm vitest run server/src/__tests__/task-triage.test.ts` → PASS.

### Task 3: D3-first flow, audit and routes

**Files:**
- Modify: `server/src/services/task-triage.ts`, `server/src/routes/decision-models.ts`, `server/src/routes/openapi.ts`
- Test: `server/src/__tests__/task-triage.test.ts`

**Interfaces:**
- Consumes: `activeTriageCalibration`, `recordTriageCalibration`, `TASK_TRIAGE_AUDIT_ONE_IN`.
- Produces:
  - `isAuditedTriageCall(seed: string): boolean`: stable hash of `seed` modulo `TASK_TRIAGE_AUDIT_ONE_IN` equals 0. Seed is `issueId ?? runId ?? ""`.
  - `assertAgentAnsweredRequiredQuestions`: replaces `assertAgentAnsweredEveryQuestion`. Required questions are all questions when the call is audited, otherwise every question that is not calibrated. The 400 message names the missing ones and says when the call was an audit.
  - `GET /api/companies/:companyId/decision-model/triage/calibration` (any authenticated company caller) returns `{ calibrated: { [question]: { minConfidence, samples, accuracy, recordedAt } } }`.
  - `POST /api/companies/:companyId/decision-model/triage/calibration` (connection manager, same access check as `PUT /`) validates with `taskTriageCalibrationSchema` and returns the recorded entry.

- [ ] **Step 1: Write failing tests**: agent omitting calibrated `work_type` succeeds; agent omitting non-calibrated `size` gets 400 naming it; an `issueId` whose hash is audited gets 400 naming every omitted question and the same call repeats the same result; a board user omitting everything succeeds; GET lists calibrated questions; POST requires manager access (403 for others) and logs activity.
- [ ] **Step 2: Run** the new tests → FAIL.
- [ ] **Step 3: Implement** the interfaces; describe both routes in `openapi.ts` next to the existing triage entry.
- [ ] **Step 4: Run** `pnpm vitest run server/src/__tests__/task-triage.test.ts server/src/__tests__/decision-models.test.ts` → PASS.

### Task 4: Docs, skill and agent context

**Files:**
- Modify: `doc/decision-models.md` (Task triage section: calibration, D3-first flow, audit, the two routes)
- Modify: `skills/paperclip/SKILL.md` (Task Triage (D3) section)
- Modify (the deployment's separate agent-context repo, commit there): the core agent guide §5 and the two routing guides ("Owner, model and effort")

- [ ] **Step 1:** In `SKILL.md`, replace "after you have formed your own view" with: call `GET …/triage/calibration` once per run, answer your own gate, owner and pack questions and every question not listed as calibrated, omit the rest, then act on `decisions.<question>.value`; when `use` is `agent` and `value` is `null`, decide yourself; an audited call returns 400 and needs every answer.
- [ ] **Step 2:** In the deployment's core agent guide §5 change "answers the triage questions itself first" to match, keeping its deployment-specific gated-area list and adding the deployment's own rule for titles or targets that the lead always answers `touches_gated_area: true`.
- [ ] **Step 3:** In the technical routing guide replace "A `capability_tier` of `hard` from D3 changes neither model nor effort" with: tier `routine` (D3 value or the lead's own) runs the owner at medium effort for that task and is logged; `standard` and `hard` stay at high effort. Mirror the one line in the general routing guide.
- [ ] **Step 4: Verify** from the repo root: `pnpm vitest run server/src/__tests__/paperclip-skill-utils.test.ts`, then `pnpm run generate:capability-contract` and `pnpm run check:capability-contract` in `packages/paperclip-runner` → PASS.

### Task 5: Re-measure and register calibration (operator step)

**Files:**
- Create, in the deployment's eval folder: `replay-labelled.mts` (the replay script, kept durable), `calibrate.py`

- [ ] **Step 1:** Replay all 100 labelled tasks with the new wording (default gated areas, plus the first 50 with a deployment-specific gated-area list). Compare accuracy per question with the baseline run. Acceptance: no calibratable question loses more than 3 points of accuracy, and the `size` small→medium confusion is lower than 20 of 35.
- [ ] **Step 2:** `calibrate.py` picks, for each calibratable question, the lowest bar in {0.6, 0.65, 0.7, 0.75, 0.8} where accuracy at or above it is ≥ 0.9 with at least 20 answers; questions with no such bar stay uncalibrated.
- [ ] **Step 3:** Print the `POST …/triage/calibration` bodies for the user to submit with a board token. Do not write them to the database directly.

## Self-review

- Spec coverage: question fixes (T1), per-question bars and eval-qualified trust (T2), D3-first flow and audit (T3), tier→effort and gate rule (T4), calibration data (T5). The gate stays escalate-only; Deployment branch rules live in the deployment's agent context, not Core.
- Types: `TaskTriageCalibration` and `activeTriageCalibration` are defined in Task 2 and consumed unchanged in Task 3.
