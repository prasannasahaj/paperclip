# Chat Session Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/compact` to the Paperclip chat composer, and ship `/handover` and `/fork` as company skills that turn a conversation into a new task.

**Architecture:** Paperclip already compacts context natively: `POST /issues/:id/context/compact` queues a short run that asks the harness to compact (Codex app-server, or Claude's ACP `/compact`), and the Properties panel exposes it as "Compact now". `/compact` becomes a composer action that calls that same endpoint, so no server work is needed. `/handover` and `/fork` are SKILL.md prompts in the company skills store, which the composer's `/` menu already lists.

**Tech Stack:** React + Vitest (`ui/`), TanStack Query, `issuesApi`, `companySkillsApi`.

**Spec:** `doc/plans/2026-11-18-chat-session-commands.md`. This plan supersedes its `/compact` section, see "Change from the approved design".

## Change from the approved design

The approved design had `/compact` as new server code: an agent-written summary that becomes a session boundary. That premise was wrong, because native compaction already exists (`server/src/services/context-compaction.ts`, `server/src/routes/issues.ts:9750`, `ui/src/components/issue-properties/context-usage-row.tsx:74`). The plan therefore wires `/compact` to it instead of building a second mechanism. Consequences:

- `/compact` works in conversations and in task chat, not only conversations.
- It compacts inside the same session using the harness's own compaction. It does not create a new session boundary and has no focus text.
- It is available only where `contextCompactionSupport` says so: `paperclip_runner` agents on Codex, or ACPX with `acpxAgent: "claude"`. Other agents see the command disabled with the server's reason.
- Anyone wanting a clean slate plus a summary still has `/new` (conversations) and `/handover`.

## Global Constraints

- Never author code comments; make names carry the meaning (`~/.claude-talon/CLAUDE.md`).
- UI follows `DESIGN.md`: token-only styling. This plan adds no new styling.
- Keep contracts in sync: no new API, schema or shared types are introduced.
- Bug-style TDD: failing test first, then code (`AGENTS.md` section 10 spirit).
- Verification: `pnpm verify`. Report anything not run.
- Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Check `git status` before staging: the tree has unrelated edits (`doc/talon-onboarding.md`, `scripts/talon-onboarding.config.json`).

## Review Focus

- `/compact` typed while the agent is mid-run: the server returns `agent_busy`, so the composer must show the reason and keep the draft rather than send `/compact` as a comment to the agent.
- `/compact` with trailing text (`/compact be brief`): must not fall through as a message; show an error.
- `/compact` with attachments: must refuse, as `/goal` does.
- `/compact` on an agent whose harness is unsupported: disabled in the menu with the server's reason, and typing it manually shows the same reason.
- `/compact` in a paused conversation: stays blocked like any other message, only `/new` bypasses pause.
- Compaction already pending: a second `/compact` must not queue another run.

## File Structure

- Create `ui/src/components/task-chat/compact-command.ts`: pure parser, `parseCompactCommand`.
- Create `ui/src/hooks/useCompactContext.ts`: shared mutation plus availability, used by both the Properties row and the thread.
- Modify `ui/src/components/issue-properties/context-usage-row.tsx`: use the shared hook instead of its inline mutation.
- Modify `ui/src/components/task-chat/TaskChatComposer.tsx`: menu option, submit handling, new props.
- Modify `ui/src/components/TaskChatThread.tsx`: supply the props from the hook.
- Tests: `ui/src/components/task-chat/compact-command.test.ts`, `TaskChatComposer.test.tsx`, `ui/src/hooks/useCompactContext.test.tsx`.
- No repo files for `/handover` and `/fork`; they are created in the running instance (Task 3).

---

### Task 1: Compact command parser and shared hook

**Files:**
- Create: `ui/src/components/task-chat/compact-command.ts`, `ui/src/hooks/useCompactContext.ts`
- Modify: `ui/src/components/issue-properties/context-usage-row.tsx:65-95`
- Test: `ui/src/components/task-chat/compact-command.test.ts`, `ui/src/hooks/useCompactContext.test.tsx`, and the existing context-usage-row test

**Interfaces:**
- Produces: `parseCompactCommand(value: string): { matched: false } | { matched: true } | { matched: true; error: string }`
- Produces: `useCompactContext(issueId: string | null, assigneeAgentId: string | null): { state: ContextCompactState | null; compact: () => Promise<void> }` where `ContextCompactState` is the existing type returned by `contextCompactState` in `context-usage-row.tsx`.

- [ ] **Step 1: Write failing parser tests** in `compact-command.test.ts`: `"/compact"` and `"  /compact  "` match; `"/compact now"` returns `{ matched: true, error: "/compact does not accept arguments." }`; `"/compacting"`, `"compact"`, `"please /compact"` and `""` are `{ matched: false }`.
- [ ] **Step 2: Run** `pnpm vitest run ui/src/components/task-chat/compact-command.test.ts` and expect FAIL (module not found).
- [ ] **Step 3: Implement `parseCompactCommand`** in `compact-command.ts`. Trim after replacing ` ` with a space; first whitespace-delimited token must equal `/compact`.
- [ ] **Step 4: Run the parser test** and expect PASS.
- [ ] **Step 5: Write failing hook test** in `useCompactContext.test.tsx`, mocking `issuesApi.getContextUsage` and `issuesApi.compactContext`. Cases: `state.status === "available"` with a usage reading whose `compaction.status` is `available`, `compact()` calls `compactContext(issueId)` once; `unavailable` carries the server `reason`; a pending reading yields `{ status: "pending" }`; a rejected `compactContext` pushes the toast "Could not compact the context" and resolves; `issueId: null` yields `state: null` and never calls the API.
- [ ] **Step 6: Implement `useCompactContext`** in `ui/src/hooks/useCompactContext.ts` by moving the query, mutation, `onSettled` invalidations and `onError` toast out of `IssueContextUsageRow`. Reuse `queryKeys.issues.contextUsage(issueId, assigneeAgentId)` so both consumers share one cache entry, and map through the existing `contextCompactState`.
- [ ] **Step 7: Refactor `IssueContextUsageRow`** to call the hook. Its observable behavior and existing tests must be unchanged.
- [ ] **Step 8: Run** `pnpm vitest run ui/src/hooks/useCompactContext.test.tsx ui/src/components/issue-properties` and expect PASS.
- [ ] **Step 9: Commit** `feat(ui): share context compaction hook and add /compact parser`.

### Task 2: `/compact` in the composer

**Files:**
- Modify: `ui/src/components/task-chat/TaskChatComposer.tsx` (props near the `onRunnerGoalCommand` prop; menu at `:1440`; `submit()` before the goal handling at `:944`), `ui/src/components/TaskChatThread.tsx:3732`
- Test: `ui/src/components/task-chat/TaskChatComposer.test.tsx`

**Interfaces:**
- Consumes: `parseCompactCommand`, `useCompactContext` from Task 1.
- Produces: composer props `compactState?: ContextCompactState | null` and `onCompactContext?: () => Promise<void>`.

- [ ] **Step 1: Write failing composer tests** next to the paused-takeover tests, one `it` each:
  - `offers /compact in the slash menu for tasks and conversations`.
  - `runs onCompactContext and does not call onAdd for a bare /compact`, expecting the editor to clear.
  - `shows the server reason and keeps the draft when compaction is unavailable`, with `compactState={{ status: "unavailable", reason: "Available when the agent finishes its current run." }}`; `onCompactContext` not called, `onAdd` not called, the reason shown in the `role="alert"` element, body still `/compact`.
  - `does nothing while compaction is pending`.
  - `rejects /compact with arguments`, expecting "/compact does not accept arguments." and no calls.
  - `rejects /compact with attachments`, expecting "Remove attachments before using /compact."
  - `keeps /compact blocked while a conversation is paused`: with `pause`, `onCompactContext` is not called.
  - `a rejected onCompactContext shows its message and keeps the draft`.
- [ ] **Step 2: Run** `pnpm vitest run ui/src/components/task-chat/TaskChatComposer.test.tsx -t "compact"` and expect FAIL.
- [ ] **Step 3: Add the menu option.** Define `compactCommandOption: ActionCommandOption` (`id: "action:compact"`, `command: "compact"`, `name: "Compact"`, `description: "Summarise this session's context to free space."`, `aliases: ["compact", "summarize"]`, `disabled`/`disabledReason` from `compactState` when it is `unavailable`). Pass `[compactCommandOption, newSessionOption]` for conversation mode and `[goalCommandOption, compactCommandOption]` for task mode; keep `creation ? []`.
- [ ] **Step 4: Handle submit.** In `submit()`, after the `creation` branch and the `queuedEdit` guard, before the goal parse, run `parseCompactCommand(submittedBody)` when `!queuedEdit`. On a match: error entries go to `setActionError`; attachments refuse; `compactState` of `unavailable` sets its reason; `pending`, or a missing `onCompactContext`, returns without sending; otherwise `await onCompactContext()`, then clear the body, draft and editor exactly as the goal path does. A rejection sets `actionError` to the error message and keeps the body. Never fall through to `onAdd`.
- [ ] **Step 5: Wire the thread.** In `TaskChatThread.tsx` call `useCompactContext(issueId, currentAssigneeAgentId)` and pass `compactState={state}` and `onCompactContext={compact}` beside `onRunnerGoalCommand`.
- [ ] **Step 6: Run** the composer test file and `pnpm vitest run ui/src/components/TaskChatThread.test.tsx`; expect PASS with no regressions in the existing `/new` and `/goal` tests.
- [ ] **Step 7: Run `pnpm verify`** and `pnpm --filter @paperclipai/ui typecheck`; expect exit 0. Report anything exit 2 leaves for CI.
- [ ] **Step 8: Commit** `feat(ui): add /compact command to the chat composer`.

### Task 3: `/handover` and `/fork` skills

**Files:**
- None in the repo. Two company skills are created in the running instance with `companySkillsApi.create` (`POST /api/companies/{companyId}/skills`, body `{ name, slug, description, markdown }`).
- Keep the two SKILL.md bodies in `~/projects/talon/claude-workspace/outputs/` (the deliverables folder) as the editable source.

**Interfaces:**
- Consumes: the conversation's existing task-creation path (the `create_task` tool with `initialPlan` and `idempotencyKey`, per `AGENT_CHAT_DIRECTIVE`) and the Paperclip skill's issue API for task chat.
- Produces: skills `handover` and `fork`, appearing as `/handover` and `/fork` in the composer menu.

- [ ] **Step 1: Draft `handover` SKILL.md.** Frontmatter `name: handover` and a one-line description. Body instructs the agent to: write a self-contained brief (outcome, context, decisions made, open items, relevant files and links, acceptance criteria); create one top-level task with `create_task`, `initialPlan` set to the brief and an `idempotencyKey`, assigned to this agent unless the user named another owner in the invocation; read back the created task before claiming it exists; reply with the link; leave this conversation unchanged and unblocked.
- [ ] **Step 2: Draft `fork` SKILL.md.** Same, plus: state in the brief that it forks this conversation and the source continues; include the source conversation identifier; do not wait for the new task.
- [ ] **Step 3: Create both skills** against the user's instance and confirm each appears in `GET /companies/{companyId}/skills`. Needs a running dev server, so state the instance URL and company used.
- [ ] **Step 4: Verify in the UI.** Type `/` in a conversation and confirm `handover` and `fork` are listed. Run `/handover` on a short test conversation; confirm a task appears with the brief and a link back, and the conversation continues. Report what was observed, including anything not run.
- [ ] **Step 5: Revise the doc.** Update `doc/plans/2026-11-18-chat-session-commands.md` to the native-compaction `/compact` and drop the focus text. Commit with the doc: `docs: align chat session commands design with native compaction`.

---

## Self-Review

- **Spec coverage:** `/compact` (Tasks 1 and 2, now via native compaction, change documented at top), `/handover` and `/fork` (Task 3), constraints on user-only triggers (the endpoint already asserts a board user and conversation owner), and the failure path (a failed compaction changes nothing). The `!` shell is out of scope, as in the spec.
- **Type consistency:** `parseCompactCommand`, `useCompactContext`, `compactState` and `onCompactContext` are named identically across tasks.
- **Proportion:** The plan is code-light by design; bodies are specified by test cases and signatures.
- **Not verified:** Whether the user's agent is `paperclip_runner` with a supported provider, so `/compact` may appear disabled for them. Confirm in Task 3 step 4. Whether the thread has a `currentAssigneeAgentId` in scope at `TaskChatThread.tsx:3732`; the builder should pass whatever `useRunnerGoalControl` uses (`effectiveGoalAgentId`, `:706`) if not.
