import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { CHILD_RESPAWN_LINEAGE_CAP, respawnChild } from "./child-respawn.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("bounded child respawn", () => {
  let postgres: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    postgres = await startEmbeddedPostgresTestDatabase("child-respawn-");
    db = createDb(postgres.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await postgres?.cleanup(); });

  async function seedFamily() {
    const nonce = randomUUID().slice(0, 6).toUpperCase();
    const [company] = await db.insert(companies).values({
      name: `Respawn ${nonce}`, issuePrefix: `RS${nonce.slice(0, 4)}`, defaultResponsibleUserId: "board-user",
    }).returning();
    const companyId = company!.id;
    const seedAgent = async (name: string) => (await db.insert(agents).values({
      companyId, name, role: "engineer", adapterType: "process", status: "idle", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning())[0]!;
    const lead = await seedAgent("Lead");
    const worker = await seedAgent("Worker");
    const stranger = await seedAgent("Stranger");
    const [parent] = await db.insert(issues).values({
      companyId, title: "Parent", status: "blocked", assigneeAgentId: lead.id, responsibleUserId: "board-user",
    }).returning();
    const [child] = await db.insert(issues).values({
      companyId, parentId: parent!.id, title: "Child", description: "Original brief.", status: "in_progress",
      assigneeAgentId: worker.id, responsibleUserId: "board-user",
    }).returning();
    await db.insert(issueRelations).values({ companyId, issueId: child!.id, relatedIssueId: parent!.id, type: "blocks" });
    return { companyId, lead, worker, stranger, parent: parent!, child: child! };
  }

  function respawnAsLead(family: Awaited<ReturnType<typeof seedFamily>>, predecessorIssueId: string) {
    return respawnChild(db, {
      companyId: family.companyId,
      predecessorIssueId,
      actor: { type: "agent", id: family.lead.id },
      reason: "Run lost its controller",
      approachNote: "Split the migration from the backfill.",
    });
  }

  async function respawnedSuccessorId(promise: ReturnType<typeof respawnChild>) {
    const result = await promise;
    if (result.outcome !== "respawned") throw new Error(`expected respawned, got ${result.outcome}`);
    return result.successorIssueId;
  }

  it("creates exactly one successor when called twice concurrently", async () => {
    const family = await seedFamily();

    const [first, second] = await Promise.all([respawnAsLead(family, family.child.id), respawnAsLead(family, family.child.id)]);

    expect(first).toMatchObject({ outcome: "respawned", generation: 1 });
    expect(second).toMatchObject({ outcome: "respawned", generation: 1 });
    expect(first.outcome === "respawned" && second.outcome === "respawned" && first.successorIssueId === second.successorIssueId).toBe(true);
    const successors = await db.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, family.companyId), eq(issues.originId, `respawn:${family.child.id}`)));
    expect(successors).toHaveLength(1);
  });

  it("cancels the predecessor and links the successor", async () => {
    const family = await seedFamily();

    const successorId = await respawnedSuccessorId(respawnAsLead(family, family.child.id));

    const [predecessor] = await db.select().from(issues).where(eq(issues.id, family.child.id));
    const [successor] = await db.select().from(issues).where(eq(issues.id, successorId));
    expect(predecessor!.status).toBe("cancelled");
    expect(successor).toMatchObject({
      companyId: family.companyId,
      parentId: family.parent.id,
      title: "Respawn 1: Child",
      assigneeAgentId: family.worker.id,
      originKind: "respawn",
      originId: `respawn:${family.child.id}`,
      createdByAgentId: family.lead.id,
    });
    expect(successor!.status).not.toBe("cancelled");
    expect(successor!.executionWorkspaceId).toBeNull();
    expect(successor!.description).toContain("Original brief.");
    expect(successor!.description).toContain("Run lost its controller");
    expect(successor!.description).toContain("Split the migration from the backfill.");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, family.child.id));
    expect(comments.some(comment => comment.body.includes(successor!.identifier ?? successor!.id))).toBe(true);
    const parentBlockers = await db.select({ blockerId: issueRelations.issueId }).from(issueRelations)
      .where(and(eq(issueRelations.companyId, family.companyId), eq(issueRelations.relatedIssueId, family.parent.id)));
    expect(parentBlockers).toEqual([{ blockerId: successorId }]);
  });

  it("refuses the fourth respawn with child_respawn_exhausted and opens a board recovery action with evidence", async () => {
    const family = await seedFamily();
    let latest = family.child.id;
    for (let generation = 1; generation <= CHILD_RESPAWN_LINEAGE_CAP; generation += 1) {
      latest = await respawnedSuccessorId(respawnAsLead(family, latest));
    }

    const refused = await respawnAsLead(family, latest);

    expect(CHILD_RESPAWN_LINEAGE_CAP).toBe(3);
    expect(refused).toEqual({ outcome: "exhausted", code: "child_respawn_exhausted" });
    const [lastSuccessor] = await db.select().from(issues).where(eq(issues.id, latest));
    expect(lastSuccessor!.status).not.toBe("cancelled");
    expect(lastSuccessor!.title).toBe("Respawn 3: Child");
    const [action] = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, family.companyId), eq(issueRecoveryActions.sourceIssueId, latest),
    ));
    expect(action).toMatchObject({ status: "active", ownerType: "board", cause: "child_respawn_exhausted" });
    expect(action!.evidence).toMatchObject({
      generation: 3,
      reason: "Run lost its controller",
      originalIssueId: family.child.id,
      lineageIssueIds: expect.arrayContaining([family.child.id, latest]),
    });
    const fourth = await db.select({ id: issues.id }).from(issues).where(eq(issues.originId, `respawn:${latest}`));
    expect(fourth).toEqual([]);
  });

  it("refuses when the company is paused or budget-stopped", async () => {
    const paused = await seedFamily();
    await db.update(companies).set({ status: "paused", pausedAt: new Date(), pauseReason: "manual" }).where(eq(companies.id, paused.companyId));
    const budgetStopped = await seedFamily();
    await db.update(companies).set({ status: "paused", pausedAt: new Date(), pauseReason: "budget" }).where(eq(companies.id, budgetStopped.companyId));

    await expect(respawnAsLead(paused, paused.child.id)).rejects.toMatchObject({ status: 409, details: { code: "budget_blocked" } });
    await expect(respawnAsLead(budgetStopped, budgetStopped.child.id)).rejects.toMatchObject({ status: 409, details: { code: "budget_blocked" } });
    const [pausedChild] = await db.select().from(issues).where(eq(issues.id, paused.child.id));
    expect(pausedChild!.status).toBe("in_progress");
  });

  it("refuses an unrelated agent", async () => {
    const family = await seedFamily();

    await expect(respawnChild(db, {
      companyId: family.companyId, predecessorIssueId: family.child.id, actor: { type: "agent", id: family.stranger.id }, reason: "mine now",
    })).rejects.toMatchObject({ status: 403, details: { code: "child_recovery_not_authorized" } });
  });

  it("refuses a predecessor from another company", async () => {
    const family = await seedFamily();
    const other = await seedFamily();

    await expect(respawnAsLead(family, other.child.id)).rejects.toMatchObject({ status: 404 });
  });

  it("writes one activity log entry per mutation", async () => {
    const family = await seedFamily();

    const successorId = await respawnedSuccessorId(respawnAsLead(family, family.child.id));
    await respawnAsLead(family, family.child.id);

    const entries = await db.select({ action: activityLog.action, entityId: activityLog.entityId }).from(activityLog)
      .where(eq(activityLog.companyId, family.companyId));
    expect(entries.map(entry => `${entry.action}:${entry.entityId}`).sort()).toEqual([
      `issue.blockers_transferred:${successorId}`,
      `issue.child_respawned:${family.child.id}`,
      `issue.comment_added:${family.child.id}`,
      `issue.created:${successorId}`,
      `issue.updated:${family.child.id}`,
    ].sort());
  });
});
