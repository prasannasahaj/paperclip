import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { currentProcessSpaceHash, currentProcessStartedAtMs } from "../services/controller-process-identity.js";
import { createOwnershipReportState, runOwnershipReconciliationPass } from "../services/recovery/ownership-invariant-report.js";
import { claimNativeSessionResumptions } from "../services/native-runtime/native-finalization-reconciler.js";
import {
  registerHeldRunStopper,
  settleOwnershipUnverifiedHold,
  type HeldRunStopRequest,
} from "../services/native-runtime/ownership-unverified-hold-settlement.js";
import {
  isNativeRunnerOwnershipHeld,
  NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT,
  NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE,
} from "../services/native-runtime/native-runner-ownership.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const KIND = "native_ownership_unverified_hold";

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
  return pid;
}

async function ownProcessStartedAt(): Promise<Date> {
  const startedAt = await currentProcessStartedAtMs();
  if (startedAt === null) throw new Error("This host cannot report this process's start time");
  return new Date(startedAt);
}

suite("ownership-unverified holds on the shared ownership path", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "", agentId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-ownership-unverified-hold-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID(); agentId = randomUUID();
    const responsibleUserId = randomUUID();
    await db.insert(authUsers).values({ id: responsibleUserId, name: "Board", email: `${responsibleUserId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "OUH",
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: responsibleUserId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Lead", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(nativeRunFinalizations);
    await db.execute(sql`truncate table agent_wakeup_requests, heartbeat_runs cascade`);
    await db.delete(issues);
  });

  afterAll(async () => { await temporary?.cleanup(); });

  async function heldRun(options: { runner?: "dead" | "alive" | "pid_reused"; checkpoint?: boolean;
    errorCode?: string; stopRequested?: boolean; hostHashUnrecorded?: boolean } = {}) {
    const issueId = randomUUID(), runId = randomUUID();
    const startedAt = new Date(Date.now() - 4 * 60 * 60_000);
    const runner = options.runner ?? "dead";
    const processPid = runner === "dead" ? await exitedPid() : process.pid;
    const processStartedAt = runner === "alive" ? await ownProcessStartedAt() : new Date(startedAt.getTime() + 1_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Morning digest", status: "in_progress",
      assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", issueId,
      nativeIssueId: issueId, status: "running", runtimeMode: "native", startedAt, nextEventSeq: 1,
      contextSnapshot: { issueId }, nativePhase: "terminal_failure",
      runnerProfileJson: { nativeExecutionInput: {}, sessionCheckpoint: { providerSessionId: "provider-session" } },
      errorCode: options.errorCode ?? NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE,
      error: "Native execution ownership could not be verified; automatic recovery is blocked",
      processPid, processGroupId: runner === "dead" ? processPid : null, processStartedAt,
      processHostHash: options.hostHashUnrecorded ? null : currentProcessSpaceHash(),
      ...(options.stopRequested ? { resultJson: { executionCancellation: { state: "requested" },
        cancellation: { reason: "Cancelled by a board operator" }, cancelledByUserId: "board-user" } } : {}) });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure", attempt: 1,
      leaseOwner: null, failureCode: NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT, controllerGeneration: 2,
      failureDetail: { recoverable: false, recoveryMode: "exact_checkpoint_resume", recoveryOwner: { kind: "board" },
        checkpointExists: options.checkpoint !== false, providerSessionEstablished: true,
        originalFailureCode: NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT } });
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    return { issueId, runId };
  }

  const run = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  const coordinator = async (id: string) =>
    (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, id)))[0]!;
  const pass = async () => (await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: true }))
    .kinds.find(entry => entry.kind === KIND);

  it("releases a held run whose runner process died and hands it to the same-run resume path", async () => {
    const f = await heldRun();
    expect(isNativeRunnerOwnershipHeld(await run(f.runId))).toBe(true);

    expect(await pass()).toMatchObject({ inProgress: 1, settled: 1 });

    const released = await run(f.runId);
    expect(isNativeRunnerOwnershipHeld(released)).toBe(false);
    expect(released).toMatchObject({ status: "running", nativePhase: "retryable_failure", processPid: null, processGroupId: null });
    const owner = await coordinator(f.runId);
    expect(owner).toMatchObject({ phase: "retryable_failure", failureCode: "native_session_interrupted", attempt: 1,
      resultId: null, leaseOwner: null });
    expect(owner.nextAttemptAt).not.toBeNull();
    expect(owner.failureDetail).toMatchObject({ recoverable: true, recoveryOwner: { kind: "system" },
      recoveryMode: "exact_checkpoint_resume", checkpointExists: true,
      ownershipHoldRelease: { ownerProof: "pid_dead", originalFailureCode: NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT } });
    expect(await pass()).toMatchObject({ inProgress: 0 });
  }, 60_000);

  it("makes the released run claimable for a same-run session resume, and not before", async () => {
    const f = await heldRun();
    const claim = () => claimNativeSessionResumptions({ db, runnerInstanceId: "test", runIds: [f.runId] });
    expect(await claim()).toEqual([]);
    await pass();
    expect(await claim()).toEqual([expect.objectContaining({ runId: f.runId, attempt: 1 })]);
  }, 60_000);

  it("releases a run held by the adopted-runner authentication timeout code", async () => {
    const f = await heldRun({ errorCode: NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT });
    expect(await pass()).toMatchObject({ settled: 1 });
    expect(isNativeRunnerOwnershipHeld(await run(f.runId))).toBe(false);
  }, 60_000);

  it("releases a run whose recorded pid now belongs to another process", async () => {
    const f = await heldRun({ runner: "pid_reused" });
    expect(await pass()).toMatchObject({ settled: 1 });
    expect((await coordinator(f.runId)).failureDetail).toMatchObject({ ownershipHoldRelease: { ownerProof: "pid_reused" } });
  }, 60_000);

  it("keeps the hold while the runner process is alive", async () => {
    const f = await heldRun({ runner: "alive" });
    expect(await pass()).toMatchObject({ inProgress: 1, settled: 0 });
    expect(isNativeRunnerOwnershipHeld(await run(f.runId))).toBe(true);
    expect(await coordinator(f.runId)).toMatchObject({ phase: "terminal_failure" });
  }, 60_000);

  it("keeps the hold when the dead runner left no checkpoint to resume from", async () => {
    const f = await heldRun({ checkpoint: false });
    expect(await pass()).toMatchObject({ inProgress: 1, settled: 0 });
    expect(isNativeRunnerOwnershipHeld(await run(f.runId))).toBe(true);
  }, 60_000);

  it("does not judge a hold saved before the runner's process space was recorded", async () => {
    const f = await heldRun({ hostHashUnrecorded: true });
    expect(await pass()).toMatchObject({ settled: 0 });
    expect(isNativeRunnerOwnershipHeld(await run(f.runId))).toBe(true);
  }, 60_000);

  describe("a Stop the board requested while the run was held", () => {
    const stops: HeldRunStopRequest[] = [];
    let unregister: (() => void) | null = null;
    afterEach(() => { unregister?.(); unregister = null; stops.length = 0; });

    it("stops the run through the normal Stop path instead of resuming it", async () => {
      unregister = registerHeldRunStopper(async request => { stops.push(request); });
      const f = await heldRun({ stopRequested: true });
      expect(await pass()).toMatchObject({ settled: 1 });
      expect(stops).toEqual([{ companyId, runId: f.runId, reason: "Cancelled by a board operator", cancelledByUserId: "board-user" }]);
      expect(isNativeRunnerOwnershipHeld(await run(f.runId))).toBe(false);
      expect(await coordinator(f.runId)).toMatchObject({ phase: "terminal_failure" });
    }, 60_000);

    it("restores the hold when the Stop fails, so a later pass retries it", async () => {
      unregister = registerHeldRunStopper(async () => { throw new Error("stop failed"); });
      const f = await heldRun({ stopRequested: true });
      expect(await pass()).toMatchObject({ settled: 0 });
      expect(isNativeRunnerOwnershipHeld(await run(f.runId))).toBe(true);
      unregister();
      unregister = registerHeldRunStopper(async request => { stops.push(request); });
      expect(await pass()).toMatchObject({ settled: 1 });
      expect(stops).toHaveLength(1);
    }, 60_000);

    it("waits, still held, while no Stop handler is registered", async () => {
      const f = await heldRun({ stopRequested: true });
      expect(await pass()).toMatchObject({ settled: 0 });
      expect(isNativeRunnerOwnershipHeld(await run(f.runId))).toBe(true);
    }, 60_000);
  });

  it("refuses to release when a different runner process took over since the proof", async () => {
    const f = await heldRun();
    const held = await run(f.runId);
    const staleRecord = { recordId: f.runId, companyId, runId: f.runId, issueId: f.issueId, updatedAt: held.updatedAt,
      owner: { kind: "process" as const, stamp: { kind: "local" as const, scope: KIND, generation: null, host: null,
        processSpace: currentProcessSpaceHash(), bootId: null, pid: held.processPid! + 1,
        processStartedAt: held.processStartedAt!.toISOString(), processGroupId: held.processGroupId } } };
    const outcome = await settleOwnershipUnverifiedHold(db, staleRecord,
      { now: new Date(), proof: { verdict: "gone", reason: "pid_dead" } });
    expect(outcome).toMatchObject({ settled: false, reason: "runner_process_changed_since_proof" });
    expect(isNativeRunnerOwnershipHeld(await run(f.runId))).toBe(true);
  }, 60_000);
});
