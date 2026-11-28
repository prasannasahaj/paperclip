import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, type Db } from "@paperclipai/db";
import { ISSUE_BLOCKER_STALLED_WAKE_REASON, type IssueBlockerStalledWakeContext } from "@paperclipai/shared";
import { logActivity } from "../activity-log.js";
import { SUCCESSFUL_RUN_MISSING_STATE_REASON } from "./successful-run-handoff.js";
import { parseHeartbeatPolicy } from "../heartbeat/timer-policy.js";
import {
  DELIVERED_OR_PENDING_WAKE_STATUSES, issueBlockerStalledWakeKey, NON_INVOKABLE_AGENT_STATUSES, readStalls,
  stallContext, type BlockerStallWakeup, type StallRow,
} from "./blocker-stall-wakeups.js";

type AgentRow = typeof agents.$inferSelect;

const DEFAULT_STALL_PAGE_SIZE = 200;
const OVERSEER_WAKE_RETRY_BASE_MS = 2 * 60_000;
const MAX_UNSTARTED_OVERSEER_WAKES = 5;
const UNSTARTED_WAKE_STATUSES = ["cancelled", "failed"];

export function overseerWakeRetryDueAt(unstartedWakes: number, lastRequestedAtMs: number) {
  return lastRequestedAtMs + OVERSEER_WAKE_RETRY_BASE_MS * 2 ** Math.max(0, unstartedWakes - 1);
}

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

/**
 * Whether a queued run is the overseer wake the server sent for this issue's
 * current stall. The run's agent is the manager or requester, never the
 * assignee, so dispatch admits it only when the stall, its action and the
 * agent all match server state; the wake reason string alone never qualifies.
 */
export async function verifyOverseerStallWake(db: Db, input: {
  companyId: string;
  issueId: string;
  agentId: string;
  contextSnapshot: Record<string, unknown> | null | undefined;
  requestedByActorType: string | null | undefined;
}): Promise<boolean> {
  const context = input.contextSnapshot;
  if (context?.wakeReason !== ISSUE_BLOCKER_STALLED_WAKE_REASON || input.requestedByActorType !== "system") return false;
  const stall = context.blockerStall as Partial<IssueBlockerStalledWakeContext> | undefined;
  const actionId = typeof stall?.recoveryAction?.id === "string" ? stall.recoveryAction.id : null;
  if (stall?.relation !== "overseer" || stall.stalledIssueId !== input.issueId || !actionId) return false;
  const [current] = await readStalls(db, { companyId: input.companyId, issueIds: [input.issueId],
    causes: OVERSEER_JUDGMENT_CAUSES }, 1);
  if (!current || current.actionId !== actionId || !current.assigneeAgentId) return false;
  const overseerId = await resolveStallOverseerAgentId(db, { companyId: input.companyId,
    assigneeAgentId: current.assigneeAgentId, createdByAgentId: current.createdByAgentId });
  return overseerId === input.agentId;
}

export async function wakeOverseersOfStalledIssues(db: Db, enqueueWakeup: BlockerStallWakeup,
  opts: { companyId?: string | null; issueId?: string | null; pageSize?: number } = {}) {
  const result: OverseerWakeResult = { stalls: 0, woken: 0, alreadyWoken: 0, withoutOverseer: 0, retryAt: null };
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
  result: OverseerWakeResult) {
  for (const stall of stalls) {
    result.stalls += 1;
    if (!stall.assigneeAgentId) { result.withoutOverseer += 1; continue; }
    const overseerId = await resolveStallOverseerAgentId(db, { companyId: stall.companyId,
      assigneeAgentId: stall.assigneeAgentId, createdByAgentId: stall.createdByAgentId }, loaded);
    const overseer = overseerId ? loaded.get(overseerId) : null;
    if (!overseer) { result.withoutOverseer += 1; continue; }
    const idempotencyKey = issueBlockerStalledWakeKey({ waiterIssueId: stall.issueId, stalledIssueId: stall.issueId,
      recoveryActionId: stall.actionId });
    const [prior] = await db.select({
      delivered: sql<boolean>`coalesce(bool_or(${inArray(agentWakeupRequests.status, DELIVERED_OR_PENDING_WAKE_STATUSES)}), false)`,
      unstarted: sql<number>`count(*) filter (where ${inArray(agentWakeupRequests.status, UNSTARTED_WAKE_STATUSES)})::int`,
      lastRequestedAt: sql<string | null>`max(${agentWakeupRequests.requestedAt})`,
    }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, stall.companyId), eq(agentWakeupRequests.idempotencyKey, idempotencyKey)));
    if (prior?.delivered) { result.alreadyWoken += 1; continue; }
    const unstarted = Number(prior?.unstarted ?? 0);
    if (unstarted >= MAX_UNSTARTED_OVERSEER_WAKES) { result.alreadyWoken += 1; continue; }
    if (unstarted > 0 && prior?.lastRequestedAt) {
      const dueAt = overseerWakeRetryDueAt(unstarted, new Date(prior.lastRequestedAt).getTime());
      if (dueAt > Date.now()) { result.alreadyWoken += 1; noteRetryAt(result, dueAt); continue; }
    }
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

type OverseerWakeResult = { stalls: number; woken: number; alreadyWoken: number; withoutOverseer: number; retryAt: number | null };

function noteRetryAt(result: OverseerWakeResult, at: number) {
  result.retryAt = result.retryAt === null ? at : Math.min(result.retryAt, at);
}
