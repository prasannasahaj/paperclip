# Issue Tree Deliverables Rollup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a parent issue, show every work product and document produced anywhere beneath it in one read-only view, so a board user can see what the whole delegated tree produced and what needs review.

**Architecture:** A new read-only endpoint `GET /issues/:id/tree-deliverables` walks the descendant tree with a recursive CTE, keeps only issues the actor may read (same two-step policy as `server/src/services/case-task-documents.ts`), and returns work products and document metadata grouped by producing issue. Batched readers live in the services that own those rows. The UI adds a section at the top of the existing Artifacts tab that reuses the `components/artifacts/v1` rows.

**Tech Stack:** Express + Drizzle (`server/`), shared types (`packages/shared`), React + TanStack Query (`ui/`), Vitest + supertest.

**Spec:** None written. Scope agreed in conversation on 2026-11-15: read-side rollup only, no schema change, no agent-role or instruction change. The coordinator "Result" document is a separate follow-up and out of scope.

## Global Constraints

- Company-scoped: every query filters `companyId`; the route uses `getAccessibleResource` then `assertIssueReadAllowed` like `GET /issues/:id/work-products` (`server/src/routes/issues.ts:11401`).
- Read-only: no mutation, so no activity-log entry (`rules/api-route-expectations.mdc`).
- No schema or migration change. Do not touch `packages/db`.
- Contracts stay in sync: shared type, server route, UI API client (AGENTS.md section 5.2).
- Behavior stays with its owning module: work-product reads in `work-products.ts`, document reads in `documents.ts` (`rules/module-boundaries.mdc`).
- Never author code comments (user rule). Name things so none are needed.
- Do not add routes to `server/src/routes/issues.ts` (21,512 lines); use a new route file like `issue-tree-control.ts`.
- UI: tokens only, no hardcoded visual values (`DESIGN.md`); collection render cost proportional to size (`rules/ui-render-cost.mdc`).
- One commit at the end of the work, not per task (user preference). Work on a feature branch off `development`.
- Limits (my calls, mirror `case-task-documents.ts`): max depth 8, max 500 tasks, max 200 work products, max 200 documents.

## Review Focus

- A descendant the actor cannot read must contribute nothing: no title, no identifier, no outputs, and must not be counted as omitted.
- A tree deeper than 8 levels or wider than 500 tasks returns `omitted: true` rather than failing or silently truncating.
- A root with no descendants, or descendants with no outputs, returns an empty `tasks` array and the UI renders nothing (no empty "Sub-task outputs" header).
- System documents (`SYSTEM_ISSUE_DOCUMENT_KEYS`) never appear, matching the per-issue Artifacts tab.
- A cyclic or re-parented tree must terminate (recursive CTE uses `UNION`, not `UNION ALL`).
- Hidden issues (`hiddenAt` set) and harness-kind issues (`harnessKind` set) are excluded, as in the live-descendant count at `server/src/services/issues.ts:3597`.

---

### Task 1: Batched readers in the owning services

**Files:**
- Modify: `server/src/services/work-products.ts` (add `listForIssues` beside `listForIssue`, line 210)
- Modify: `server/src/services/documents.ts` (add `listIssueDocumentSummariesForIssues` beside `listIssueDocuments`, line 154)
- Test: `server/src/__tests__/work-products.test.ts`, and the existing documents service test file (find it with `ls server/src/__tests__ | grep -i document`)

**Interfaces:**
- Produces: `workProductService(db).listForIssues(issueIds: string[]): Promise<IssueWorkProduct[]>` — no PR refresh; runtime-service reconciliation applied exactly as `listForIssue` does.
- Produces: `documentService(db).listIssueDocumentSummariesForIssues(issueIds: string[], options?: { includeSystem?: boolean }): Promise<IssueDocumentSummary[]>` — metadata only, no body; same key/updatedAt ordering and `filterSystemDocuments` handling as `listIssueDocuments`.

- [ ] **Step 1: Write failing tests** — `listForIssues returns products for several issues and none for unlisted issues`; `listForIssues applies runtime-service reconciliation like listForIssue` (copy the fixture style from `work-product-runtime-reconciliation.test.ts`); `listIssueDocumentSummariesForIssues omits system keys by default and never returns a body`.
- [ ] **Step 2: Run** `pnpm vitest run server/src/__tests__/work-products.test.ts` — expect FAIL "listForIssues is not a function".
- [ ] **Step 3: Implement `listForIssues`** by extracting the reconciliation in `listForIssue` into one private helper that both call; the batched query uses `inArray(issueWorkProducts.issueId, issueIds)` with the same ordering. Return `[]` for an empty id list without querying.
- [ ] **Step 4: Implement `listIssueDocumentSummariesForIssues`** with `inArray(issueDocuments.issueId, issueIds)`, the existing `issueDocumentSelect`, then `filterSystemDocuments` and `mapIssueDocumentRow(row, false)` so no body is mapped (read `mapIssueDocumentRow` first to confirm what its second argument controls; if it does not control the body, select only metadata columns instead).
- [ ] **Step 5: Run** both test files — expect PASS. `listForIssue` tests must still pass unchanged.

### Task 2: Shared contract and tree service

**Files:**
- Create: `packages/shared/src/types/issue-tree-deliverables.ts`
- Modify: `packages/shared/src/types/index.ts` and `packages/shared/src/index.ts` (export the new types, following how `work-product.ts` is exported)
- Create: `server/src/services/issue-tree-deliverables.ts`
- Test: `server/src/__tests__/issue-tree-deliverables-service.test.ts` (DB harness as in `work-products.test.ts`)

**Interfaces:**
- Produces (shared):
  ```ts
  export interface IssueTreeDeliverableTask {
    issueId: string;
    identifier: string | null;
    title: string;
    status: string;
    assigneeAgentId: string | null;
    depth: number;
    workProducts: IssueWorkProduct[];
    documents: IssueDocumentSummary[];
  }
  export interface IssueTreeDeliverables {
    rootIssueId: string;
    tasks: IssueTreeDeliverableTask[];
    omitted: { tasks: boolean; workProducts: boolean; documents: boolean };
  }
  ```
- Produces (server): `listIssueTreeDeliverables(db: Db, input: { companyId: string; rootIssueId: string; actor: AuthorizationActor }): Promise<IssueTreeDeliverables>`
- Consumes: Task 1 readers; `issueReadSqlCondition` and `authorizationService(db).decideReads` from `authorization.ts`.

- [ ] **Step 1: Write failing tests**, each with the asserted outcome:
  - `returns outputs of children and grandchildren grouped by issue with depth 1 and 2`
  - `excludes the root's own outputs`
  - `omits descendants with no outputs`
  - `omits an unreadable descendant entirely and does not flag omitted`
  - `excludes hidden and harness-kind descendants`
  - `terminates on a parent cycle`
  - `reports omitted.tasks when more than 500 descendants exist` (lower the cap via an exported `TREE_DELIVERABLES_LIMITS` constant the test can read; assert against the constant, not the literal)
  - `does not descend past depth 8 and reports omitted.tasks`
  - `orders tasks by depth then creation time`
- [ ] **Step 2: Run** `pnpm vitest run server/src/__tests__/issue-tree-deliverables-service.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Add the shared types** exactly as above and export them. Run `pnpm --filter @paperclipai/shared typecheck`.
- [ ] **Step 4: Implement `listIssueTreeDeliverables`.** Recursive CTE from the root's children carrying `depth`, `UNION` for cycle safety, capped at `TREE_DELIVERABLES_LIMITS.maxDepth` and fetching `maxTasks + 1` rows to detect overflow; push `issueReadSqlCondition` into the issue select, then `decideReads` on the page, as `case-task-documents.ts` does. Fetch outputs via Task 1 readers for the readable ids only, drop tasks with no outputs, then cap work products and documents at their limits and set the matching `omitted` flag.
- [ ] **Step 5: Run** the test file — expect PASS.

### Task 3: Route and mount

**Files:**
- Create: `server/src/routes/issue-tree-deliverables.ts` exporting `issueTreeDeliverablesRoutes(db: Db): Router`
- Modify: `server/src/app.ts` (mount next to `issueTreeControlRoutes`, line ~837, before `issueRoutes`)
- Test: `server/src/__tests__/issue-tree-deliverables-routes.test.ts` (supertest, same `createApp` shape as `issue-tree-control-routes.test.ts`)

**Interfaces:**
- Produces: `GET /issues/:id/tree-deliverables` returning `IssueTreeDeliverables`.
- Consumes: `listIssueTreeDeliverables` (Task 2); `getAccessibleResource` from `./authz.js`; `assertIssueReadAllowed` (find where `issue-tree-control.ts` imports it from).

- [ ] **Step 1: Write failing route tests** — `returns the deliverables for a readable root`; `404 for an issue in another company`; `403 when the actor cannot read the root`; `passes the actor, not just the company, to the service` (assert the mock received the actor).
- [ ] **Step 2: Run** the file — expect FAIL (404 route not mounted).
- [ ] **Step 3: Implement the route** following `GET /issues/:id/tree-control/state` in `issue-tree-control.ts:400`: resolve the root via `getAccessibleResource`, `assertIssueReadAllowed`, build the actor with the same helper the tree-control route uses, `res.json(result)`.
- [ ] **Step 4: Mount in `app.ts`** and run the route test — expect PASS.

### Task 4: UI client, query key, hook

**Files:**
- Modify: `ui/src/api/issues.ts` (add `listTreeDeliverables(id: string, options?: { signal?: AbortSignal })` returning `IssueTreeDeliverables`; place beside `listWorkProducts`)
- Modify: `ui/src/lib/queryKeys.ts` (add `treeDeliverables: (issueId: string) => ["issues", "tree-deliverables", issueId] as const` beside `workProducts`, line 442)
- Create: `ui/src/hooks/useIssueTreeDeliverables.ts`
- Test: `ui/src/hooks/useIssueTreeDeliverables.test.tsx` (style of `useIssueWorkProducts.test.tsx`)

**Interfaces:**
- Produces: `useIssueTreeDeliverables(issueId: string | null | undefined, options?: { enabled?: boolean })` returning the TanStack query result for `IssueTreeDeliverables`; `refetchOnMount: "always"`, disabled when `issueId` is nullish.

- [ ] **Step 1: Write failing test** — `does not fetch without an issue id`; `fetches tree deliverables for the issue id and exposes tasks`.
- [ ] **Step 2: Run** `pnpm vitest run ui/src/hooks/useIssueTreeDeliverables.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement** client method, key and hook.
- [ ] **Step 4: Run** — expect PASS.

### Task 5: Section component and Artifacts tab mount

**Files:**
- Create: `ui/src/lib/issue-tree-deliverables.ts` exporting `sortTasksNeedingReviewFirst(tasks: IssueTreeDeliverableTask[]): IssueTreeDeliverableTask[]` and `taskNeedsReview(task: IssueTreeDeliverableTask): boolean`
- Create: `ui/src/components/IssueTreeDeliverablesSection.tsx` exporting `IssueTreeDeliverablesSection({ issueId }: { issueId: string })`
- Modify: `ui/src/components/issue-properties/IssuePropertiesArtifactsTab.tsx` (render the section above the existing content; keep the diff small, the file is 803 lines)
- Test: `ui/src/lib/issue-tree-deliverables.test.ts`, `ui/src/components/IssueTreeDeliverablesSection.test.tsx`

**Interfaces:**
- Consumes: `useIssueTreeDeliverables` (Task 4); row helpers from `@/components/artifacts/v1` (`ArtifactRow`, `subjectFromWorkProduct`, `subjectFromIssueDocument`, `workProductStateBadge`) as `IssuePropertiesArtifactsTab.tsx` already uses them.
- `taskNeedsReview` is true when any work product has `reviewState === "needs_board_review"` or `status === "ready_for_review"`. Sorting is stable and puts review-needed tasks first, otherwise preserving server order.

- [ ] **Step 1: Write failing tests** for the pure functions: `taskNeedsReview is true for needs_board_review`, `taskNeedsReview is true for ready_for_review`, `taskNeedsReview is false for approved and merged`, `sortTasksNeedingReviewFirst keeps server order within each group`.
- [ ] **Step 2: Write failing component tests**: `renders nothing when tasks is empty`; `renders one group per task with identifier, title and status linking to the issue`; `lists work products and documents under their task`; `shows a "more outputs not shown" notice when omitted.workProducts or omitted.documents is true`; `shows a notice when omitted.tasks is true`; `renders a 200-output tree without rendering more rows than outputs` (ui-render-cost rule).
- [ ] **Step 3: Run** both files — expect FAIL.
- [ ] **Step 4: Implement the pure functions, then the component.** Header "Sub-task outputs" with a count of tasks needing review; each task a group with a link to its issue; rows via the shared artifact row helpers. Surface a fetch error with the same error treatment the Artifacts tab uses for work-product errors; never swallow it (AGENTS.md section 9).
- [ ] **Step 5: Mount in the Artifacts tab.** Confirm the tab content mounts only when the tab is open (read how `IssueProperties.tsx` renders `IssuePropertiesArtifactsTab`); if it mounts eagerly, pass `enabled` from the active-tab state so the endpoint is not fetched on every issue open (see `doc/plans/2026-04-07-issue-detail-speed-and-optimistic-inventory.md`).
- [ ] **Step 6: Run** the component tests and the existing `IssueProperties*` tests — expect PASS.

### Task 6: Verify and hand off

- [ ] **Step 1:** Run `pnpm verify`. If it exits 2, run the focused checks for the touched packages (`pnpm --filter @paperclipai/shared typecheck`, `pnpm --filter @paperclipai/server typecheck`, `pnpm --filter @paperclipai/ui typecheck`) and let CI cover the rest; do not follow with a full local run.
- [ ] **Step 2:** Run the app (`pnpm dev`), open a parent issue that has sub-issues with work products and documents, open its Artifacts tab, and confirm the section lists them, review-needed tasks sort first, and an issue with no sub-issues shows no section. Report if no such issue exists locally.
- [ ] **Step 3:** Commit once on the feature branch. Open the PR using every section of `.github/PULL_REQUEST_TEMPLATE.md`; state in the PR body that there is no schema change and that agent instructions are unchanged.

## Self-Review

- **Coverage:** descendant walk, authz, system-document exclusion, caps, cycle safety, review-first ordering and the UI mount each map to a task above. The Result-document duty is intentionally excluded.
- **Type consistency:** `IssueTreeDeliverables` and `IssueTreeDeliverableTask` are defined once in Task 2 and consumed unchanged in Tasks 3 to 5. `listForIssues` and `listIssueDocumentSummariesForIssues` are named identically where defined and consumed.
- **Not verified by me:** the DB test harness (I read the route-test shape, not `work-products.test.ts`), the second argument of `mapIssueDocumentRow`, where `assertIssueReadAllowed` is imported from, and whether the Artifacts tab mounts lazily. Each is a step that tells the implementer to read it first.
- **Live updates:** the section refetches on mount only. Pushing updates while the tab is open is a non-goal for this plan.
