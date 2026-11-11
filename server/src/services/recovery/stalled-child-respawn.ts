import { and, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { respawnChild, respawnExhaustionAnnounced } from "../child-respawn.js";
import { readRespawnAllowance } from "../child-respawn-lineage.js";
import { readStalls, type StallRow } from "./blocker-stall-wakeups.js";

export const AUTO_RESPAWN_QUIET_PERIOD_MS = 10 * 60_000;
const AUTO_RESPAWN_RETRY_MS = 10 * 60_000;
const MAX_AUTO_RESPAWNS_PER_PASS = 25;
const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
const SYSTEM_ACTOR_ID = "stalled-child-respawn";

export const AUTO_RESPAWN_CAUSES: ReadonlySet<string> = new Set([
  "native_restart_recovery_blocked",
  "native_session_retry_exhausted",
  "native_session_interrupted",
  "execution_finalization_deadline_exceeded",
]);

export type StalledChildRespawnWakeup = (agentId: string, input: {
  source: "assignment";
  triggerDetail: "system";
  reason: "issue_assigned";
  payload: Record<string, unknown>;
  idempotencyKey: string;
  requestedByActorType: "system";
  requestedByActorId: string;
  contextSnapshot: Record<string, unknown>;
}) => Promise<unknown>;

export type StalledChildRunCancel = (runId: string, reason?: string, options?: Record<string, unknown>) => Promise<unknown>;

function respawnReason(stall: StallRow) {
  const minutes = Math.max(1, Math.round((Date.now() - new Date(stall.actionCreatedAt).getTime()) / 60_000));
  return `Paperclip respawned this task automatically: it had been stalled for ${minutes} minutes on ${stall.cause} and nobody had recovered it.`;
}

async function liveRunOf(db: Db, stall: StallRow) {
  const [issue] = await db.select({ executionRunId: issues.executionRunId }).from(issues)
    .where(and(eq(issues.companyId, stall.companyId), eq(issues.id, stall.issueId)));
  if (!issue?.executionRunId) return null;
  const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, stall.companyId), eq(heartbeatRuns.id, issue.executionRunId),
    inArray(heartbeatRuns.status, LIVE_RUN_STATUSES)));
  return run ?? null;
}

async function stopPredecessorRun(cancelRun: StalledChildRunCancel | undefined, stall: StallRow, runId: string) {
  if (!cancelRun) return;
  try {
    await cancelRun(runId, `Superseded by an automatic respawn of ${stall.identifier ?? stall.issueId}`,
      { eventMessage: "Run stopped because its task was respawned", eventPayload: { source: "child_respawn", issueId: stall.issueId } });
  } catch (err) {
    logger.warn({ err, issueId: stall.issueId, runId }, "failed to cancel run for automatically respawned issue");
  }
}

async function wakeSuccessor(db: Db, enqueueWakeup: StalledChildRespawnWakeup, successorIssueId: string) {
  const [successor] = await db.select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
    .from(issues).where(eq(issues.id, successorIssueId));
  if (!successor?.assigneeAgentId || successor.status !== "todo") return;
  try {
    await enqueueWakeup(successor.assigneeAgentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: successor.id, mutation: "create" },
      idempotencyKey: `child_respawn_wake:${successor.id}`,
      requestedByActorType: "system", requestedByActorId: SYSTEM_ACTOR_ID,
      contextSnapshot: { issueId: successor.id, source: "issue.respawn" },
    });
  } catch (err) {
    logger.warn({ err, issueId: successor.id }, "failed to wake assignee of automatically respawned issue");
  }
}

/**
 * Respawn children that stalled on a board action and were not recovered.
 *
 * A child blocked on an infrastructure fault (a restart that left its original
 * execution unprovable, a session whose retries ran out) is stalled, not
 * wrong: a fresh attempt in its own workspace, carrying the handoff, is what a
 * lead would do. The parent is woken first (blocker-stall-wakeups.ts) and has
 * AUTO_RESPAWN_QUIET_PERIOD_MS to act with a better plan; after that the
 * system does it. Pause holds, budgets and agent availability still refuse the
 * respawn, and a lineage that used its respawns goes to the board with the evidence.
 */
export async function respawnStalledChildren(db: Db, deps: {
  enqueueWakeup: StalledChildRespawnWakeup;
  cancelRun?: StalledChildRunCancel;
}, opts: { companyId?: string | null } = {}) {
  const result = { respawned: 0, exhausted: 0, refused: 0, failed: 0, retryAt: null as number | null };
  const retryAt = (at: number) => { result.retryAt = result.retryAt === null ? at : Math.min(result.retryAt, at); };
  const stalls = await readStalls(db, { companyId: opts.companyId, causes: [...AUTO_RESPAWN_CAUSES], issueStatus: "blocked",
    childrenOnly: true }, MAX_AUTO_RESPAWNS_PER_PASS);
  if (stalls.length >= MAX_AUTO_RESPAWNS_PER_PASS) retryAt(Date.now());
  for (const stall of stalls) {
    const dueAt = new Date(stall.actionCreatedAt).getTime() + AUTO_RESPAWN_QUIET_PERIOD_MS;
    if (dueAt > Date.now()) { retryAt(dueAt); continue; }
    try {
      const allowance = await readRespawnAllowance(db, { id: stall.issueId, companyId: stall.companyId,
        originKind: stall.originKind, originId: stall.originId });
      if (!allowance.available && await respawnExhaustionAnnounced(db, stall.companyId, stall.issueId)) {
        result.exhausted += 1;
        continue;
      }
      const liveRun = await liveRunOf(db, stall);
      const outcome = await respawnChild(db, {
        companyId: stall.companyId, predecessorIssueId: stall.issueId,
        actor: { type: "system", id: SYSTEM_ACTOR_ID }, reason: respawnReason(stall),
      });
      if (outcome.outcome === "exhausted") { result.exhausted += 1; continue; }
      if (!outcome.created) continue;
      result.respawned += 1;
      if (liveRun) await stopPredecessorRun(deps.cancelRun, stall, liveRun.id);
      await wakeSuccessor(db, deps.enqueueWakeup, outcome.successorIssueId);
    } catch (err) {
      if ((err as { details?: { code?: string } }).details?.code) {
        result.refused += 1;
      } else {
        result.failed += 1;
        logger.warn({ err, issueId: stall.issueId }, "automatic child respawn failed");
      }
      retryAt(Date.now() + AUTO_RESPAWN_RETRY_MS);
    }
  }
  return result;
}
