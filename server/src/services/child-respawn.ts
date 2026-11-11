import { and, eq, notInArray } from "drizzle-orm";
import { agents, issueRelations, issues, type Db } from "@paperclipai/db";
import { CHILD_RESPAWN_ORIGIN_KIND, type ChildHandoff } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { budgetService } from "./budgets.js";
import { agentHasChildRecoveryAuthority, buildChildHandoff } from "./child-handoff.js";
import { CHILD_RESPAWN_LINEAGE_CAP, loadRespawnLineage, respawnOriginId } from "./child-respawn-lineage.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { executeIssuePostCommitActions, issueService, type IssuePostCommitAction } from "./issues.js";

export { CHILD_RESPAWN_LINEAGE_CAP };
export const CHILD_RESPAWN_EXHAUSTED_CODE = "child_respawn_exhausted";
const RESPAWN_TITLE_PREFIX = /^Respawn \d+: /;
const RESOLVED_BLOCKER_STATUSES = ["done", "cancelled"];
const RESPAWN_UNIQUE_INDEX = "issues_respawn_predecessor_uq";

type IssueRow = typeof issues.$inferSelect;

export type ChildRespawnActor = { type: "agent" | "board"; id: string; runId?: string | null };

export type RespawnChildInput = {
  companyId: string;
  predecessorIssueId: string;
  actor: ChildRespawnActor;
  reason: string;
  approachNote?: string;
};

export type RespawnChildResult =
  | { outcome: "respawned"; successorIssueId: string; generation: number; created: boolean }
  | { outcome: "exhausted"; code: typeof CHILD_RESPAWN_EXHAUSTED_CODE };

function activityActor(actor: ChildRespawnActor) {
  return actor.type === "agent"
    ? { actorType: "agent" as const, actorId: actor.id, agentId: actor.id, runId: actor.runId ?? null }
    : { actorType: "user" as const, actorId: actor.id, agentId: null, runId: null };
}

function isRespawnUniqueConflict(error: unknown) {
  const pending: unknown[] = [error];
  for (const candidate of pending) {
    if (!candidate || typeof candidate !== "object") continue;
    const typed = candidate as { code?: string; constraint?: string; constraint_name?: string; message?: string; cause?: unknown };
    const namesIndex = typed.constraint === RESPAWN_UNIQUE_INDEX || typed.constraint_name === RESPAWN_UNIQUE_INDEX
      || Boolean(typed.message?.includes(RESPAWN_UNIQUE_INDEX));
    if (namesIndex && (typed.code === "23505" || Boolean(typed.message?.includes("duplicate key")))) return true;
    if (typed.cause) pending.push(typed.cause);
  }
  return false;
}

async function loadPredecessor(db: Db, companyId: string, issueId: string) {
  const [predecessor] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  if (!predecessor) throw notFound("Issue not found");
  return predecessor;
}

async function findSuccessor(db: Db, companyId: string, predecessorId: string) {
  const [successor] = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, companyId),
    eq(issues.originKind, CHILD_RESPAWN_ORIGIN_KIND),
    eq(issues.originId, respawnOriginId(predecessorId)),
  ));
  return successor ?? null;
}

async function assertActorMayRespawn(db: Db, predecessor: IssueRow, actor: ChildRespawnActor) {
  if (actor.type !== "agent") return;
  if (await agentHasChildRecoveryAuthority(db, { companyId: predecessor.companyId, agentId: actor.id, issue: predecessor })) return;
  throw forbidden("Only the agent that created this task or the assignee of one of its ancestors can respawn it.", {
    code: "child_recovery_not_authorized", issueId: predecessor.id, actorAgentId: actor.id,
  });
}

async function assertSuccessorMayStart(db: Db, predecessor: IssueRow) {
  const pauseHold = await issueTreeControlService(db).getActivePauseHoldGate(predecessor.companyId, predecessor.id);
  if (pauseHold) {
    throw conflict("Respawn is blocked by an active subtree pause hold", {
      code: "issue_paused", issueId: predecessor.id, holdId: pauseHold.holdId, rootIssueId: pauseHold.rootIssueId,
    });
  }
  const budgetBlock = await budgetService(db).getInvocationBlock(predecessor.companyId, predecessor.assigneeAgentId,
    { issueId: predecessor.id, projectId: predecessor.projectId });
  if (budgetBlock) {
    throw conflict(budgetBlock.reason, { code: "budget_blocked", issueId: predecessor.id, budgetBlock });
  }
  if (!predecessor.assigneeAgentId) return;
  const [assignee] = await db.select().from(agents)
    .where(and(eq(agents.companyId, predecessor.companyId), eq(agents.id, predecessor.assigneeAgentId)));
  const invokability = await evaluateAgentInvokabilityFromDb(db, assignee);
  if (!invokability.invokable) {
    throw conflict(invokability.message, {
      code: "agent_not_invokable", reason: invokability.reason, issueId: predecessor.id, ...invokability.details,
    });
  }
}

function successorTitle(predecessor: IssueRow, generation: number) {
  return `Respawn ${generation}: ${predecessor.title.replace(RESPAWN_TITLE_PREFIX, "")}`;
}

function handoffSummary(handoff: ChildHandoff, input: { reason: string; generation: number }) {
  const lastRun = handoff.lastRun
    ? `${handoff.lastRun.status}${handoff.lastRun.errorCode ? ` (${handoff.lastRun.errorCode})` : ""}${handoff.lastRun.error ? `: ${handoff.lastRun.error}` : ""}`
    : "none recorded";
  return [
    `## Respawn handoff (generation ${input.generation} of ${CHILD_RESPAWN_LINEAGE_CAP})`,
    "",
    `Predecessor: ${handoff.predecessor.identifier ?? handoff.predecessor.id} (${handoff.predecessor.status})`,
    `Reason: ${input.reason}`,
    `Last run: ${lastRun}`,
    ...(handoff.recoveryAction ? [`Recovery action: ${handoff.recoveryAction.cause}. ${handoff.recoveryAction.nextAction}`] : []),
    ...(handoff.workspace.branch ? [`Predecessor branch: ${handoff.workspace.branch}`] : []),
    ...(handoff.documents.length ? ["", "Documents:", ...handoff.documents.map(document => `- ${document.key}${document.title ? ` (${document.title})` : ""}`)] : []),
    ...(handoff.workProducts.length
      ? ["", "Work products:", ...handoff.workProducts.map(product => `- ${product.kind} "${product.title}"${product.url ? ` ${product.url}` : ""}`)]
      : []),
    ...(handoff.verifyBeforeRepeating.length ? ["", "Verify before repeating:", ...handoff.verifyBeforeRepeating.map(check => `- ${check}`)] : []),
    "",
    `Read the full handoff with GET /api/issues/${handoff.predecessor.id}/handoff.`,
  ].join("\n");
}

function successorDescription(predecessor: IssueRow, handoff: ChildHandoff, input: { reason: string; approachNote?: string; generation: number }) {
  return [
    ...(predecessor.description?.trim() ? [predecessor.description.trim(), "", "---", ""] : []),
    handoffSummary(handoff, input),
    ...(input.approachNote ? ["", "## Approach for this attempt", "", input.approachNote] : []),
  ].join("\n");
}

async function escalateExhaustedLineage(db: Db, input: {
  predecessor: IssueRow; lineage: string[]; actor: ChildRespawnActor; reason: string; handoff: ChildHandoff;
}): Promise<RespawnChildResult> {
  const publications: ActivityPublication[] = [];
  const originalIssueId = input.lineage[0]!;
  const generation = input.lineage.length - 1;
  await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, input.predecessor.companyId), eq(issues.id, input.predecessor.id))).for("update");
    const action = await issueRecoveryActionService(tx).upsertSourceScoped({
      companyId: input.predecessor.companyId,
      sourceIssueId: input.predecessor.id,
      kind: "stranded_assigned_issue",
      ownerType: "board",
      cause: CHILD_RESPAWN_EXHAUSTED_CODE,
      fingerprint: `${CHILD_RESPAWN_EXHAUSTED_CODE}:${originalIssueId}`,
      evidence: {
        code: CHILD_RESPAWN_EXHAUSTED_CODE,
        originalIssueId,
        lineageIssueIds: input.lineage,
        generation,
        lineageCap: CHILD_RESPAWN_LINEAGE_CAP,
        reason: input.reason,
        requestedByActorType: input.actor.type,
        requestedByActorId: input.actor.id,
        verifyBeforeRepeating: input.handoff.verifyBeforeRepeating,
      },
      nextAction: `This task was respawned ${generation} times without finishing. Decide whether to change the brief, reassign, or cancel it.`,
      createOnly: true,
    });
    publications.push((await persistActivity(tx, {
      companyId: input.predecessor.companyId,
      ...activityActor(input.actor),
      action: "issue.child_respawn_exhausted",
      entityType: "issue",
      entityId: input.predecessor.id,
      details: { code: CHILD_RESPAWN_EXHAUSTED_CODE, recoveryActionId: action.id, originalIssueId, lineageIssueIds: input.lineage, generation, reason: input.reason },
    })).publication);
  });
  for (const publication of publications) publishActivity(publication);
  return { outcome: "exhausted", code: CHILD_RESPAWN_EXHAUSTED_CODE };
}

async function createSuccessor(db: Db, input: RespawnChildInput & {
  handoff: ChildHandoff; generation: number;
}): Promise<RespawnChildResult> {
  const publications: ActivityPublication[] = [];
  const postCommitActions: IssuePostCommitAction[] = [];
  const actor = activityActor(input.actor);
  const result = await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [predecessor] = await tx.select().from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.predecessorIssueId))).for("update");
    if (!predecessor) throw notFound("Issue not found");
    const existing = await findSuccessor(tx, input.companyId, predecessor.id);
    if (existing) return { outcome: "respawned" as const, successorIssueId: existing.id, generation: input.generation, created: false };
    if (predecessor.status === "done") {
      throw conflict("A completed task cannot be respawned", { code: "child_respawn_predecessor_done", issueId: predecessor.id });
    }
    const svc = issueService(tx);
    const unresolvedBlockers = await tx.select({ id: issues.id }).from(issueRelations)
      .innerJoin(issues, and(eq(issues.id, issueRelations.issueId), eq(issues.companyId, input.companyId)))
      .where(and(
        eq(issueRelations.companyId, input.companyId),
        eq(issueRelations.relatedIssueId, predecessor.id),
        eq(issueRelations.type, "blocks"),
        notInArray(issues.status, RESOLVED_BLOCKER_STATUSES),
      ));
    const successor = await svc.create(input.companyId, {
      title: successorTitle(predecessor, input.generation),
      description: successorDescription(predecessor, input.handoff, input),
      status: unresolvedBlockers.length > 0 ? "blocked" : "todo",
      priority: predecessor.priority,
      parentId: predecessor.parentId,
      parentDepthPolicy: "allow_nested",
      projectId: predecessor.projectId,
      goalId: predecessor.goalId,
      assigneeAgentId: predecessor.assigneeAgentId,
      assigneeUserId: predecessor.assigneeAgentId ? null : predecessor.assigneeUserId,
      requestDepth: predecessor.requestDepth,
      billingCode: predecessor.billingCode,
      originKind: CHILD_RESPAWN_ORIGIN_KIND,
      originId: respawnOriginId(predecessor.id),
      inheritExecutionWorkspaceFromIssueId: predecessor.id,
      blockedByIssueIds: unresolvedBlockers.map(blocker => blocker.id),
      createdByAgentId: input.actor.type === "agent" ? input.actor.id : null,
      createdByUserId: input.actor.type === "board" ? input.actor.id : null,
      actorRunId: input.actor.runId ?? null,
    }, tx);
    publications.push((await persistActivity(tx, {
      companyId: input.companyId, ...actor, action: "issue.created", entityType: "issue", entityId: successor.id,
      details: {
        identifier: successor.identifier, title: successor.title, parentId: successor.parentId, assigneeAgentId: successor.assigneeAgentId,
        status: successor.status, source: "child_respawn", predecessorIssueId: predecessor.id, generation: input.generation,
      },
    })).publication);

    const movedDependents = await tx.update(issueRelations).set({ issueId: successor.id, updatedAt: new Date() }).where(and(
      eq(issueRelations.companyId, input.companyId),
      eq(issueRelations.issueId, predecessor.id),
      eq(issueRelations.type, "blocks"),
    )).returning({ relatedIssueId: issueRelations.relatedIssueId });
    if (movedDependents.length > 0) {
      publications.push((await persistActivity(tx, {
        companyId: input.companyId, ...actor, action: "issue.blockers_transferred", entityType: "issue", entityId: successor.id,
        details: { fromIssueId: predecessor.id, toIssueId: successor.id, dependentIssueIds: movedDependents.map(row => row.relatedIssueId) },
      })).publication);
    }

    const comment = await svc.addComment(
      predecessor.id,
      `Respawned as ${successor.identifier ?? successor.id} (generation ${input.generation} of ${CHILD_RESPAWN_LINEAGE_CAP}). Reason: ${input.reason}`,
      { runId: input.actor.runId ?? null },
      { authorType: "system" },
      tx,
    );
    publications.push((await persistActivity(tx, {
      companyId: input.companyId, ...actor, action: "issue.comment_added", entityType: "issue", entityId: predecessor.id,
      details: { commentId: comment.id, source: "child_respawn", successorIssueId: successor.id },
    })).publication);

    if (predecessor.status !== "cancelled") {
      await svc.update(predecessor.id, {
        status: "cancelled",
        companyGuard: input.companyId,
        expectedExecutionLock: { executionRunId: predecessor.executionRunId, checkoutRunId: predecessor.checkoutRunId },
        actorAgentId: input.actor.type === "agent" ? input.actor.id : null,
        actorUserId: input.actor.type === "board" ? input.actor.id : null,
        actorRunId: input.actor.runId ?? null,
      }, tx, publications, postCommitActions);
      publications.push((await persistActivity(tx, {
        companyId: input.companyId, ...actor, action: "issue.updated", entityType: "issue", entityId: predecessor.id,
        details: { status: "cancelled", _previous: { status: predecessor.status }, source: "child_respawn", successorIssueId: successor.id },
      })).publication);
    }

    publications.push((await persistActivity(tx, {
      companyId: input.companyId, ...actor, action: "issue.child_respawned", entityType: "issue", entityId: predecessor.id,
      details: { successorIssueId: successor.id, generation: input.generation, reason: input.reason, approachNote: input.approachNote ?? null },
    })).publication);
    return { outcome: "respawned" as const, successorIssueId: successor.id, generation: input.generation, created: true };
  });
  for (const publication of publications) publishActivity(publication);
  await executeIssuePostCommitActions(db, postCommitActions);
  return result;
}

export async function respawnChild(db: Db, input: RespawnChildInput): Promise<RespawnChildResult> {
  const predecessor = await loadPredecessor(db, input.companyId, input.predecessorIssueId);
  await assertActorMayRespawn(db, predecessor, input.actor);
  const lineage = await loadRespawnLineage(db, predecessor);
  const generation = lineage.length;
  const existing = await findSuccessor(db, input.companyId, predecessor.id);
  if (existing) return { outcome: "respawned", successorIssueId: existing.id, generation, created: false };
  if (predecessor.status === "done") {
    throw conflict("A completed task cannot be respawned", { code: "child_respawn_predecessor_done", issueId: predecessor.id });
  }
  const handoff = await buildChildHandoff(db, { companyId: input.companyId, issueId: predecessor.id });
  if (generation > CHILD_RESPAWN_LINEAGE_CAP) {
    return escalateExhaustedLineage(db, { predecessor, lineage, actor: input.actor, reason: input.reason, handoff });
  }
  await assertSuccessorMayStart(db, predecessor);
  try {
    return await createSuccessor(db, { ...input, handoff, generation });
  } catch (error) {
    if (!isRespawnUniqueConflict(error)) throw error;
    const winner = await findSuccessor(db, input.companyId, predecessor.id);
    if (!winner) throw error;
    return { outcome: "respawned", successorIssueId: winner.id, generation, created: false };
  }
}
