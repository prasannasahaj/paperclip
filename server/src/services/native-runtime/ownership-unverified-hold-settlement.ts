import { and, eq, or, type SQL } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import type { OwnerProof } from "../owner-proof.js";
import type { InProgressRecord, SettleOutcome } from "../recovery/ownership-registry.js";
import { recordNativeLocalProcessStopInTransaction } from "../native-local-process-stop.js";
import {
  NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT,
  NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE,
} from "./native-runner-ownership.js";

export const NATIVE_OWNERSHIP_HOLD_RELEASED_ERROR_CODE = "native_session_interrupted";

export function ownershipUnverifiedHoldWhere(): SQL {
  return and(
    eq(heartbeatRuns.runtimeMode, "native"),
    eq(heartbeatRuns.status, "running"),
    or(
      and(
        eq(heartbeatRuns.errorCode, NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE),
        eq(heartbeatRuns.nativePhase, "terminal_failure"),
      ),
      eq(heartbeatRuns.errorCode, NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT),
    ),
  )!;
}

export type HeldRunStopRequest = { companyId: string; runId: string; reason: string; cancelledByUserId: string | null };
type HeldRunStopper = (request: HeldRunStopRequest) => Promise<unknown>;
let heldRunStopper: HeldRunStopper | null = null;

export function registerHeldRunStopper(stopper: HeldRunStopper): () => void {
  heldRunStopper = stopper;
  return () => { if (heldRunStopper === stopper) heldRunStopper = null; };
}

type ReleaseDecision =
  | { kind: "resume" }
  | { kind: "stop"; reason: string; cancelledByUserId: string | null; heldErrorCode: string | null }
  | { kind: "refused"; reason: string; watch: boolean };

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requestedStop(resultJson: unknown): { reason: string; cancelledByUserId: string | null } | null {
  const result = objectValue(resultJson);
  if (objectValue(result.executionCancellation).state !== "requested") return null;
  const reason = objectValue(result.cancellation).reason;
  const cancelledBy = result.cancelledByUserId;
  return {
    reason: typeof reason === "string" && reason ? reason : "Cancelled by a board operator",
    cancelledByUserId: typeof cancelledBy === "string" ? cancelledBy : null,
  };
}

function ownerStampMatchesRun(record: InProgressRecord, run: typeof heartbeatRuns.$inferSelect): boolean {
  if (record.owner.kind !== "process") return false;
  const stamp = record.owner.stamp;
  return stamp.pid === run.processPid
    && (stamp.processGroupId ?? null) === (run.processGroupId ?? null)
    && (stamp.processStartedAt ?? null) === (run.processStartedAt?.toISOString() ?? null);
}

export async function settleOwnershipUnverifiedHold(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  const companyId = record.companyId;
  if (!companyId) return { settled: false, reason: "run_has_no_company" };
  const now = context.now;
  const released = await db.transaction(async tx => {
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, record.recordId), ownershipUnverifiedHoldWhere(),
    )).for("update");
    if (!run) return { kind: "refused", reason: "hold_changed_since_proof", watch: true } as ReleaseDecision;
    if (!ownerStampMatchesRun(record, run)) {
      return { kind: "refused", reason: "runner_process_changed_since_proof", watch: true } as ReleaseDecision;
    }
    const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, run.id),
    )).for("update");
    if (!coordinator || coordinator.resultId) {
      return { kind: "refused", reason: "no_unfinished_coordinator", watch: false } as ReleaseDecision;
    }
    const stop = requestedStop(run.resultJson);
    const detail = objectValue(coordinator.failureDetail);
    const resumable = detail.recoveryMode === "exact_checkpoint_resume" && detail.checkpointExists === true;
    if (!stop && !resumable) {
      return { kind: "refused", reason: "no_saved_checkpoint_to_resume", watch: false } as ReleaseDecision;
    }
    if (stop && !heldRunStopper) return { kind: "refused", reason: "stop_unavailable", watch: true } as ReleaseDecision;

    if (stop) {
      await tx.update(heartbeatRuns).set({ errorCode: NATIVE_OWNERSHIP_HOLD_RELEASED_ERROR_CODE, updatedAt: now })
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, run.id)));
    } else {
      await recordNativeLocalProcessStopInTransaction(tx as unknown as Db, run);
      await tx.update(heartbeatRuns).set({
        errorCode: NATIVE_OWNERSHIP_HOLD_RELEASED_ERROR_CODE,
        error: "The runner process stopped after a restart; its saved session is resumed.",
        nativePhase: "retryable_failure", nativePhaseUpdatedAt: now,
        processPid: null, processGroupId: null, processStartedAt: null,
        updatedAt: now,
      }).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, run.id)));
      const retainedDetail = { ...detail };
      delete retainedDetail.adoptedRunnerUnanswered;
      await tx.update(nativeRunFinalizations).set({
        phase: "retryable_failure",
        failureCode: NATIVE_OWNERSHIP_HOLD_RELEASED_ERROR_CODE,
        recoveryState: null,
        nextAttemptAt: now,
        updatedAt: now,
        failureDetail: {
          ...retainedDetail,
          recoverable: true,
          recoveryOwner: { kind: "system" },
          ownershipHoldRelease: {
            releasedAt: now.toISOString(), ownerProof: context.proof.reason, processPid: run.processPid,
            originalFailureCode: coordinator.failureCode,
          },
        },
      }).where(and(eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, run.id)));
    }
    return stop
      ? { kind: "stop", ...stop, heldErrorCode: run.errorCode } as ReleaseDecision
      : { kind: "resume" } as ReleaseDecision;
  });
  if (released.kind === "refused") return { settled: false, reason: released.reason, watch: released.watch };
  if (released.kind === "stop") {
    try {
      await heldRunStopper!({ companyId, runId: record.recordId, reason: released.reason,
        cancelledByUserId: released.cancelledByUserId });
    } catch (error) {
      logger.warn({ err: error, runId: record.recordId }, "released held run could not be stopped; the hold is restored");
      await db.update(heartbeatRuns).set({ errorCode: released.heldErrorCode, updatedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, record.recordId),
        eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.errorCode, NATIVE_OWNERSHIP_HOLD_RELEASED_ERROR_CODE)));
      return { settled: false, reason: "stop_failed" };
    }
  }
  return { settled: true, reason: context.proof.reason };
}
