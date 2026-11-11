import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  agents,
  documents,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  issueWorkProducts,
  type Db,
} from "@paperclipai/db";
import type { ChildHandoff } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { loadTaskLineageIssueIds } from "./task-workspace-lineage.js";

export const CHILD_HANDOFF_COMMENT_LIMIT = 20;
export const CHILD_HANDOFF_COMMENT_BODY_LIMIT = 4000;
const CHILD_HANDOFF_LIST_LIMIT = 50;

type PredecessorRow = typeof issues.$inferSelect;

function capCommentBody(body: string) {
  return body.length > CHILD_HANDOFF_COMMENT_BODY_LIMIT ? body.slice(0, CHILD_HANDOFF_COMMENT_BODY_LIMIT) : body;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

async function loadPredecessor(db: Db, input: { companyId: string; issueId: string }) {
  const [predecessor] = await db.select().from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  if (!predecessor) throw notFound("Issue not found");
  return predecessor;
}

export async function agentHasChildRecoveryAuthority(
  db: Db,
  input: { companyId: string; agentId: string; issue: Pick<PredecessorRow, "id" | "parentId" | "privacyParentIssueId" | "createdByAgentId"> },
) {
  if (input.issue.createdByAgentId === input.agentId) return true;
  const lineageIssueIds = await loadTaskLineageIssueIds(db, input.companyId, input.issue);
  if (lineageIssueIds.length === 0) return false;
  const [assignedAncestor] = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, input.companyId),
    inArray(issues.id, lineageIssueIds),
    eq(issues.assigneeAgentId, input.agentId),
  )).limit(1);
  return Boolean(assignedAncestor);
}

async function loadLastRun(db: Db, predecessor: PredecessorRow) {
  const [run] = await db.select({
    id: heartbeatRuns.id,
    status: heartbeatRuns.status,
    errorCode: heartbeatRuns.errorCode,
    error: heartbeatRuns.error,
    finishedAt: heartbeatRuns.finishedAt,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, predecessor.companyId),
    or(
      eq(heartbeatRuns.issueId, predecessor.id),
      eq(heartbeatRuns.nativeIssueId, predecessor.id),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${predecessor.id}`,
    ),
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  return run ?? null;
}

async function loadRecentComments(db: Db, predecessor: PredecessorRow) {
  const rows = await db.select({
    id: issueComments.id,
    authorType: issueComments.authorType,
    authorUserId: issueComments.authorUserId,
    authorAgentName: agents.name,
    body: issueComments.body,
    createdAt: issueComments.createdAt,
  }).from(issueComments)
    .leftJoin(agents, and(eq(agents.id, issueComments.authorAgentId), eq(agents.companyId, predecessor.companyId)))
    .where(and(
      eq(issueComments.companyId, predecessor.companyId),
      eq(issueComments.issueId, predecessor.id),
      isNull(issueComments.deletedAt),
    ))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(CHILD_HANDOFF_COMMENT_LIMIT);
  return rows.map(row => ({
    id: row.id,
    authorLabel: row.authorAgentName ?? (row.authorUserId ? "user" : row.authorType ?? "system"),
    body: capCommentBody(row.body),
    createdAt: row.createdAt,
  }));
}

async function loadDocuments(db: Db, predecessor: PredecessorRow) {
  return db.select({ key: issueDocuments.key, title: documents.title, updatedAt: documents.updatedAt })
    .from(issueDocuments)
    .innerJoin(documents, and(eq(documents.id, issueDocuments.documentId), eq(documents.companyId, predecessor.companyId)))
    .where(and(eq(issueDocuments.companyId, predecessor.companyId), eq(issueDocuments.issueId, predecessor.id)))
    .orderBy(asc(issueDocuments.key))
    .limit(CHILD_HANDOFF_LIST_LIMIT);
}

async function loadWorkProducts(db: Db, predecessor: PredecessorRow) {
  return db.select({ id: issueWorkProducts.id, kind: issueWorkProducts.type, title: issueWorkProducts.title, url: issueWorkProducts.url })
    .from(issueWorkProducts)
    .where(and(eq(issueWorkProducts.companyId, predecessor.companyId), eq(issueWorkProducts.issueId, predecessor.id)))
    .orderBy(asc(issueWorkProducts.createdAt), asc(issueWorkProducts.id))
    .limit(CHILD_HANDOFF_LIST_LIMIT);
}

async function loadWorkspaceBranch(db: Db, predecessor: PredecessorRow) {
  if (!predecessor.executionWorkspaceId) return null;
  const [workspace] = await db.select({ branchName: executionWorkspaces.branchName }).from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, predecessor.companyId),
    eq(executionWorkspaces.id, predecessor.executionWorkspaceId),
  ));
  return workspace?.branchName ?? null;
}

function deriveVerifyBeforeRepeating(input: {
  branch: string | null;
  workProducts: ChildHandoff["workProducts"];
  recoveryAction: ChildHandoff["recoveryAction"];
}) {
  return [
    ...(input.branch
      ? [`Check the remote head of branch ${input.branch} before pushing; the predecessor may already have pushed to it.`]
      : []),
    ...input.workProducts.flatMap(product => product.url
      ? [`Check ${product.kind} "${product.title}" at ${product.url} before creating or commenting on it again.`]
      : []),
    ...(input.recoveryAction ? [input.recoveryAction.nextAction] : []),
  ];
}

export async function buildChildHandoff(db: Db, input: { companyId: string; issueId: string }): Promise<ChildHandoff> {
  const predecessor = await loadPredecessor(db, input);
  const [lastRun, recentComments, documentRows, workProducts, branch, activeRecoveryAction] = await Promise.all([
    loadLastRun(db, predecessor),
    loadRecentComments(db, predecessor),
    loadDocuments(db, predecessor),
    loadWorkProducts(db, predecessor),
    loadWorkspaceBranch(db, predecessor),
    issueRecoveryActionService(db).getActiveForIssue(predecessor.companyId, predecessor.id),
  ]);
  const recoveryAction = activeRecoveryAction
    ? {
      cause: activeRecoveryAction.cause,
      reason: stringOrNull(activeRecoveryAction.evidence?.reason),
      nextAction: activeRecoveryAction.nextAction,
    }
    : null;
  return {
    predecessor: {
      id: predecessor.id,
      identifier: predecessor.identifier,
      title: predecessor.title,
      status: predecessor.status,
      assigneeAgentId: predecessor.assigneeAgentId,
    },
    lastRun,
    recoveryAction,
    recentComments,
    documents: documentRows,
    workProducts,
    workspace: { branch, headSha: null, hasUncommittedChanges: null },
    verifyBeforeRepeating: deriveVerifyBeforeRepeating({ branch, workProducts, recoveryAction }),
  };
}
