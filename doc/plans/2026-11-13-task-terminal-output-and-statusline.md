# Task Statusline, Run Resource Limits and Run-End Reaping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make slow or quiet agent runs visible and cheaper: a task statusline, a cap on test parallelism inside agent runs, verification guidance for agents, and cleanup of processes a finished run left behind.

**Architecture:** Four independent tasks. The statusline is UI-only. The worker cap is an environment default added where every adapter builds its run environment. The guidance is a section in the runtime skill. Reaping kills only the finished run's own process group.

**Tech Stack:** React + Vite UI, Vitest, `packages/adapter-utils`, `server/`.

**Supersedes:** the earlier output-tail and live-streaming scope, dropped by the user on 2026-11-13. The spike that informed it is in `2026-11-13-task-terminal-output-spike-notes.md`.

## Global Constraints

- No source code comments. Self-documenting names only.
- `DESIGN.md` token-only rule for UI.
- Reaping may kill only processes in the finished run's own process group. Never match by name or pattern. (User approval, 2026-11-13.)
- Run-environment defaults must never override a value the operator or agent config set explicitly.
- Verification is `pnpm verify`, not repo-wide checks.

## Review Focus

- Operator sets `VITEST_MAX_WORKERS` themselves: the default must not replace it.
- A host with 1-3 cores: worker cap must be at least 1.
- A run that exits cleanly with no children: reaping must be a no-op and must not throw.
- A process group id that is already gone or recycled: reaping must not signal an unrelated group.
- Statusline with no usage, no model and no start time: renders nothing, not empty separators.

---

## Task 1: Cap test parallelism in agent runs

**Files:**
- Modify: `packages/adapter-utils/src/server-utils.ts` (`buildPaperclipEnv`, around `:3302-3331`)
- Test: `packages/adapter-utils/src/server-utils.test.ts` (existing `describe("buildPaperclipEnv")` at `:3942`)

**Interfaces:**
- Produces: `defaultAgentTestWorkerCount(cpuCount: number): number` returning `Math.max(1, Math.floor(cpuCount / 4))`, exported from `server-utils.ts`. `buildPaperclipEnv` adds `VITEST_MAX_WORKERS` set to that count as a string unless the host environment already defines `VITEST_MAX_WORKERS` or `PAPERCLIP_AGENT_TEST_WORKERS` (the latter, when set, is the value used).

- [ ] **Step 1: Failing tests.** `defaultAgentTestWorkerCount(15)` is `3`; `(1)` and `(3)` are `1`. `buildPaperclipEnv` result contains `VITEST_MAX_WORKERS` equal to `String(defaultAgentTestWorkerCount(os.availableParallelism()))`; with `process.env.PAPERCLIP_AGENT_TEST_WORKERS = "2"` it is `"2"`; with `process.env.VITEST_MAX_WORKERS = "9"` the key is absent so the host value stands.
- [ ] **Step 2: Run `pnpm vitest run packages/adapter-utils/src/server-utils.test.ts -t buildPaperclipEnv`. Expected: FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(adapter-utils): cap test workers in agent run environments`.

## Task 2: Verification discipline in the runtime skill

**Files:**
- Modify: `skills/paperclip/SKILL.md` (new `## Verifying your work` section)
- Test: existing skill content tests, if any assert section structure (check with `grep -rn "skills/paperclip/SKILL.md" --include=*.test.ts`)

- [ ] **Step 1: Find tests that read `SKILL.md` and note their constraints.**
- [ ] **Step 2: Add the section.** Rules: run the focused test for the changed files first, with fail-fast (`--bail=1`); run the full suite at most once per change, not once per push; if a hook or check fails for environmental reasons (missing binary, sandbox flag), report it and stop retrying the same command; redirect long output to a file and read its tail; say in a task comment what is running when a command will take over a minute.
- [ ] **Step 3: Run the tests found in Step 1. Expected: PASS.**
- [ ] **Step 4: Commit** `docs(skill): add verification discipline for agent runs`.

## Task 3: Reap a finished run's own process group

**Files:**
- Investigate first: `packages/adapter-utils/src/acpx-engine/local-process-control.ts`, `server/src/services/native-runtime/native-codex-runner.ts:391`
- Test: new case in the module's existing test file

**Interfaces:**
- Produces: `reapRunProcessGroup(processGroupId: number | null, signal?: NodeJS.Signals): "no_group" | "already_gone" | "signalled"` in the module where run teardown lives. Refuses ids that are not positive integers and ids equal to the server's own group.

- [ ] **Step 1: Write a failing test** that spawns a detached child which spawns a sleeping grandchild, ends the "run", and asserts the grandchild is gone afterwards. If it already passes, record that in the ledger, add the test as a regression guard, and stop the task: no fix needed.
- [ ] **Step 2: Run it. Expected: FAIL if descendants survive.**
- [ ] **Step 3: Implement `reapRunProcessGroup` and call it at run completion and cancellation.**
- [ ] **Step 4: Re-run. Expected: PASS. Also test `null`, a dead group id and the server's own group id.**
- [ ] **Step 5: Commit** `fix(runtime): reap a finished run's process group`.

## Task 4: Task statusline

**Files:**
- Create: `ui/src/components/task-chat/task-status-line.ts`, `task-status-line.test.ts`, `TaskChatStatusLine.tsx`, `TaskChatStatusLine.test.tsx`
- Modify: `ui/src/components/task-chat/TaskChatThreadView.tsx` (mount beside `TaskChatStatusPill`, around `:211`)
- Reuse: `summarizeRunUsage` (`@/lib/run-usage-summary`), `formatTokens` (`@/lib/utils`)

**Interfaces:**
- Produces: `buildTaskStatusLine(input: { runState: string; activityLabel?: string; startedAt?: string; now: number; model?: string; usageJson?: Record<string, unknown> | null; worktree?: string }): TaskStatusSegment[]`, with `TaskStatusSegment = { id: "state" | "activity" | "elapsed" | "model" | "usage" | "worktree"; text: string }`. Segments without data are omitted.
- Produces: `TaskChatStatusLine` taking the same input and rendering segments joined by `·` in mono micro text, `data-testid="task-chat-status-line"`, ticking once a second while the run is active.

- [ ] **Step 1: Failing tests for the builder.** Start 8m28s before `now` gives elapsed `"8m 28s"`; under a minute gives `"42s"`; missing model omits the model segment; usage 12000 in / 800 out / $0.42 gives `"↑12k ↓800 · $0.42"`; a finished run has no activity segment; no data at all gives `[]`.
- [ ] **Step 2: Run. Expected: FAIL.** **Step 3: Implement. Step 4: Run. Expected: PASS.**
- [ ] **Step 5: Failing render tests:** renders segments with `·`; renders nothing for `[]`; elapsed advances with fake timers; interval cleared on unmount.
- [ ] **Step 6: Implement the component, mount it, extend `TaskChatThreadView.performance.test.tsx` so the tick does not rerender the thread.**
- [ ] **Step 7: `pnpm verify`. Commit** `feat(task-chat): add task statusline`.

## Self-review

- Coverage: statusline (4), performance via worker cap (1) and guidance (2), dangling processes (3).
- Task 3 may end as "already correct, regression test added". That is a valid result.
- Known limit: Task 1 only affects tools that read `VITEST_MAX_WORKERS`; a repo's own hook that hardcodes workers is out of reach.
