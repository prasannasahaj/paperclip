# Task Terminal Output and Statusline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Paperclip task show what a running agent is doing the way Claude Code does: live command output inline, and a statusline for the task.

**Architecture:** Three pieces, in order. (1) A UI-only terminal-style output tail on command rows, with no 600-character clip. (2) Live streaming of command output for the Claude/ACP path, gated on a spike that proves what the event stream carries. (3) A task statusline built only from data the run already exposes.

**Tech Stack:** React + Vite UI (`ui/`), Vitest, runner event projection in `packages/paperclip-runner`, `DESIGN.md` tokens (token-only rule).

**Spec:** Conversation of 2026-11-13. The user asked for live streaming as well as the UI fix, wants Paperclip to "almost behave like Claude Code", and said "I dont see statusline for tasks" without naming fields. The statusline fields in Task 3 are the author's call.

## Global Constraints

- Follow `DESIGN.md`: tokens only, no hardcoded colors or sizes. Existing rows use `text-(length:--text-micro)` and `font-mono`.
- No source code comments (user rule). Self-documenting names only.
- Runner caps command output at `MAX_OUTPUT = 64 * 1024` bytes, keeping the tail (`packages/paperclip-runner/src/provider-events.ts:136`, `:687`). The UI must not clip below that for command rows.
- Keep contracts synchronized across `packages/shared`, `server`, `ui` if any payload shape changes (`AGENTS.md` section 5.2).
- Output is untrusted agent text. Render as text, never as HTML.
- Verification is `pnpm verify`. Do not run repo-wide checks by default (`AGENTS.md` section 7).

## Review Focus

- Output with ANSI escape codes (colors, cursor moves): must render as readable text, not raw `\u001b[` noise.
- Output with `\r` progress rewrites (npm, curl): must show the last rewrite of a line, not hundreds of lines.
- Output of 64 KB with very long single lines: row must not overflow horizontally or freeze the thread.
- A command with empty output that exits 0: must say so, not show a blank panel.
- A run that is interrupted mid-stream: partial output stays visible and the row reads "Interrupted", not "Running".
- Many concurrent running commands in one turn: only bounded work per render (see `TaskChatThreadView.performance.test.tsx`).

---

## Task 0: Spike - what does a Claude run actually stream?

Throwaway investigation. Produces a recorded fixture and a written decision, no product code.

**Files:**
- Create: `doc/plans/2026-11-13-task-terminal-output-spike-notes.md` (findings)
- Create: `packages/paperclip-runner/src/drivers/acpx/__fixtures__/claude-bash-stream.jsonl` (recorded raw ACP events, secrets scrubbed)

**Interfaces:**
- Produces: a yes/no on each question below, which selects Task 2's branch.

- [ ] **Step 1: Run a real Claude task whose agent runs `for i in 1 2 3 4 5; do echo line $i; sleep 3; done` as a foreground Bash call, then the same with `run_in_background`.**
- [ ] **Step 2: Capture the raw ACP events for both runs and note, for each: does any `tool_call_update` with `rawOutput` or `content` arrive before the command exits?**
- [ ] **Step 3: For the background case, note where the output lives (task output file path) and whether the runner process can read it.**
- [ ] **Step 4: Write the answers in the notes file. Commit the fixture and notes.**

```bash
git add doc/plans/2026-11-13-task-terminal-output-spike-notes.md
git commit -m "docs: record what Claude ACP streams for long commands"
```

Decision rule: if foreground output arrives incrementally, Task 2 is branch A. If not, Task 2 is branch B. If background output is only readable from a file, Task 2 also needs branch C.

---

## Task 1: Inline terminal output tail on command rows

UI-only. Works with whatever output the transcript already holds, including completed results and Codex deltas.

**Files:**
- Create: `ui/src/components/task-chat/tool-output.ts`
- Create: `ui/src/components/task-chat/tool-output.test.ts`
- Create: `ui/src/components/task-chat/TaskChatToolOutput.tsx`
- Create: `ui/src/components/task-chat/TaskChatToolOutput.test.tsx`
- Modify: `ui/src/components/task-chat/TaskChatToolCard.tsx` (render the tail for command rows)
- Modify: `ui/src/components/task-chat/transcript-adapter.ts:292`, `:662-670` (command output no longer clipped at 600)
- Modify: `ui/src/components/task-chat/task-chat-model.ts:240` (add `output` field to `TaskChatToolItem`)

**Interfaces:**
- Produces in `tool-output.ts`:
  - `normalizeTerminalOutput(raw: string): string` strips ANSI escape sequences and collapses `\r` rewrites to the last rewrite per line.
  - `tailLines(text: string, count: number): { lines: string[]; hiddenLineCount: number }`.
  - `COMMAND_OUTPUT_PREVIEW_LINES = 10`.
- Produces in `task-chat-model.ts`: `TaskChatToolItem.output?: string` holding full normalized command output. `detail` stays for non-command tools.
- Produces: `TaskChatToolOutput({ output, running, exitCode }: { output?: string; running: boolean; exitCode?: number | null })`.

- [ ] **Step 1: Write failing tests in `tool-output.test.ts`.** Cases: `normalizeTerminalOutput("\u001b[31mfail\u001b[0m")` equals `"fail"`; `normalizeTerminalOutput("10%\r50%\r100%")` equals `"100%"`; `tailLines` of 25 lines with count 10 returns the last 10 lines and `hiddenLineCount` 15; empty string returns zero lines.
- [ ] **Step 2: Run `pnpm vitest run ui/src/components/task-chat/tool-output.test.ts`. Expected: FAIL, module not found.**
- [ ] **Step 3: Implement `normalizeTerminalOutput` and `tailLines` in `tool-output.ts`.**
- [ ] **Step 4: Run the same test. Expected: PASS.**
- [ ] **Step 5: Write failing tests in `TaskChatToolOutput.test.tsx`.** Cases: shows only the last 10 of 25 lines plus a "15 earlier lines" control; clicking it shows all 25; `running` with no output renders a "Waiting for output" line; finished with empty output and `exitCode` 0 renders "No output"; `exitCode` 1 renders the code in destructive tone via a `data-testid="task-chat-tool-exit-code"`.
- [ ] **Step 6: Run it. Expected: FAIL.**
- [ ] **Step 7: Implement `TaskChatToolOutput` as a mono, left-rail block matching the existing `task-chat-tool-target-detail` styling in `TaskChatToolCard.tsx:130-137`. Cap height with scroll, `whitespace-pre-wrap`, `break-words`. Auto-follow the tail while `running`.**
- [ ] **Step 8: In `transcript-adapter.ts`, route `tool_result` content for command tools (`operation === "execute"`) into `TaskChatToolItem.output` via `normalizeTerminalOutput`, appending when `entry.delta`. Leave the 600 clip for every other tool. Add a test in `transcript-adapter.test.ts`: a 5,000-character command result is stored whole in `output`.**
- [ ] **Step 9: In `TaskChatToolCard.tsx`, render `TaskChatToolOutput` for command rows, expanded by default while `status === "in_progress"`, collapsed to the preview otherwise. Extend `TaskChatRunnerActivityGroup.toolRows.test.tsx` with a running command that shows streamed lines.**
- [ ] **Step 10: Run `pnpm verify`. Expected: pass or exit 2 with focused checks green. Commit.**

```bash
git add ui/src/components/task-chat
git commit -m "feat(task-chat): show command output inline on tool rows"
```

---

## Task 2: Live streaming of command output (gated on Task 0)

Choose the branch the spike selected. Each branch ends with the Task 1 UI receiving `tool_result` entries with `delta: true` while the command runs.

**Files:**
- Modify: `packages/paperclip-runner/src/provider-events.ts` (around `:1655-1700`, the `tool_call` projection)
- Modify: `ui/src/adapters/paperclip-runner/index.ts` (around `:250-295`, where output deltas become `tool_result` with `delta: true`)
- Test: `packages/paperclip-runner/src/provider-events.test.ts`, `ui/src/adapters/paperclip-runner/index.test.ts`

**Interfaces:**
- Consumes: Task 1's `TaskChatToolItem.output` path via `tool_result` with `delta: true`.
- Produces: `tool.execution.progressed` payloads carrying the new output text in `progress` for ACP tool calls, matching the shape Codex already produces at `provider-events.ts:1091-1105`.

- [ ] **Branch A (ACP streams output):** Step 1: failing test in `provider-events.test.ts` feeding the Task 0 fixture and asserting a `tool.execution.progressed` event per incremental `rawOutput`, with only the new suffix in `progress`. Step 2: implement the diffing of cumulative `rawOutput` into suffix deltas inside the `tool_call` projection. Step 3: failing then passing test in `ui/src/adapters/paperclip-runner/index.test.ts` that the suffix becomes `tool_result` with `delta: true`.
- [ ] **Branch B (ACP does not stream):** write down in the spike notes that live output is not available from Claude over ACP, show the elapsed-time and "Waiting for output" state from Task 1, and open a follow-up issue. Do not fake streaming.
- [ ] **Branch C (background output only in a file):** add a runner-side tail of the task output file that emits `tool.execution.progressed`. Only the runner process may read the path; validate that the path is inside the run's own sandbox before reading, and cap reads to the last `MAX_OUTPUT` bytes. Requires its own failing test using a temp file.
- [ ] **Final step: run `pnpm verify` and commit.**

```bash
git add packages/paperclip-runner ui/src/adapters/paperclip-runner
git commit -m "feat(runner): stream command output while a Claude command runs"
```

---

## Task 3: Task statusline

Fields are the author's call, built only from data the run already exposes: run state, current activity label, elapsed time, model, token and cost totals, worktree or branch. Context-window percent is included only if the Task 0 events or `usageJson` carry it; otherwise omitted.

**Files:**
- Create: `ui/src/components/task-chat/task-status-line.ts` (pure builder)
- Create: `ui/src/components/task-chat/task-status-line.test.ts`
- Create: `ui/src/components/task-chat/TaskChatStatusLine.tsx`
- Create: `ui/src/components/task-chat/TaskChatStatusLine.test.tsx`
- Modify: `ui/src/components/task-chat/TaskChatThreadView.tsx` (mount near the composer, around the existing `TaskChatStatusPill` at `:211`)
- Reuse: `summarizeRunUsage` from `@/lib/run-usage-summary`, `formatTokens` from `@/lib/utils`

**Interfaces:**
- Produces: `buildTaskStatusLine(input: { runState: string; activityLabel?: string; startedAt?: string; now: number; model?: string; usageJson?: Record<string, unknown> | null; worktree?: string }): TaskStatusSegment[]` where `TaskStatusSegment = { id: "state" | "activity" | "elapsed" | "model" | "usage" | "worktree"; text: string }`. Segments with no data are omitted.
- Produces: `TaskChatStatusLine(props: Parameters<typeof buildTaskStatusLine>[0])`.

- [ ] **Step 1: Write failing tests in `task-status-line.test.ts`.** Cases: a running run with `startedAt` 8m28s before `now` yields an `elapsed` segment `"8m 28s"`; missing `model` omits the `model` segment; usage with `inputTokens` 12000, `outputTokens` 800, `costUsd` 0.42 yields `"↑12k ↓800 · $0.42"` using `formatTokens`; a finished run has no `activity` segment.
- [ ] **Step 2: Run `pnpm vitest run ui/src/components/task-chat/task-status-line.test.ts`. Expected: FAIL.**
- [ ] **Step 3: Implement `buildTaskStatusLine`. Format elapsed as `Xm Ys`, under a minute as `Ys`.**
- [ ] **Step 4: Run it. Expected: PASS.**
- [ ] **Step 5: Write failing render tests in `TaskChatStatusLine.test.tsx`: segments render joined by `·` in mono micro text with `data-testid="task-chat-status-line"`; renders nothing when no segments; elapsed ticks each second while running (fake timers).**
- [ ] **Step 6: Implement `TaskChatStatusLine` following `TaskChatRunUsageFooter.tsx` styling. Tick via a single interval cleaned up on unmount.**
- [ ] **Step 7: Mount in `TaskChatThreadView.tsx`; extend `TaskChatThreadView.performance.test.tsx` to confirm the tick does not rerender the whole thread.**
- [ ] **Step 8: Run `pnpm verify` and commit.**

```bash
git add ui/src/components/task-chat
git commit -m "feat(task-chat): add task statusline"
```

---

## Self-review

- Spec coverage: inline output (Task 1), live streaming (Tasks 0 and 2), statusline (Task 3). The "behave like Claude Code" ask is covered by those three, not by a wider rebuild.
- Known gap: Task 2 cannot be fully specified before the spike. Its branches are the decision points, not placeholders.
- Types: `TaskChatToolItem.output` is defined in Task 1 and consumed by Task 2 only through the existing `tool_result` and `delta` path.
