# Task Maturity Scorecard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, on every task, how fast and how reliable the checks its agents ran were, so the team can see which Atlas repos block agent autonomy.

**Architecture:** Compute the scorecard on read from data Paperclip already stores: `heartbeat_run_events` (shell tool events with `exitCode` and `durationMs`), `heartbeat_runs` (retry chain, runtime) and `cost_events` (model, tokens, cost). No schema change. A pure classifier turns shell commands into check kinds, a pure aggregator builds the scorecard, one route serves it, and one row on the task page renders it, mirroring the existing usage row.

**Tech Stack:** TypeScript, Express, Drizzle, React, TanStack Query, Vitest.

**Spec:** No separate spec. The design calls below are the spec. Source thesis: the three posts at karun.me/blog/2026/11/{08,09,10} (AI maturity vs engineering maturity, feedback time, cost).

## Design calls (mine, not user-approved line by line)

- **Read-time, no schema.** A persisted metrics table is deferred until trends across issues are wanted (YAGNI).
- **One kind per shell command**, chosen by priority `mutation > test > build > typecheck > lint > compile`. Anything else is not a check.
- **Fast-check budget is 60 000 ms**, from the post's E4 bar ("seconds to a minute"). It is a named constant, not a setting.
- **Findings, not a maturity level.** The row lists concrete findings. It does not print "E3" because the thresholds are not validated for this repo family.
- **Data facts (Verified on real runs):** `tool.execution.completed` events carry `payload.prpEvent.payload.{name, status, exitCode, durationMs, executionId, output}`. The command text is in `…payload.subject` on `tool.execution.progressed` events, not on `started` or `completed`. `name` is `"Bash"` for shell commands.
- **Assumed:** `output` is present on completed events for failed commands. It is used only for the environment-blocked flag, so a miss under-reports and does not break anything.

## Global Constraints

- Company-scoped: the route must use the same access helpers as `GET /issues/:id/cost-summary` (`getAccessibleResource`, `assertIssueCostReadAllowed`).
- Contracts synced across `packages/shared`, `server`, `ui` (AGENTS.md section 5.2). No `packages/db` change.
- No source comments anywhere (owner rule). Names carry the meaning.
- New server code lives in `server/src/services/maturity/`, not in `heartbeat.ts` or `run-completion.ts` (`rules/heartbeat-execution-boundaries.mdc`).
- No polling added on the server (`rules/sleep-aware-background-work.mdc`). The UI row refetches only while a run is active, like the usage row.
- UI follows `DESIGN.md` tokens and `rules/ui-render-cost.mdc`.
- Verification: `pnpm verify`. PR body follows `.github/PULL_REQUEST_TEMPLATE.md`.

## Review Focus

- Issue with zero shell commands: `findings` has `no_checks_ran`, rates are `null`, never `0` or `NaN`.
- `started` event with no `completed` (cancelled run): excluded from timing and pass rate, not counted as a pass.
- Shell command with `exitCode: null`: excluded from pass rate, not counted as a failure.
- Very large run: the loader is bounded and sets `truncated: true`; the row says "partial".
- Issue id from another company: 403/404 exactly as `cost-summary` behaves.

---

## File structure

| File | Responsibility |
|---|---|
| `server/src/services/maturity/classify-command.ts` | Pure: shell command text to `CheckKind \| null` |
| `server/src/services/maturity/build-scorecard.ts` | Pure: normalized records to `IssueMaturityScorecard` |
| `server/src/services/maturity/load-scorecard-inputs.ts` | DB reads: events, runs, model mix for an issue tree |
| `server/src/routes/maturity.ts` | `GET /issues/:id/maturity-scorecard` |
| `packages/shared/src/types/maturity.ts` | Shared types and constants |
| `ui/src/lib/maturity-scorecard-lines.ts` | Pure formatter |
| `ui/src/components/issue-properties/maturity-row.tsx` | Row component |
| `doc/agent-maturity-scorecard.md` | What each number means and how to act on it |

---

### Task 1: Command classifier

**Files:**
- Create: `server/src/services/maturity/classify-command.ts`
- Test: `server/src/services/maturity/classify-command.test.ts`

**Interfaces:**
- Produces: `type CheckKind = "compile" | "lint" | "typecheck" | "test" | "mutation" | "build"` (exported from `packages/shared/src/types/maturity.ts`, created in Task 2; define it there first, see Step 3) and `classifyCommand(command: string): CheckKind | null`.

- [ ] **Step 1: Write the failing test** covering exactly these cases:
  - `./gradlew compileJava compileTestJava checkstyleMain pmdMain -q` returns `"lint"` (checkstyle/pmd outrank compile).
  - `./gradlew compileJava` returns `"compile"`.
  - `./gradlew test` and `pnpm vitest run server/src/x.test.ts` and `pytest -q` return `"test"`.
  - `./gradlew pitest` and `./gradlew check pitest` return `"mutation"`.
  - `./gradlew build` returns `"build"`. `pnpm -r typecheck` and `npx tsc --noEmit` return `"typecheck"`. `ruff check .` and `eslint .` return `"lint"`.
  - `git status`, `glab mr view 12 -R x/y`, `ls` return `null`.
  - A compound `cd svc && ./gradlew test 2>&1 | tail -40` returns `"test"`.
- [ ] **Step 2: Run** `pnpm exec vitest run server/src/services/maturity/classify-command.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `classifyCommand` as an ordered list of `[CheckKind, RegExp]` pairs checked in priority order `mutation, test, build, typecheck, lint, compile`; the first match wins. Match on word boundaries so `latest` does not match `test`.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(maturity): classify agent shell commands into check kinds`.

### Task 2: Shared types and aggregator

**Files:**
- Create: `packages/shared/src/types/maturity.ts`, `server/src/services/maturity/build-scorecard.ts`
- Modify: `packages/shared/src/types/index.ts`, `packages/shared/src/index.ts` (re-export, same lines pattern as `IssueCostSummary` at `types/index.ts:971` and `index.ts:1303`)
- Test: `server/src/services/maturity/build-scorecard.test.ts`

**Interfaces:**
- Produces in shared: `CheckKind`; `FAST_CHECK_BUDGET_MS = 60_000`; `MaturityFindingCode = "no_checks_ran" | "slow_check" | "environment_blocked" | "low_first_pass"`; `MaturityFinding { code; message: string }`; `CheckKindStats { kind: CheckKind; commands: number; failures: number; firstPassRate: number | null; medianMs: number | null; slowestMs: number | null }`; `ModelMixEntry { model: string; costCents: number; inputTokens: number; outputTokens: number }`; `IssueMaturityScorecard { issueId: string; includeDescendants: boolean; truncated: boolean; runCount: number; reworkRuns: number; recheckAfterFailure: number; environmentBlockedCount: number; agentWaitShare: number | null; byKind: CheckKindStats[]; modelMix: ModelMixEntry[]; findings: MaturityFinding[] }`.
- Produces in server: `ToolCommandRecord { runId: string; executionId: string; kind: CheckKind; exitCode: number | null; durationMs: number | null; environmentBlocked: boolean; startedAtMs: number }`, `RunRecord { id: string; startedAtMs: number | null; finishedAtMs: number | null; retryOfRunId: string | null; scheduledRetryAttempt: number; continuationAttempt: number }`, `buildScorecard(input: { issueId: string; includeDescendants: boolean; truncated: boolean; commands: ToolCommandRecord[]; runs: RunRecord[]; modelMix: ModelMixEntry[] }): IssueMaturityScorecard`.

- [ ] **Step 1: Write the failing tests** (names are the contract):
  - `reports no_checks_ran and null rates when there are no commands`
  - `computes firstPassRate per kind from the first command of each run and kind`
  - `ignores commands whose exitCode is null in pass rate and failures`
  - `ignores commands whose durationMs is null in median and slowest`
  - `counts recheckAfterFailure when a kind runs again in the same run after a failure`
  - `counts reworkRuns for runs with retryOfRunId or scheduledRetryAttempt or continuationAttempt above zero`
  - `agentWaitShare is summed check duration divided by summed run runtime and null when runtime is zero`
  - `emits slow_check when any check exceeds FAST_CHECK_BUDGET_MS`
  - `emits environment_blocked when a failing command is flagged environmentBlocked`
  - `emits low_first_pass when a kind has at least 3 runs and firstPassRate below 0.5`
- [ ] **Step 2: Run** `pnpm exec vitest run server/src/services/maturity/build-scorecard.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the shared types, the re-exports, and `buildScorecard`. Median is the middle value of sorted durations (mean of the two middle values for an even count).
- [ ] **Step 4: Run** the test file plus `pnpm -r typecheck --filter @paperclipai/shared` (or `node scripts/typecheck-low-memory.mjs`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(maturity): add scorecard types and aggregator`.

### Task 3: Loader and route

**Files:**
- Create: `server/src/services/maturity/load-scorecard-inputs.ts`, `server/src/routes/maturity.ts`
- Modify: server route registration (register `maturity.ts` where `routes/costs.ts` is registered), `server/src/routes/openapi.ts` (entry next to `:10987`)
- Test: `server/src/services/maturity/load-scorecard-inputs.test.ts`, `server/src/__tests__/issue-maturity-scorecard-routes.test.ts`

**Interfaces:**
- Consumes: `classifyCommand` (Task 1), `buildScorecard`, `ToolCommandRecord`, `RunRecord`, `ModelMixEntry` (Task 2).
- Produces: `loadScorecardInputs(db: Db, input: { companyId: string; issueIds: string[] }): Promise<{ commands: ToolCommandRecord[]; runs: RunRecord[]; modelMix: ModelMixEntry[]; truncated: boolean }>`; route `GET /issues/:id/maturity-scorecard?excludeRoot=` returning `IssueMaturityScorecard`.

- [ ] **Step 1: Write the failing loader test** with fixture events: one `Bash` `progressed` event whose `subject` is `./gradlew test`, followed by a `completed` event with the same `executionId`, `exitCode: 1`, `durationMs: 4200`. Assert one `ToolCommandRecord { kind: "test", exitCode: 1, durationMs: 4200 }`. Add: a `started` with no `completed` yields no record; a non-`Bash` tool yields no record; output containing `AccessDenied` sets `environmentBlocked: true`; more than the event cap sets `truncated: true`.
- [ ] **Step 2: Run** the loader test. Expected: FAIL.
- [ ] **Step 3: Implement `loadScorecardInputs`.** Select `heartbeat_run_events` for the issue tree's runs (`heartbeat_runs.issueId in issueIds`, same company) where `eventType in ('tool.execution.progressed','tool.execution.completed')`, bounded by a named `MAX_EVENTS` constant; join progressed and completed by `executionId`; read the payload through the `prpEvent.payload` path. Model mix is `cost_events` grouped by `model` for the same issues. Reuse the issue-tree expansion that `issueTreeSummary` in `server/src/services/costs.ts` uses; extract it into a shared helper only if it is not already exported.
- [ ] **Step 4: Write the failing route test** in the style of the existing `*-routes.test.ts` files: returns 200 with the scorecard for an accessible issue; the same denial status as `cost-summary` for an issue in another company; `excludeRoot=true` is honored.
- [ ] **Step 5: Implement the route** by following `server/src/routes/costs.ts:233` for access checks and error shape. It is read-only, so no activity-log write.
- [ ] **Step 6: Run** `pnpm verify`. Expected: pass, or exit 2 with the focused files green.
- [ ] **Step 7: Commit** `feat(maturity): serve a per-issue maturity scorecard`.

### Task 4: UI row

**Files:**
- Create: `ui/src/lib/maturity-scorecard-lines.ts`, `ui/src/components/issue-properties/maturity-row.tsx`
- Modify: `ui/src/api/issues.ts` (add `getMaturityScorecard(issueId, options?)` next to `getCostSummary` at `:700`), `ui/src/lib/queryKeys.ts` (entry beside `costSummary` at `:400`), `ui/src/components/IssueProperties.tsx` (mount directly under `IssueUsageRow` at `:2778`)
- Test: `ui/src/lib/maturity-scorecard-lines.test.ts`, `ui/src/components/issue-properties/maturity-row.test.tsx`

**Interfaces:**
- Consumes: `IssueMaturityScorecard` from `@paperclipai/shared`.
- Produces: `formatMaturityScorecardLines(scorecard: IssueMaturityScorecard): string[]` and `MaturityRow({ issueId }: { issueId: string })`.

- [ ] **Step 1: Write the failing formatter tests:** `shows each finding message first`, `formats a check kind as "test: 4 runs, 50% first pass, median 38s, slowest 2m 10s"`, `prints "partial" when truncated`, `prints "no checks ran" for the no_checks_ran finding and no per-kind lines`, `lists model mix as model and cost, largest first`.
- [ ] **Step 2: Run** `pnpm exec vitest run ui/src/lib/maturity-scorecard-lines.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the formatter,** the API method, the query key, and `MaturityRow` using `useQuery`, `useQueryView` and `QueryErrorState` as `IssueUsageRow` does; `refetchInterval` only while a run is active.
- [ ] **Step 4: Write the component test:** renders findings, renders the error state when the request fails, renders nothing extra while loading.
- [ ] **Step 5: Run** `pnpm verify`. Expected: pass.
- [ ] **Step 6: Commit** `feat(ui): show the maturity scorecard on tasks`.

### Task 5: Doc and live probe

**Files:**
- Create: `doc/agent-maturity-scorecard.md`

- [ ] **Step 1: Write the doc:** each number's definition, the 60 000 ms budget and where it comes from, how to read each finding, and what to change in the Atlas repos for each (scoped pre-commit gate, Gradle parallel and build cache, AWS env on the agent).
- [ ] **Step 2: Live probe.** In the running local instance, create a task for `QA Verifier` in the Atlas company: run `./gradlew compileJava checkstyleMain pmdMain` in `marketplace-service`. Open the task and confirm the row shows the `lint` kind with a real duration, or `environment_blocked` if the S3 403 reproduces.
- [ ] **Step 3: Commit** `docs(maturity): explain the task maturity scorecard`.

---

## Self-review

- **Coverage:** classifier (T1), aggregates and findings (T2), data access and company scope (T3), display (T4), meaning and live proof (T5). Cost and model mix come from `cost_events` in T3. Retries and rework come from `heartbeat_runs` in T2 and T3.
- **Type consistency:** `CheckKind` is defined in shared in T2 and imported by T1, so T2's types file must land before T1's Step 3. Task order stays 1 to 5, and T1 Step 3 creates the `CheckKind` export first.
- **Review Focus:** each line has a test (T2 null-rate and null-exitCode cases, T3 started-without-completed, truncation and cross-company route cases).
- **Open item for the owner:** whether the runner's `subject` field is always populated for Claude shell calls. Observed in 2 of 2 inspected runs. A miss yields an unclassified command, not an error.
