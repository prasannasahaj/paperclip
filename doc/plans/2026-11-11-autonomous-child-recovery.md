# Autonomous Child Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A failed, interrupted or stuck child task no longer needs a board operator: the parent agent (or the system) respawns it as a new task in a fresh isolated workspace, carrying the predecessor's partial output, bounded and fully logged.

**Architecture:** (1) Remove the false "process space unverified" trigger on macOS so restarts and network changes stop blocking tasks. (2) Give parent agents a bounded respawn primitive that does not depend on proving the old owner stopped: the successor never shares the predecessor's workspace, so a stale writer cannot corrupt it, and external effects (pushes, MR comments) are reconciled by the parent from a handoff ledger. (3) Wake the parent when a child is stuck and tell it, in a skill reference, how to act like a person: inspect, respawn with context, try a different approach, escalate only after the bound.

**Tech Stack:** TypeScript, Express, Drizzle, Vitest, `packages/shared` validators.

**Spec:** Conversation of 2026-11-11 (no separate design doc). Evidence: TAC-98 recovery action `af195488-…`, run `51f32c7c-…`. Recorded host hash `502c30de9341c0cc9236f3fecad6c0e9` equals `sha256("Prasanna-Sahaj.local" + "\0" + kern.bootsessionuuid)[0:32]`; `os.hostname()` is now `Prasanna-Sahaj.communityfibre.co.uk`; boot is unchanged.

## Global Constraints

- Repo rules: `rules/upgrade-safe-run-state.mdc` (state the previous-release story; refuse unknown identity permanently and by name; add an old-saved/new-resumed test) and `rules/heartbeat-execution-boundaries.mdc` (retries must not bypass budgets, pause/Stop or approvals; recovery bounded and safe to retry; uncertainty stays visible).
- Control-plane invariants (AGENTS.md section 5): company-scoped, single assignee, atomic checkout, approval gates, budget hard-stop, activity log on every mutation.
- No code comments. Names carry the explanation. Commit message carries rationale.
- Respawn never auto-reassigns: it creates a new task and cancels the old one.
- Respawn lineage cap: 3 successors per original task, then board escalation with code `child_respawn_exhausted`.
- Linux and Windows process-space hashing stay byte-for-byte unchanged.

## Review Focus

- A child cancelled mid-push: the successor must not repeat the push or MR comment; the handoff must list branch and remote head so the parent can check.
- Two parents (or a parent retry) respawning the same predecessor concurrently: exactly one successor.
- Respawn of a task whose budget is exhausted or company paused: refused with the existing named code, never bypassed.
- Predecessor still actually running (stale evidence wrong): successor uses its own isolated workspace, so no shared-checkout corruption.
- Lineage loop: a respawned task that keeps failing stops at 3 and escalates with evidence, not silently.

---

### Task 1: Stable macOS process-space identity

Root cause of TAC-98 on this machine. `controller-process-identity.ts` hashes `os.hostname()`, which on macOS follows DHCP and reverse DNS when `HostName` is unset, so a network change makes every saved controller look foreign.

**Files:**
- Modify: `server/src/services/controller-process-identity.ts` (hash at `:62-84`, `controllerProcessExited` at `:206`, `sameProcessSpace` at `:228`)
- Modify: `server/src/services/owner-proof.ts:288`
- Modify: `server/src/services/native-runtime/native-restart-recovery.ts:433-436, :480, :1255`
- Modify: `server/src/services/native-runtime/native-failed-run-owner-release.ts:85-90, :246-247`
- Test: `server/src/services/controller-process-space-identity.test.ts`

**Interfaces:**
- Produces: `canonicalProcessSpace(recorded: string | null | undefined): string | null` returns the current hash when `recorded` is a legacy alias of this machine, otherwise `recorded` unchanged. `currentProcessSpaceAliases(): readonly string[]` returns current hash plus legacy aliases (darwin only), excluding `"unknown"`. `sameProcessSpace(recorded)` accepts any alias.
- Darwin current hash input becomes `["darwin", bootSession]` (no hostname). Legacy aliases are `sha256(h + "\0" + bootSession)` for `h` in `os.hostname()`, `${firstLabel}.local`, `firstLabel`.

- [ ] **Step 1: Write failing tests** in `controller-process-space-identity.test.ts`:
  - `darwin hash ignores hostname`: with mocked hostname `a.local` then `b.example.com` and the same boot UUID, `currentControllerProcess().hostHash` is equal across fresh modules.
  - `darwin hash still changes with the boot UUID` (existing test keeps passing).
  - `a receipt saved by the previous release under the .local hostname is the same process space`: `sameProcessSpace(sha256("same-host.local\0" + boot)[0:32])` is true with hostname mocked `same-host.corp.example`.
  - `a receipt under an unrelated hostname is not the same process space`.
  - `controllerProcessExited` judges a legacy-alias receipt with a dead PID as exited (`kill` spy called with pid, signal 0).
  - Linux case: hash unchanged from today's value for the same mocked inputs.
- [ ] **Step 2:** Run `pnpm vitest run server/src/services/controller-process-space-identity.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the darwin hash and the three exports above in `controller-process-identity.ts`. Aliases computed once at module load from the same `bootSession`, no extra `execFileSync` call.
- [ ] **Step 4: Replace the recorded-vs-current comparisons** at the listed sites with `canonicalProcessSpace(recorded)`; in `localOwnerSpaceCondition` use `inArray(nativeRunFinalizations.controllerHostHash, aliases)`.
- [ ] **Step 5: Add a recovery test** in `server/src/__tests__/heartbeat-native-restart-suspension.test.ts` style: a coordinator row stamped with a legacy-alias hash and an expired lease is released by `expired_owner` instead of surfacing `controller_process_space_unverified`.
- [ ] **Step 6:** Run the two files plus `pnpm vitest run server/src/services/owner-proof` and `pnpm -r typecheck` (or `node scripts/typecheck-low-memory.mjs`). Expected: PASS.
- [ ] **Step 7: Commit** `fix(native-recovery): keep macOS process-space identity stable across network changes`. Body states the previous-release story: receipts under `<label>.local`, the exact hostname, or the bare label carry forward; any other hostname is refused as before and stays visible.

### Task 2: Predecessor handoff ledger

**Files:**
- Create: `server/src/services/child-handoff.ts`
- Create: `server/src/services/child-handoff.test.ts`
- Modify: `packages/shared/src/validators/issue.ts` (response type `ChildHandoff`), `packages/shared/src/index.ts` export
- Modify: `server/src/routes/issues.ts` (new `GET /issues/:id/handoff`)

**Interfaces:**
- Produces: `buildChildHandoff(db: Db, input: { companyId: string; issueId: string }): Promise<ChildHandoff>` where `ChildHandoff = { predecessor: { id; identifier; title; status; assigneeAgentId }; lastRun: { id; status; errorCode; error; finishedAt } | null; recoveryAction: { cause; reason; nextAction } | null; recentComments: { id; authorLabel; body; createdAt }[] (max 20, body capped 4000 chars); documents: { key; title; updatedAt }[]; workProducts: { id; kind; title; url }[]; workspace: { branch: string | null; headSha: string | null; hasUncommittedChanges: boolean | null }; verifyBeforeRepeating: string[] }`.
- `verifyBeforeRepeating` is derived, never invented: it names the branch and any work-product URLs found, and the recovery action `nextAction` text.

- [x] **Step 0 (verify before coding):** read how issue documents, work products and workspace branch are stored (`packages/db/src/schema`), and the existing agent read-scope check for subtree reads (`doc/execution-semantics.md` section on run-scoped reads). Record the exact table and function names in this task before Step 1.
  - Documents: `issue_documents` (`issueDocuments`: `companyId`, `issueId`, `documentId`, `key`, `updatedAt`) joined to `documents` (`title`, `updatedAt`).
  - Work products: `issue_work_products` (`issueWorkProducts`: `id`, `type`, `title`, `url`). There is no `kind` column; the handoff maps `kind` from `type`.
  - Workspace branch: `issues.executionWorkspaceId` -> `execution_workspaces.branch_name` (`executionWorkspaces.branchName`). No table stores a head SHA or a dirty flag; they exist only from a live git inspection (`executionWorkspaceService.inspectWorkspace`). The handoff is a stored-state read, so `headSha` and `hasUncommittedChanges` are `null` (unknown) and `verifyBeforeRepeating` tells the parent to check the remote head of the branch itself.
  - Last run: `heartbeat_runs` matched by `issueId`, `nativeIssueId` or `contextSnapshot->>'issueId'` (same predicate as `task-retry.ts`), fields `status`, `errorCode`, `error`, `finishedAt`.
  - Recovery action: `issueRecoveryActionService(db).getActiveForIssue(companyId, issueId)` (`issue_recovery_actions`, `cause`, `evidence.reason`, `nextAction`).
  - Comments: `issue_comments` (`issueComments`: `authorType`, `authorAgentId`, `authorUserId`, `body`, `deletedAt`).
  - Read scope: run-scoped *writes* are subtree-scoped, but `issue:read` is default-open inside a company (`assertIssueReadAllowed` in `server/src/routes/issues.ts`), so no existing check proves ancestry for a read. Ancestry is proved with `loadTaskLineageIssueIds` (`server/src/services/task-workspace-lineage.ts`, parent chain plus privacy parent). The handoff and respawn authority is: the predecessor's `createdByAgentId`, or the assignee of any lineage ancestor; board actors need `issue:read` (handoff) or `issue:mutate` (respawn).
- [x] **Step 1: Failing test** `child-handoff.test.ts`: `returns branch, last failed run and blocking action for a cancelled child`; `caps comments at 20 and bodies at 4000`; `never includes another company's rows`.
- [x] **Step 2:** Run it, expect FAIL. **Step 3:** implement. **Step 4:** route test: an ancestor agent gets 200, an unrelated agent gets 403, board gets 200. **Step 5:** commit `feat(issues): expose predecessor handoff to parent agents`.

### Task 3: Bounded respawn

**Files:**
- Create: `server/src/services/child-respawn.ts`, `server/src/services/child-respawn.test.ts`
- Modify: `packages/shared/src/validators/issue.ts` (`respawnChildSchema`), `server/src/routes/issues.ts` (`POST /issues/:id/respawn`), `ui/src/api/issues.ts` client method
- Modify: `server/src/services/recovery/service.ts` only if a named escalation cause is needed for `child_respawn_exhausted`

**Interfaces:**
- Consumes: `buildChildHandoff` (Task 2).
- Produces: `respawnChild(db: Db, input: { companyId: string; predecessorIssueId: string; actor: { type: "agent" | "board"; id: string }; reason: string; approachNote?: string }): Promise<{ outcome: "respawned"; successorIssueId: string; generation: number } | { outcome: "exhausted"; code: "child_respawn_exhausted" }>`
- Successor: same parent, project, title (prefixed `Respawn N:`), assignee as predecessor; description = predecessor description + handoff summary + `approachNote`; workspace preference isolated; `originKind: "respawn"`, `originId: "respawn:<predecessorId>"` (unique, gives idempotency); predecessor cancelled with a comment linking the successor.
- Authority: actor must be the predecessor's creator or an ancestor assignee (agent), or board with `issue:mutate`. Refused with existing budget, pause and company-scope errors, never bypassed.

- [x] **Step 0 (verify):** confirm the issue-create path accepts an isolated workspace preference and a unique `originId`; record the exact field names here. Confirm how an agent proves ancestry (existing subtree check) and reuse it.
  - Create path: `issueService(tx).create(companyId, data, tx)` (`server/src/services/issues.ts`). It accepts `originKind`, `originId`, `executionWorkspacePreference`, `executionWorkspaceSettings` and `inheritExecutionWorkspaceFromIssueId`, but drops all three workspace fields when `enableIsolatedWorkspaces` is off.
  - Isolation: no field is needed. Every new task realizes its own workspace (`doc/execution-semantics.md`, "A child never shares its parent's execution workspace"); `inheritExecutionWorkspaceFromIssueId: predecessorId` copies only the predecessor's project workspace and strategy (`buildIndependentTaskWorkspaceSettings`), never its `executionWorkspaceId`, `reuse_existing` preference or pinned branch. Forcing `mode: "isolated_workspace"` would override a project's `shared_workspace` policy, so respawn does not set it; a project-pinned shared folder still applies by design.
  - Idempotency: other origin kinds use a partial unique index on `(company_id, origin_kind, origin_id)` in `packages/db/src/schema/issues.ts`. Respawn adds `issues_respawn_predecessor_uq` for `origin_kind = 'respawn'`, permanent (not status-filtered), with `originId = "respawn:<predecessorId>"`. The predecessor row is also locked `for update` first, so a concurrent caller waits and then reuses the committed successor.
  - Ancestry: `loadTaskLineageIssueIds` (Task 2). Cancel uses `issueService(tx).update(id, { status: "cancelled", companyGuard, expectedExecutionLock })`, which runs the service-level cancel side effects; the route then stops a live predecessor run with `heartbeat.cancelRun`, as the PATCH cancel path does. An active recovery action on the cancelled predecessor is left to the existing `source_terminal` sweep.
  - Gates: `budgetService(db).getInvocationBlock` (company pause, project pause, budget hard stop), `issueTreeControlService(db).getActivePauseHoldGate` (tree pause), `evaluateAgentInvokabilityFromDb` (assignee invokability), `assertAssignableAgent` inside create.
  - Cap: "3 successors per lineage" means the fourth respawn attempt is refused, so the plan's test "third respawn returns child_respawn_exhausted" is written as the fourth attempt.
- [x] **Step 1: Failing tests:** `creates exactly one successor when called twice concurrently`; `cancels the predecessor and links the successor`; `third respawn returns child_respawn_exhausted and opens a board recovery action with evidence`; `refuses when the company is paused or budget-stopped`; `refuses an unrelated agent`; `writes one activity log entry per mutation`.
- [x] **Step 2-4:** run to fail, implement in one transaction (issue lock order as in `native-failed-run-owner-release.ts:168`), run to pass.
- [x] **Step 5:** commit `feat(issues): bounded child respawn with handoff and isolated workspace`.

### Task 4: Wake the parent and teach it

**Files:**
- Modify: `server/src/services/recovery/blocker-stall-wakeups.ts` (confirm it covers a child blocked on a board-owned recovery action; extend if not)
- Create: `skills/paperclip/references/child-recovery.md`
- Modify: `skills/paperclip/SKILL.md` (one link line only, to limit conflict with upstream edits)
- Test: `server/src/services/recovery/blocker-stall-wakeups.test.ts` (extend or create)

**Interfaces:**
- Wake payload gains `respawn: { available: boolean; generation: number; remaining: number }`.

- [ ] **Step 0 (verify):** read `blocker-stall-wakeups.ts`; write down whether TAC-98's shape (child `blocked`, board-owned `native_restart_recovery_blocked`) already wakes the parent.
- [ ] **Step 1: Failing test:** `wakes the parent once when a child is blocked on a board-owned recovery action and includes respawn availability`.
- [ ] **Step 2-4:** implement, pass.
- [ ] **Step 5:** write `child-recovery.md`: inspect handoff, check branch and MR for already-done effects, respawn with an `approachNote` that changes the approach if the failure repeats, stop after the cap and escalate with evidence.
- [ ] **Step 6:** commit `feat(skills): child recovery playbook and parent respawn wake`.

## Self-Review

- Spec coverage: respawn by parent (Task 3), ignore cancelled and recreate with partial output (Tasks 2-3), flexible on ambiguity (isolation instead of proof; Task 1 removes the false ambiguity), autonomy trigger (Task 4).
- The cancelled-run hole in the containment settle (`native_controller_containment_stale`) is deliberately not fixed: once Task 3 exists, a parent respawns and cancels the predecessor, which is the exit the operator used by hand.
- Local write-fencing for same-workspace retry is out of scope; it changes persisted run state and needs its own design under `rules/upgrade-safe-run-state.mdc`.

## Implementation Notes (2026-11-11)

- Task 1 shipped in `971dc7b043`; Tasks 2 and 3 in `ec1d09a84c` and `725c5283ba`; Task 4 and the live-run guard in the commit after them.
- Respawn by an agent is refused with `child_respawn_predecessor_live` while the child has a live run and is not `blocked`. Only the board may respawn over a live run. Reason: respawn cancels the predecessor's run, and agents may not stop each other's healthy runs.
- The stalled-child wake carries `blockerStall.respawn` (`available`, `generation`, `remaining`, `handoffPath`, `respawnPath`, `guidance`) for the `child` relation only. A `blocker` relation gets no offer.
- Lineage helpers live in `server/src/services/child-respawn-lineage.ts` so the wake sweep does not import the respawn service.
- Open follow-ups: raw hostname comparisons in `owner-proof.ts:287` and `native-workspace-owner-stop-proof.ts:60`; local write-fencing for same-workspace retry; board UI for respawn.

## Task 5: Paperclip respawns stalled children itself (2026-11-11)

Text instructions to the parent agent are not the mechanism. The recovery sweep (`reconcileActiveRecoveryActions`) now runs `respawnStalledChildren` (`server/src/services/recovery/stalled-child-respawn.ts`) before it wakes waiters.

- **Eligible:** a `blocked` child (it has a parent) whose latest recovery action is open or board-owned-and-resolved-as-blocked, with a cause in `AUTO_RESPAWN_CAUSES`: `native_restart_recovery_blocked`, `native_session_retry_exhausted`, `native_session_interrupted`, `execution_finalization_deadline_exceeded`. The list is the policy knob. It deliberately excludes causes where unsynced work or an uncertain external action could be lost or repeated (`native_workspace_sync_out_*`, `uncertain_external_action`, `uncertain_provider_action`), setup and budget causes, and the legacy reconciliation causes.
- **Quiet period:** `AUTO_RESPAWN_QUIET_PERIOD_MS` (10 minutes) from the action's creation. The parent is woken first and may respawn with a better approach note. The pass returns the due time as `blockerStallRetryAt`, so the worker sweeps again.
- **Actor:** `system` (`ChildRespawnActor` gained it). The same `respawnChild` runs, so pause holds, budgets and agent invokability still refuse, the lineage cap still applies, and respawn stays idempotent through the predecessor's unique index. A refusal is retried every 10 minutes.
- **Live run:** the predecessor's live run is cancelled through a `cancelRun` dependency bound to `cancelRunInternal` in `heartbeat.ts`, after the successor exists. Successor assignee is woken with `issue_assigned`.
- **Exhaustion:** `upsertSourceScoped({ createOnly })` returns the issue's existing active action, and a stalled child always has one, so exhaustion cannot add a second board action. It now posts one system comment and one `issue.child_respawn_exhausted` activity row, once (`respawnExhaustionAnnounced`), and leaves the original stall in place for the board.
- **Previous-release story:** no schema or persisted run state change. The only new rows are ordinary issues, comments and activity. A server that predates this simply never runs the pass.
- **Not done:** an instance or company switch to turn automatic respawn off; per-company allowlists.
