# /rewind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a conversation owner return to an earlier message so the derailed stretch after it is greyed in the thread and excluded from the agent's context.

**Architecture:** `/rewind <commentId>` is a user comment handled exactly like `/new` (boundary, generation bump, fresh session). The fresh session's handoff gains a rewind block telling the agent to rebuild the state up to the target message from the thread and documents. The UI derives the greyed range from the comment body.

**Tech Stack:** Express + Drizzle (`server/`), shared parsers (`packages/shared`), React + Vitest (`ui/`).

**Spec:** `doc/plans/2026-11-18-chat-rewind.md`

## Change from the approved design

The design said the rewind run is a short agent turn that writes a state note and acknowledges. That is not how `/new` works: the server finishes the `/new` run immediately with no agent turn (`server/src/services/heartbeat.ts:2259-2268`), and delivery, blocker and settlement paths all assume that. Making rewind an agent turn would rewire the run lifecycle. This plan instead:

- Treats `/rewind` as an instant reset like `/new`, with no run output. The thread marker is the acknowledgement.
- Carries the "rebuild the state up to the target" instruction in the fresh-session handoff, so it is the first thing the agent does on your next message, before answering it. The handoff is injected only into fresh sessions (`hydrateFreshSessionHandoff`, `packages/adapter-utils/src/server-utils.ts:2213`).
- Still asks the agent to save the state as an issue document under `rewind-state-<generation>`.

Cost: the first reply after a rewind is slower, and the note exists only once you send a message. Everything else in the spec stands.

## Global Constraints

- Never author code comments; names carry meaning (`~/.claude-talon/CLAUDE.md`).
- Company-scoped, owner-only, activity-logged like `/new`; no schema change.
- Contracts stay in sync across `packages/shared`, `server`, `ui`.
- UI: token-only styling per `DESIGN.md`.
- Exact command shape: `/rewind <uuid>` (single space, lowercase hyphenated UUID, nothing else). Anything else is an ordinary message.
- Verification: targeted vitest per task, `ui` typecheck, server typecheck. `pnpm verify` already exits 1 on this branch (stale `tests/runner-e2e/source-sdk-public-inputs.json`); report it, do not regenerate.
- Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; run `git status` first, the tree has unrelated edits.

## Review Focus

- Target in another conversation, deleted, before the current boundary, a system notice or a question card: 422, nothing resets, composer shows why.
- `/rewind` typed with extra text, uppercase or no id, or an agent-authored `/rewind`: an ordinary message and never a reset.
- Rewinding to the latest message (nothing to drop): allowed, behaves as a reset.
- Paused conversation: `/rewind` is allowed and releases the pause like `/new`.
- A retried POST with the same `clientRequestId` resets once.
- The rewind block appears only for the first fresh session after a rewind, not after a later `/new`.
- Greyed range must start after the target and end at the rewind marker, and survive two rewinds in one thread.

## File Structure

- Create `packages/shared/src/conversation-rewind.ts`: `parseConversationRewind`, `buildConversationRewindBody`. Export from `packages/shared/src/index.ts`.
- Modify `server/src/services/agent-conversations.ts:90`: `isConversationReset` also accepts rewind bodies.
- Modify the literal `/new` checks: `server/src/routes/issues.ts:20036`, `server/src/services/confirmation-comment-resolution.ts:69`, `server/src/services/tool-action-replay-intent.ts:50`.
- Modify `server/src/routes/issues.ts` (the conversation comment path near `:20028`): validate the target.
- Modify `server/src/services/native-runtime/native-session-handoff.ts`: rewind block.
- Modify `ui/src/components/task-chat/task-chat-adapter.ts:70-80`: rewind marker and greyed items.
- Modify `ui/src/components/task-chat/TaskChatBubble.tsx`, `TaskChatBubbleActions.tsx`: greyed style, "Rewind to here".
- Modify `ui/src/components/task-chat/TaskChatComposer.tsx`, `ui/src/components/TaskChatThread.tsx`: `/rewind` picker and wiring.

---

### Task 1: Shared rewind command parser

**Files:** Create `packages/shared/src/conversation-rewind.ts`, modify `packages/shared/src/index.ts`; Test `packages/shared/src/conversation-rewind.test.ts`.

**Interfaces:**
- Produces: `parseConversationRewind(body: string): { targetCommentId: string } | null`
- Produces: `buildConversationRewindBody(targetCommentId: string): string` returning `/rewind <id>`.

- [ ] **Step 1: Write failing tests.** `parses a canonical rewind body` (`/rewind 3f2c1a6e-8b7d-4c1e-9a55-0d6f2b7e1a10` with surrounding whitespace trimmed yields the id); `rejects extra text`, `rejects uppercase ids`, `rejects a missing id`, `rejects an invalid uuid`, `rejects /new`; `buildConversationRewindBody round-trips through parseConversationRewind`.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/conversation-rewind.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement both functions** with one anchored regex on the trimmed body; export from the shared index.
- [ ] **Step 4: Run it again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): parse /rewind conversation commands`.

### Task 2: Server treats /rewind as a reset

**Files:** Modify `agent-conversations.ts:90`, the three literal `/new` sites, `routes/issues.ts` (comment path); Test `server/src/__tests__/agent-conversations.test.ts`.

**Interfaces:**
- Consumes: `parseConversationRewind` (Task 1).
- Produces: `isConversationReset(body)` true for `/new` and rewind bodies; the `issue.conversation_session_started` activity details gain `rewoundToCommentId: string | null`.

- [ ] **Step 1: Write failing tests** beside the existing `/new` cases (`agent-conversations.test.ts:253`, `:277`, `:348`, `:554`, `:721`): `a user /rewind comment resets the session like /new`, `an agent-authored /rewind does not reset`, `a retried /rewind with the same clientRequestId resets once`, `/rewind is accepted while the conversation is paused and releases the hold`, `a target from another conversation is rejected with 422 and does not reset`, `a deleted target is rejected`, `a target before the current boundary is rejected`, `a system-notice target is rejected`, `the session-started activity records rewoundToCommentId`.
- [ ] **Step 2: Run** `pnpm vitest run server/src/__tests__/agent-conversations.test.ts -t "rewind"`. Expected: FAIL.
- [ ] **Step 3: Implement.** `isConversationReset` returns `body.trim() === "/new" || parseConversationRewind(body) !== null`. Replace the three literal checks with `isConversationReset(...)`. In the route, before the transaction, when the body parses as a rewind, load the target and require: same company and issue, not deleted, plain comment (user, or the conversation's agent, with no system-notice presentation and not a receipt), created after the current boundary and before now; else `throw unprocessable("Choose a message from the current session to rewind to")`. Add `rewoundToCommentId` to the activity details in `prepareConversationTurn`.
- [ ] **Step 4: Run the full file** `pnpm vitest run server/src/__tests__/agent-conversations.test.ts server/src/services/confirmation-comment-resolution.test.ts server/src/services/tool-action-replay-intent.test.ts`. Expected: PASS with no `/new` regressions.
- [ ] **Step 5: Commit** `feat(server): handle /rewind as a conversation reset`.

### Task 3: Rewind block in the fresh-session handoff

**Files:** Modify `native-session-handoff.ts` (`buildNativeSessionHandoff`); Test `server/src/services/native-runtime/native-session-handoff.test.ts`.

**Interfaces:**
- Consumes: `parseConversationRewind`.
- Produces: when the current boundary comment body parses as a rewind, the handoff string begins with a `## Rewound conversation` block naming `targetCommentId`, the previous session boundary id (the newest earlier comment with a session generation, or none), and the instruction.

- [ ] **Step 1: Write failing tests:** `includes the rewind block when the boundary is a /rewind`, `names the target and the previous boundary`, `tells the agent to ignore comments after the target and use only documents created before it`, `tells the agent to save the state as rewind-state-<generation>`, `omits the block when the boundary is /new`, `omits the block when there is no boundary`.
- [ ] **Step 2: Run** `pnpm vitest run server/src/services/native-runtime/native-session-handoff.test.ts -t "rewind"`. Expected: FAIL.
- [ ] **Step 3: Implement.** Widen the boundary select to include `body`; resolve the previous boundary with one query; prepend the block to the rendered handoff. Keep it a plain text block outside the JSON entries so the 24 KB entry budget is unchanged.
- [ ] **Step 4: Run the file.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): brief a rewound session to rebuild state first`.

### Task 4: Thread shows the rewind

**Files:** Modify `task-chat-adapter.ts:70-80`, `TaskChatBubble.tsx`; Test `task-chat-adapter.test.ts` (or the nearest existing adapter test), `TaskChatBubble.test.tsx`.

**Interfaces:**
- Consumes: `parseConversationRewind`.
- Produces: marker items with `label: "Rewound"` and `detail` naming the target excerpt; message items between target and marker carry `rewound: true`.

- [ ] **Step 1: Write failing tests:** `renders a rewind boundary as a Rewound marker`, `marks only comments after the target and before the marker as rewound`, `keeps rewound comments in the list`, `handles two rewinds in one thread`, `a rewind to an unknown target renders a plain marker and greys nothing`, bubble: `renders a rewound message greyed with a Rewound label`.
- [ ] **Step 2: Run** the two test files with `-t rewind`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `commentsToTaskChatItems`, do a first pass finding each rewind comment and its target index; mark the covered items; style the bubble with existing muted tokens.
- [ ] **Step 4: Run** `pnpm vitest run ui/src/components/task-chat`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): show rewound stretches greyed in the thread`.

### Task 5: /rewind picker and "Rewind to here"

**Files:** Modify `TaskChatComposer.tsx`, `TaskChatBubbleActions.tsx`, `TaskChatThread.tsx`; Test `TaskChatComposer.test.tsx`, `TaskChatBubbleActions` test.

**Interfaces:**
- Consumes: `buildConversationRewindBody`.
- Produces: composer prop `rewindTargets?: Array<{ id: string; authorLabel: string; excerpt: string }>`; bubble action prop `onRewindTo?: (commentId: string) => void`. Both post the rewind body through the composer's existing `onAdd`.

- [ ] **Step 1: Write failing tests:** composer `offers /rewind in the slash menu in conversation mode only`, `choosing a target posts /rewind <id> through onAdd`, `lists user messages and agent replies after the boundary, newest first`, `hides /rewind when there are no targets`, `shows the server error and keeps the draft when the target is rejected`; bubble `shows Rewind to here only in a conversation and only for a message after the boundary`, `Rewind to here posts the rewind body`.
- [ ] **Step 2: Run** with `-t rewind`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add a `rewind` action command (conversation mode) that opens a small list under the composer; the thread computes `rewindTargets` from the post-boundary items and passes `onRewindTo` to bubbles.
- [ ] **Step 4: Run** `pnpm vitest run ui/src/components/task-chat ui/src/components/TaskChatThread`, then `ui` and `server` typecheck. Expected: PASS, no errors.
- [ ] **Step 5: Commit** `feat(ui): add /rewind picker and Rewind to here`.

### Task 6: Docs and manual check

- [ ] **Step 1:** Update `doc/plans/2026-11-18-chat-rewind.md` to the instant-reset-plus-handoff design above (drop the rewind-run turn and acknowledgement, keep the state note document).
- [ ] **Step 2: Manual check** in a conversation: build up a few messages, ask a side question, `/rewind` to before it, send a message, confirm the agent's reply reflects the pre-side-question state and the side question is greyed. Report what was observed, or that it was not run.
- [ ] **Step 3: Commit** `docs: align /rewind design with the reset-based implementation`.

---

## Self-Review

- **Spec coverage:** command and picker (Tasks 2, 5), reset reuse (Task 2), state note and document key (Task 3), greying and marker (Task 4), pause (Task 2), failure fallback (no change needed: instant reset, handoff always available), validation rules (Task 2).
- **Type consistency:** `parseConversationRewind` and `buildConversationRewindBody` are named identically in Tasks 1 to 5; `rewindTargets` and `onRewindTo` appear in Task 5 only.
- **Proportion:** step text names tests and signatures only.
- **Not verified:** where the existing adapter and bubble tests live (names are the nearest guesses), and the route's exact shape near `routes/issues.ts:20028`. The implementer reads the neighbours.
