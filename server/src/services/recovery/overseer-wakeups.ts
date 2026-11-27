import { and, eq, inArray } from "drizzle-orm";
import { agents, agentWakeupRequests, type Db } from "@paperclipai/db";
import { ISSUE_BLOCKER_STALLED_WAKE_REASON } from "@paperclipai/shared";
import { logActivity } from "../activity-log.js";
import { SUCCESSFUL_RUN_MISSING_STATE_REASON } from "./successful-run-handoff.js";
import { parseHeartbeatPolicy } from "../heartbeat/timer-policy.js";
import {
  DELIVERED_OR_PENDING_WAKE_STATUSES, issueBlockerStalledWakeKey, NON_INVOKABLE_AGENT_STATUSES, readStalls,
  stallContext, type BlockerStallWakeup, type StallRow,
} from "./blocker-stall-wakeups.js";

type AgentRow = typeof agents.$inferSelect;

const DEFAULT_STALL_PAGE_SIZE = 200;

export const OVERSEER_JUDGMENT_CAUSES = [
  "stranded_assigned_issue",
  "deliberate_wait_without_target",
  "execution_review_participant_recovery",
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
] as const;

async function loadAgent(db: Db, companyId: string, agentId: string, loaded: Map<string, AgentRow | null>) {
  if (!loaded.has(agentId)) {
    const [row] = await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    loaded.set(agentId, row ?? null);
  }
  return loaded.get(agentId)!;
}

async function managerChainOf(db: Db, companyId: string, agentId: string, loaded: Map<string, AgentRow | null>) {
  const chain: AgentRow[] = [];
  const seen = new Set<string>([agentId]);
  let current = await loadAgent(db, companyId, agentId, loaded);
  while (current?.reportsTo && !seen.has(current.reportsTo)) {
    seen.add(current.reportsTo);
    current = await loadAgent(db, companyId, current.reportsTo, loaded);
    if (current) chain.push(current);
  }
  return chain;
}

function acceptsWakes(agent: AgentRow) {
  return !NON_INVOKABLE_AGENT_STATUSES.includes(agent.status) && parseHeartbeatPolicy(agent).wakeOnDemand;
}

export async function resolveStallOverseerAgentId(db: Db,
  input: { companyId: string; assigneeAgentId: string; createdByAgentId: string | null },
  loaded: Map<string, AgentRow | null> = new Map()) {
  const managers = await managerChainOf(db, input.companyId, input.assigneeAgentId, loaded);
  const requester = input.createdByAgentId && input.createdByAgentId !== input.assigneeAgentId
    ? await loadAgent(db, input.companyId, input.createdByAgentId, loaded)
    : null;
  const overseer = managers.find(acceptsWakes) ?? (requester && acceptsWakes(requester) ? requester : null);
  return overseer?.id ?? null;
}

export async function wakeOverseersOfStalledIssues(db: Db, enqueueWakeup: BlockerStallWakeup,
  opts: { companyId?: string | null; issueId?: string | null; pageSize?: number } = {}) {
  const result = { stalls: 0, woken: 0, alreadyWoken: 0, withoutOverseer: 0 };
  const pageSize = opts.pageSize ?? DEFAULT_STALL_PAGE_SIZE;
  const loaded = new Map<string, AgentRow | null>();
  let afterActionId: string | null = null;
  for (;;) {
    const stalls = await readStalls(db, { companyId: opts.companyId, issueId: opts.issueId, afterActionId, causes: OVERSEER_JUDGMENT_CAUSES }, pageSize);
    await wakeOverseersOfStallPage(db, enqueueWakeup, stalls, loaded, result);
    if (stalls.length < pageSize) return result;
    afterActionId = stalls.at(-1)!.actionId;
  }
}

async function wakeOverseersOfStallPage(db: Db, enqueueWakeup: BlockerStallWakeup, stalls: StallRow[],
  loaded: Map<string, AgentRow | null>,
  result: { stalls: number; woken: number; alreadyWoken: number; withoutOverseer: number }) {
  for (const stall of stalls) {
    result.stalls += 1;
    if (!stall.assigneeAgentId) { result.withoutOverseer += 1; continue; }
    const overseerId = await resolveStallOverseerAgentId(db, { companyId: stall.companyId,
      assigneeAgentId: stall.assigneeAgentId, createdByAgentId: stall.createdByAgentId }, loaded);
    const overseer = overseerId ? loaded.get(overseerId) : null;
    if (!overseer) { result.withoutOverseer += 1; continue; }
    const idempotencyKey = issueBlockerStalledWakeKey({ waiterIssueId: stall.issueId, stalledIssueId: stall.issueId,
      recoveryActionId: stall.actionId });
    const prior = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, stall.companyId), eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
        inArray(agentWakeupRequests.status, DELIVERED_OR_PENDING_WAKE_STATUSES))).limit(1);
    if (prior.length > 0) { result.alreadyWoken += 1; continue; }
    const context = stallContext(stall, "overseer");
    const wake = await enqueueWakeup(overseer.id, {
      source: "automation", triggerDetail: "system", reason: ISSUE_BLOCKER_STALLED_WAKE_REASON,
      payload: { issueId: stall.issueId, ...context }, idempotencyKey,
      requestedByActorType: "system", requestedByActorId: "issue-stall-overseer",
      contextSnapshot: { issueId: stall.issueId, taskId: stall.issueId, wakeReason: ISSUE_BLOCKER_STALLED_WAKE_REASON,
        source: "issue.stall_overseer", blockerStall: context },
      allowRunCoalescing: false,
      issueStateGuard: { statuses: [stall.issueStatus], assigneeAgentId: stall.assigneeAgentId },
    });
    if (!wake) continue;
    await logActivity(db, {
      companyId: stall.companyId, actorType: "system", actorId: "issue-stall-overseer",
      action: "issue.blocker_stalled_wake", entityType: "issue", entityId: stall.issueId,
      agentId: overseer.id, issueId: stall.issueId,
      details: { stalledIssueId: stall.issueId, stalledIssueIdentifier: stall.identifier, relation: "overseer",
        recoveryActionId: stall.actionId, recoveryActionKind: stall.kind, recoveryActionStatus: stall.status },
    });
    result.woken += 1;
  }
}
