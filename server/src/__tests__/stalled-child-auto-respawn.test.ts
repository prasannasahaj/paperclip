import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues, type Db,
} from "@paperclipai/db";
import { ISSUE_BLOCKER_STALLED_WAKE_REASON } from "@paperclipai/shared";
import { recoveryService } from "../services/recovery/service.js";
import { AUTO_RESPAWN_CAUSES, AUTO_RESPAWN_QUIET_PERIOD_MS } from "../services/recovery/stalled-child-respawn.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_RECOVERY_ACTION_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("stalled child automatic respawn", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  const companyIdOf = new Map<string, string>();

  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("stalled-child-auto-respawn-");
    db = createDb(external ?? temporary!.connectionString);
    db.$client.options.onnotice = () => {};
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  function wakeRecorder() {
    const calls: Array<{ agentId: string; input: Record<string, any> }> = [];
    const enqueueWakeup = vi.fn(async (agentId: string, input: Record<string, any>) => {
      calls.push({ agentId, input });
      const [row] = await db.insert(agentWakeupRequests).values({ companyId: companyIdOf.get(agentId)!,
        agentId, source: input.source, triggerDetail: input.triggerDetail, reason: input.reason, payload: input.payload,
        idempotencyKey: input.idempotencyKey ?? null, status: "queued" }).returning();
      return { id: row.id };
    });
    return { calls, enqueueWakeup };
  }

  async function stalledChild(options: { cause?: string; ageMs?: number; childAgentStatus?: "idle" | "paused" } = {}) {
    const companyId = randomUUID(), parentAgent = randomUUID(), childAgent = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Auto respawn", issuePrefix: `A${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: parentAgent, companyId, name: "Parent owner", role: "engineer", status: "idle" },
      { id: childAgent, companyId, name: "Child owner", role: "engineer", status: options.childAgentStatus ?? "idle" },
    ]);
    companyIdOf.set(parentAgent, companyId); companyIdOf.set(childAgent, companyId);
    const [parent] = await db.insert(issues).values({ companyId, title: "Parent", status: "blocked", assigneeAgentId: parentAgent }).returning();
    const [child] = await db.insert(issues).values({ companyId, title: "Child", status: "blocked", parentId: parent!.id,
      assigneeAgentId: childAgent }).returning();
    const action = await stallAction(companyId, child!.id, options);
    return { companyId, parentAgent, childAgent, parent: parent!, child: child!, action };
  }

  async function stallAction(companyId: string, issueId: string, options: { cause?: string; ageMs?: number } = {}) {
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "run_recovery",
      status: "escalated", ownerType: "board", cause: options.cause ?? "native_restart_recovery_blocked",
      fingerprint: `fixture-${randomUUID()}`, nextAction: "Stop the original controller and provider on their original host",
      createdAt: new Date(Date.now() - (options.ageMs ?? AUTO_RESPAWN_QUIET_PERIOD_MS + 60_000)) }).returning();
    return action!;
  }

  async function successorsOf(predecessorId: string) {
    return db.select().from(issues).where(and(eq(issues.originKind, "respawn"), eq(issues.originId, `respawn:${predecessorId}`)));
  }

  function sweep(f: { companyId: string }, recorder = wakeRecorder(), cancelRun = vi.fn(async () => null)) {
    const service = recoveryService(db, { enqueueWakeup: recorder.enqueueWakeup as never, cancelRun: cancelRun as never });
    return { recorder, cancelRun, run: () => service.reconcileActiveRecoveryActions({ companyId: f.companyId }) };
  }

  it("respawns a child stalled on a board-owned recovery action and wakes its assignee", async () => {
    const f = await stalledChild();
    const { recorder, run } = sweep(f);
    await run();
    const [successor] = await successorsOf(f.child.id);
    expect(successor).toMatchObject({ parentId: f.parent.id, assigneeAgentId: f.childAgent, status: "todo" });
    expect(successor!.title).toBe("Respawn 1: Child");
    expect(successor!.description).toContain("native_restart_recovery_blocked");
    const [predecessor] = await db.select().from(issues).where(eq(issues.id, f.child.id));
    expect(predecessor!.status).toBe("cancelled");
    expect(recorder.calls.filter(call => call.agentId === f.childAgent && call.input.reason === "issue_assigned")).toHaveLength(1);
    expect(recorder.calls.filter(call => call.input.reason === ISSUE_BLOCKER_STALLED_WAKE_REASON)).toHaveLength(0);
    const [respawned] = await db.select().from(activityLog).where(eq(activityLog.action, "issue.child_respawned"));
    expect(respawned).toMatchObject({ actorType: "system", entityId: f.child.id });
  });

  it("respawns once however many sweeps run", async () => {
    const f = await stalledChild();
    const { run } = sweep(f);
    await run();
    await run();
    expect(await successorsOf(f.child.id)).toHaveLength(1);
  });

  it("waits out the quiet period and asks to be swept again", async () => {
    const f = await stalledChild({ ageMs: 1_000 });
    const result = await sweep(f).run();
    expect(await successorsOf(f.child.id)).toHaveLength(0);
    expect(result.blockerStallRetryAt).toBeGreaterThan(Date.now());
  });

  it.each(["uncertain_external_action", "native_workspace_sync_out_retry_exhausted", "budget_blocked"])(
    "leaves a stall caused by %s to the board", async cause => {
      expect(AUTO_RESPAWN_CAUSES.has(cause)).toBe(false);
      const f = await stalledChild({ cause });
      const { recorder, run } = sweep(f);
      await run();
      expect(await successorsOf(f.child.id)).toHaveLength(0);
      expect(recorder.calls.filter(call => call.input.reason === ISSUE_BLOCKER_STALLED_WAKE_REASON)).toHaveLength(1);
    });

  it("stops the predecessor's live run when it respawns", async () => {
    const f = await stalledChild();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.childAgent, issueId: f.child.id,
      status: "running", contextSnapshot: { issueId: f.child.id } }).returning();
    await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, f.child.id));
    const { cancelRun, run: sweepOnce } = sweep(f);
    await sweepOnce();
    expect(cancelRun).toHaveBeenCalledWith(run!.id, expect.any(String), expect.anything());
  });

  it("leaves the child alone and retries later when the assignee cannot be invoked", async () => {
    const f = await stalledChild({ childAgentStatus: "paused" });
    const result = await sweep(f).run();
    expect(await successorsOf(f.child.id)).toHaveLength(0);
    const [child] = await db.select().from(issues).where(eq(issues.id, f.child.id));
    expect(child!.status).toBe("blocked");
    expect(result.blockerStallRetryAt).toBeGreaterThan(Date.now());
  });

  it("tells the board once the lineage has used every respawn and leaves the stall in place", async () => {
    const f = await stalledChild();
    let latest = f.child;
    for (let generation = 1; generation <= 3; generation += 1) {
      const [successor] = await db.insert(issues).values({ companyId: f.companyId, parentId: f.parent.id,
        title: `Respawn ${generation}: Child`, status: "blocked", assigneeAgentId: f.childAgent, originKind: "respawn",
        originId: `respawn:${latest.id}` }).returning();
      latest = successor!;
    }
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.child.id));
    await stallAction(f.companyId, latest.id);
    const { run } = sweep(f);
    await run();
    await run();
    expect(await successorsOf(latest.id)).toHaveLength(0);
    const [stall] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, latest.id));
    expect(stall).toMatchObject({ cause: "native_restart_recovery_blocked", status: "escalated" });
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.child_respawn_exhausted"))).toHaveLength(1);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, latest.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("will not respawn it again");
  });
});
