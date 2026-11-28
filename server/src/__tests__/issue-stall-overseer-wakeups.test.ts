import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, companies, createDb, issueRecoveryActions, issues, type Db,
} from "@paperclipai/db";
import { ISSUE_BLOCKER_STALLED_WAKE_REASON } from "@paperclipai/shared";
import { recoveryService } from "../services/recovery/service.js";
import { verifyOverseerStallWake, wakeOverseersOfStalledIssues } from "../services/recovery/overseer-wakeups.js";
import { issueBlockerStalledWakeKey } from "../services/recovery/blocker-stall-wakeups.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_RECOVERY_ACTION_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("stalled issue overseer wakes", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("stall-overseer-");
    db = createDb(external ?? temporary!.connectionString);
    db.$client.options.onnotice = () => {};
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  const companyIdOf = new Map<string, string>();

  function wakeRecorder() {
    const calls: Array<{ agentId: string; input: Record<string, any> }> = [];
    const enqueueWakeup = vi.fn(async (agentId: string, input: Record<string, any>) => {
      calls.push({ agentId, input });
      const [row] = await db.insert(agentWakeupRequests).values({ companyId: companyIdOf.get(agentId)!,
        agentId, source: input.source, triggerDetail: input.triggerDetail, reason: input.reason, payload: input.payload,
        idempotencyKey: input.idempotencyKey, status: "queued" }).returning();
      return { id: row.id };
    });
    return { calls, enqueueWakeup };
  }

  async function company() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Overseer", issuePrefix: `O${companyId.slice(0, 6)}` });
    return companyId;
  }

  async function agent(companyId: string, name: string, extra: Partial<typeof agents.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name, role: "engineer", status: "idle", ...extra });
    companyIdOf.set(id, companyId);
    return id;
  }

  async function stalledIssue(companyId: string, assigneeAgentId: string, extra: Partial<typeof issues.$inferInsert> = {},
    cause = "execution_review_participant_recovery") {
    const [issue] = await db.insert(issues).values({ companyId, title: "Reviewer stopped without a decision",
      status: "blocked", assigneeAgentId, ...extra }).returning();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id,
      kind: "stranded_assigned_issue", status: "active", ownerType: "board", cause,
      fingerprint: "fixture", nextAction: "The reviewer did not finish the review." }).returning();
    return { issue, action };
  }

  it("wakes the manager of the stalled issue's assignee once per stall, on the stalled issue", async () => {
    const companyId = await company();
    const techLead = await agent(companyId, "Tech Lead");
    const reviewer = await agent(companyId, "QA Verifier", { reportsTo: techLead });
    const { issue, action } = await stalledIssue(companyId, reviewer);
    const { calls, enqueueWakeup } = wakeRecorder();
    const service = recoveryService(db, { enqueueWakeup: enqueueWakeup as never });

    await service.reconcileActiveRecoveryActions({ companyId });
    await service.reconcileActiveRecoveryActions({ companyId });

    const wakes = calls.filter(call => call.input.reason === ISSUE_BLOCKER_STALLED_WAKE_REASON);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: techLead, input: {
      idempotencyKey: issueBlockerStalledWakeKey({ waiterIssueId: issue.id, stalledIssueId: issue.id, recoveryActionId: action.id }),
      contextSnapshot: { issueId: issue.id, wakeReason: ISSUE_BLOCKER_STALLED_WAKE_REASON, blockerStall: {
        stalledIssueId: issue.id, stalledIssueStatus: "blocked", relation: "overseer",
        recoveryAction: { id: action.id, cause: "execution_review_participant_recovery", ownerType: "board" },
      } },
    } });
    const activity = await db.select().from(activityLog).where(eq(activityLog.action, "issue.blocker_stalled_wake"));
    expect(activity.map(row => row.agentId)).toEqual([techLead]);
  });
  async function overseerWakes(companyId: string) {
    const { calls, enqueueWakeup } = wakeRecorder();
    await recoveryService(db, { enqueueWakeup: enqueueWakeup as never }).reconcileActiveRecoveryActions({ companyId });
    return calls.filter(call => call.input.reason === ISSUE_BLOCKER_STALLED_WAKE_REASON).map(call => call.agentId);
  }

  it("wakes the requester when the assignee has no manager", async () => {
    const companyId = await company();
    const productLead = await agent(companyId, "Product Lead");
    const techLead = await agent(companyId, "Tech Lead");
    await stalledIssue(companyId, techLead, { createdByAgentId: productLead });
    expect(await overseerWakes(companyId)).toEqual([productLead]);
  });

  it("oversees from the other side too: the tech lead answers to whoever asked it, and the product lead to whoever it asked", async () => {
    const companyId = await company();
    const productLead = await agent(companyId, "Product Lead");
    const techLead = await agent(companyId, "Tech Lead");
    await stalledIssue(companyId, productLead, { createdByAgentId: techLead });
    expect(await overseerWakes(companyId)).toEqual([techLead]);
  });

  it("prefers the manager over the requester", async () => {
    const companyId = await company();
    const techLead = await agent(companyId, "Tech Lead");
    const requester = await agent(companyId, "Product Lead");
    const reviewer = await agent(companyId, "QA Verifier", { reportsTo: techLead });
    await stalledIssue(companyId, reviewer, { createdByAgentId: requester });
    expect(await overseerWakes(companyId)).toEqual([techLead]);
  });

  it("falls back to the requester when no manager in the chain can be woken", async () => {
    const companyId = await company();
    const pausedLead = await agent(companyId, "Tech Lead", { status: "paused" });
    const requester = await agent(companyId, "Product Lead");
    const reviewer = await agent(companyId, "QA Verifier", { reportsTo: pausedLead });
    await stalledIssue(companyId, reviewer, { createdByAgentId: requester });
    expect(await overseerWakes(companyId)).toEqual([requester]);
  });

  it("walks past a paused manager to the next one up the chain", async () => {
    const companyId = await company();
    const cto = await agent(companyId, "CTO");
    const pausedLead = await agent(companyId, "Tech Lead", { status: "paused", reportsTo: cto });
    const reviewer = await agent(companyId, "QA Verifier", { reportsTo: pausedLead });
    await stalledIssue(companyId, reviewer);
    expect(await overseerWakes(companyId)).toEqual([cto]);
  });

  it("wakes nobody when the assignee is its own requester and has no manager", async () => {
    const companyId = await company();
    const solo = await agent(companyId, "Solo");
    await stalledIssue(companyId, solo, { createdByAgentId: solo });
    expect(await overseerWakes(companyId)).toEqual([]);
  });

  it("wakes nobody when a human created the issue and the assignee has no manager", async () => {
    const companyId = await company();
    const solo = await agent(companyId, "Solo");
    await stalledIssue(companyId, solo, { createdByUserId: "board-user" });
    expect(await overseerWakes(companyId)).toEqual([]);
  });
  it("reaches stalls beyond a full page of already-woken ones", async () => {
    const companyId = await company();
    const techLead = await agent(companyId, "Tech Lead");
    const reviewer = await agent(companyId, "QA Verifier", { reportsTo: techLead });
    for (let index = 0; index < 3; index += 1) await stalledIssue(companyId, reviewer);
    const { calls, enqueueWakeup } = wakeRecorder();

    await wakeOverseersOfStalledIssues(db, enqueueWakeup as never, { companyId, pageSize: 2 });
    await wakeOverseersOfStalledIssues(db, enqueueWakeup as never, { companyId, pageSize: 2 });

    expect(new Set(calls.map(call => call.input.idempotencyKey)).size).toBe(3);
  });
  it.each(["configuration_incomplete", "legacy_execution_requires_reconciliation", "workspace_validation_failed", "provider_transport_failed"])(
    "does not wake an overseer for %s, which no ruling can clear",
    async (cause) => {
      const companyId = await company();
      const techLead = await agent(companyId, "Tech Lead");
      const reviewer = await agent(companyId, "QA Verifier", { reportsTo: techLead });
      await stalledIssue(companyId, reviewer, {}, cause);
      expect(await overseerWakes(companyId)).toEqual([]);
    },
  );

  it.each(["stranded_assigned_issue", "deliberate_wait_without_target", "successful_run_missing_state", "execution_review_participant_recovery"])(
    "wakes the overseer for %s, where the agent stopped without a decision",
    async (cause) => {
      const companyId = await company();
      const techLead = await agent(companyId, "Tech Lead");
      const reviewer = await agent(companyId, "QA Verifier", { reportsTo: techLead });
      await stalledIssue(companyId, reviewer, {}, cause);
      expect(await overseerWakes(companyId)).toEqual([techLead]);
    },
  );

  it("never wakes the overseer again for a stall whose first wake was cancelled", async () => {
    const companyId = await company();
    const techLead = await agent(companyId, "Tech Lead");
    const reviewer = await agent(companyId, "QA Verifier", { reportsTo: techLead });
    await stalledIssue(companyId, reviewer);
    expect(await overseerWakes(companyId)).toEqual([techLead]);
    await db.update(agentWakeupRequests).set({ status: "cancelled" });
    expect(await overseerWakes(companyId)).toEqual([]);
  });

  describe("verifying an overseer wake at dispatch", () => {
    async function dispatchedWake() {
      const companyId = await company();
      const techLead = await agent(companyId, "Tech Lead");
      const reviewer = await agent(companyId, "QA Verifier", { reportsTo: techLead });
      const { issue, action } = await stalledIssue(companyId, reviewer);
      const { calls, enqueueWakeup } = wakeRecorder();
      await wakeOverseersOfStalledIssues(db, enqueueWakeup as never, { companyId });
      const contextSnapshot = calls[0]!.input.contextSnapshot as Record<string, unknown>;
      return { companyId, techLead, reviewer, issue, action, contextSnapshot };
    }
    const verify = (w: Awaited<ReturnType<typeof dispatchedWake>>, over: Partial<Parameters<typeof verifyOverseerStallWake>[1]> = {}) =>
      verifyOverseerStallWake(db, { companyId: w.companyId, issueId: w.issue.id, agentId: w.techLead,
        contextSnapshot: w.contextSnapshot, requestedByActorType: "system", ...over });

    it("accepts the manager the stall resolves to, while the board-owned action is active", async () => {
      expect(await verify(await dispatchedWake())).toBe(true);
    });

    it("rejects an agent that is not the stall's overseer", async () => {
      const w = await dispatchedWake();
      const stranger = await agent(w.companyId, "Stranger");
      expect(await verify(w, { agentId: stranger })).toBe(false);
    });

    it("rejects a wake not requested by the system", async () => {
      expect(await verify(await dispatchedWake(), { requestedByActorType: "agent" })).toBe(false);
    });

    it("rejects a wake whose context names another recovery action", async () => {
      const w = await dispatchedWake();
      const stall = w.contextSnapshot.blockerStall as Record<string, any>;
      const forged = { ...w.contextSnapshot, blockerStall: { ...stall, recoveryAction: { ...stall.recoveryAction, id: randomUUID() } } };
      expect(await verify(w, { contextSnapshot: forged })).toBe(false);
    });

    it("rejects the wake once the recovery action is resolved", async () => {
      const w = await dispatchedWake();
      await db.update(issueRecoveryActions).set({ status: "resolved" }).where(eq(issueRecoveryActions.id, w.action.id));
      expect(await verify(w)).toBe(false);
    });

    it("rejects a dependency-stall wake, which is not an overseer wake", async () => {
      const w = await dispatchedWake();
      const stall = w.contextSnapshot.blockerStall as Record<string, any>;
      expect(await verify(w, { contextSnapshot: { ...w.contextSnapshot, blockerStall: { ...stall, relation: "child" } } })).toBe(false);
    });
  });
});
