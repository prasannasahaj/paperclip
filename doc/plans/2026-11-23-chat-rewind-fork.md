# Rewind to here by forking the Claude session — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Rewind to here" on a conversation-chat message deletes every later message and truncates the agent's Claude context to that point, with no message posted and no agent turn spent.

**Architecture:** The runner records the Claude SDK transcript uuid at the end of every turn. Rewind tombstones the later comments on the server, stores the chosen turn-end uuid on the task session, and the next run forks the Claude transcript at that uuid (`forkSession(..., { upToMessageId })`) before the ACP session opens. This replaces the `/rewind` comment command.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk` 0.3.328 (`forkSession`, `getSessionMessages`), `@agentclientprotocol/claude-agent-acp` 0.73.0, ACPX 0.22.0, Drizzle/Postgres, Express, React.

**Spec:** this document, plus `doc/plans/2026-11-18-chat-rewind.md` (the reset-based design this supersedes).

## Global Constraints

- No code comments in new code (repo owner rule); names carry the explanation. Public-API Javadoc exempt.
- Company-scoped; every mutating route logs to the activity log; owner-only like `/new` and compaction (`AGENTS.md` §5, §8; `rules/api-route-expectations.mdc`).
- Contracts synced across `packages/shared`, `server`, `ui` (`AGENTS.md` §5.2). No schema change in this plan: turn-end uuids go in `heartbeat_run_events`, the pending fork goes in `agent_task_sessions.sessionParamsJson`.
- Delete is **soft** (`svc.tombstoneComment`, `server/src/services/issues.ts:~13620`), not hard. Reason: `issues.conversationBoundaryCommentId`, `heartbeat_runs` `wakeCommentId`, `issue_thread_interactions.originCommentIds`, `fast_responses` ids are bare uuids with no FK and would dangle; hard delete also skips the activity-log and external-object sync that `tombstoneComment` does.
- Claude agents only. Other adapters have no fork; the action is not offered for them.
- Verification per `AGENTS.md` §7: `pnpm verify`, then required CI.

## Decisions to check

- A rewind target is an **agent reply**; it resolves to the **last comment of the run that produced it** (a turn cannot be cut mid-way). Rewinding "before a user message" is not offered.
- No file or workspace undo (the SDK has `rewindFiles`; deliberately out of scope).
- Rewind is refused while a run is active on the issue, and cannot cross a `/new` boundary.
- Runs from before this ships have no recorded turn-end uuid; their messages are not rewindable.
- Comments already delivered to Teams/Slack cannot be recalled; they are tombstoned in Paperclip only.

## Review Focus

- Target is an early comment of a multi-comment run → snaps to the run's last comment; later runs' comments are the ones deleted.
- Target has no recorded turn-end uuid (old run, non-Claude agent) → 422 with a reason, nothing deleted.
- Run in flight when rewind is requested → 409, nothing deleted.
- Rewind request retried or double-clicked → second call is a no-op, not a second fork.
- Pending `ask_user_questions` interactions created after the target are expired, as `/new` does.
- Session compacted earlier in the thread → the fork point may not exist in the compacted chain. **Unknown**; Task 0 must test it.
- Remote runner (ssh/sandbox) → fork must happen runner-side at session open, never from the server.

## File Structure

- `packages/paperclip-runner/src/drivers/acpx/claude-session-fork.ts` (create): fork + record rewrite. One responsibility.
- `packages/paperclip-runner/src/drivers/acpx/claude-turn-end-uuid.ts` (create): read the last transcript uuid after a turn.
- `server/src/services/conversation-rewind.ts` (create): validate, resolve fork point, tombstone, stage fork.
- `packages/shared/src/conversation-rewind.ts` (modify): replace `/rewind <id>` parser with request/response validators and the API path.
- `server/src/routes/issues.ts` (modify): new route.
- `ui/src/components/task-chat/*` (modify): action calls the endpoint; greying removed.

## Task 0: Go/no-go proof in the runner (local runner only)

**Files:** Create `packages/paperclip-runner/src/drivers/acpx/claude-session-fork.ts`, Test `.../claude-session-fork.test.ts`

**Interfaces:**
- Produces: `forkClaudeSessionAt(input: { claudeConfigDir: string; cwd: string; sourceSessionId: string; upToMessageUuid: string }): Promise<{ forkedSessionId: string }>` and `rewriteAcpxRecordSessionId(input: { stateDirectory: string; providerSessionKey: string; forkedSessionId: string }): Promise<void>`

- [ ] **Step 1:** Read `acpx-runtime-adapter.ts:~284-310` (`sessionStore.load`, `record.acpSessionId`, `record.agentSessionId`) and `runtime-sandbox.ts:376-421` to confirm which acpx-state file holds the ids and that `claude-home` is under the same sandbox root. Reflect what you find in the test names and fixture names.
- [ ] **Step 2:** Test `forks a two-turn transcript at the first turn's end uuid and the fork has one turn`: build a real two-turn transcript with the SDK in a temp `CLAUDE_CONFIG_DIR`, call `forkClaudeSessionAt`, assert `getSessionMessages(forkedSessionId)` ends at the given uuid.
- [ ] **Step 3:** Test `a compacted source transcript can be forked at a post-compaction turn end` (the Unknown above). If it fails, record the failure in this plan and stop; compaction then needs its own handling.
- [ ] **Step 4:** Test `after rewriteAcpxRecordSessionId, ensureSession resumes the forked id`: run `createAcpxRuntimeAdapter` against the temp state dir with a mock/real Claude and assert the resumed session id equals `forkedSessionId`.
- [ ] **Step 5:** Run `pnpm --filter @paperclipai/paperclip-runner exec vitest run claude-session-fork`. Expected: PASS. **If Step 4 cannot be made to pass, stop and report; the rest of this plan depends on it.**
- [ ] **Step 6:** Commit `feat(runner): fork a Claude transcript at a turn end`.

## Task 1: Record each turn's end uuid

**Files:** Create `claude-turn-end-uuid.ts` (+ test); Modify `packages/paperclip-runner/src/drivers/acpx/claude-provider-turns.ts` (emit), `server/src/services/native-runtime/native-session-executor.ts` (persist event)

**Interfaces:**
- Produces: `readClaudeTurnEndUuid(input: { claudeConfigDir: string; cwd: string; sessionId: string }): Promise<string | null>`; run event `eventType: "claude_turn_end"`, payload `{ providerSessionId: string; uuid: string }` in `heartbeat_run_events`.

- [ ] **Step 1:** Test `returns the uuid of the last chain entry of a finished turn` using a fixture transcript.
- [ ] **Step 2:** Implement via `getSessionMessages`; run the test.
- [ ] **Step 3:** Test (server) `a completed claude run has exactly one claude_turn_end event`; implement the emit when `ClaudeProviderCycles` yields `ended` with `status: "completed"`.
- [ ] **Step 4:** Run `pnpm verify`; commit `feat: record Claude turn-end uuid per run`.

## Task 2: Fork at session open

**Files:** Modify `packages/paperclip-runner/src/drivers/acpx/acpx-runtime-adapter.ts:~650-680` (before `runtime.ensureSession`), execution-input type carrying the staged fork (`PersistedNativeSession` checkpoint in `server/src/services/heartbeat/native-session-resume.ts`).

**Interfaces:**
- Consumes: Task 0 functions.
- Produces: optional `rewindToTurnEndUuid?: string` on the native execution input; when present the adapter calls `forkClaudeSessionAt` then `rewriteAcpxRecordSessionId` before `ensureSession`, once.

- [ ] **Step 1:** Test `a run with rewindToTurnEndUuid opens the forked session and not the original`.
- [ ] **Step 2:** Test `the fork is applied once; a second run with the same input does not fork again`.
- [ ] **Step 3:** Implement; thread the field from `sessionParamsJson.rewindToTurnEndUuid` through `buildNativeExecutionWithCheckpoint` (`runtime-selection.ts:~930`); clear it from `sessionParamsJson` after the run publishes (`native-task-session-publication.ts:~139`).
- [ ] **Step 4:** `pnpm verify`; commit `feat: apply a staged transcript fork when a session opens`.

## Task 3: Server rewind service

**Files:** Create `server/src/services/conversation-rewind.ts` (+ `server/src/__tests__/conversation-rewind.test.ts`)

**Interfaces:**
- Produces: `rewindConversationToComment(db: Db, input: { issueId: string; companyId: string; targetCommentId: string; actor: { userId: string } }): Promise<{ keptThroughCommentId: string; deletedCommentIds: string[] }>`; throws `unprocessable` (target ineligible / no turn-end uuid) and `conflict` (run active).

- [ ] **Step 1:** Tests, one per Review Focus line above, with these assertions: multi-comment run snaps to last comment; no `claude_turn_end` → 422 and zero comments tombstoned; active run → 409; second identical call returns the same result with one `issue.conversation_rewound` activity row; interactions after the target are `expired`; `conversationBoundaryCommentId` unchanged.
- [ ] **Step 2:** Implement: reuse the target checks in `assertConversationRewindTarget` (`agent-conversations.ts:~75`) minus the command parsing; resolve run via `createdByRunId` → its `claude_turn_end` event; tombstone later comments via `svc.tombstoneComment`; write `rewindToTurnEndUuid` into the task session's `sessionParamsJson`; log `issue.conversation_rewound` with `{ targetCommentId, keptThroughCommentId, deletedCount }`, all in one transaction except the per-comment tombstones.
- [ ] **Step 3:** `pnpm verify`; commit `feat(server): rewind a conversation to a comment`.

## Task 4: Route and contract

**Files:** Modify `packages/shared/src/conversation-rewind.ts`, `packages/shared/src/index.ts`, `server/src/routes/issues.ts` (new `POST /issues/:id/conversation/rewind`, beside compaction at `:9395`), `ui/src/api/issues.ts` client.

**Interfaces:**
- Produces: `rewindConversationRequestSchema = z.object({ commentId: z.string().uuid() })`; response `{ keptThroughCommentId: string; deletedCount: number }`; `ISSUE_API_PATHS.conversationRewind(issueId)`.

- [ ] **Step 1:** Route tests: 403 for non-owner, 404 other company's issue, 422 body, 200 happy path, paused conversation follows `/new`'s exemption (`routes/issues.ts:~20036`).
- [ ] **Step 2:** Implement, calling Task 3; `pnpm verify`; commit `feat: conversation rewind endpoint`.

## Task 5: UI

**Files:** Modify `ui/src/components/task-chat/TaskChatBubbleActions.tsx`, `TaskChatThread.tsx`, `rewind-context.tsx`, `task-chat-adapter.ts`; Test alongside.

- [ ] **Step 1:** Tests: the action shows on agent replies only; confirming a dialog ("Delete N later messages and rewind the agent? This cannot be undone.") calls the endpoint and removes later comments from the thread; a 422/409 shows the server's reason in the thread, not silently.
- [ ] **Step 2:** Implement; deleted-by-rewind comments are hidden, not rendered as tombstone placeholders; `pnpm verify`; commit `feat(ui): rewind to here deletes later messages`.

## Task 6: Remove the `/rewind` comment command

Only after the user has used Task 5 on a real conversation and approved.

**Files:** the 25 files in `git diff --stat 7aea15831f^..HEAD` that implement `/rewind`: `packages/shared/src/conversation-rewind*`, rewind branches in `agent-conversations.ts`, `native-session-handoff.ts`, `confirmation-comment-resolution.ts`, `execution-blocker.ts`, `onboarding-first-task-admission.ts`, `tool-action-replay-intent.ts`, and UI `rewind-targets.ts`, composer picker, greying.

- [ ] **Step 1:** Delete in one commit `refactor: remove /rewind comment command`; run `pnpm verify`; update `doc/plans/2026-11-18-chat-rewind.md` status to superseded.
