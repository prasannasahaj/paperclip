import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  documents,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRecoveryActions,
  issues,
  issueWorkProducts,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { buildChildHandoff, CHILD_HANDOFF_COMMENT_BODY_LIMIT, CHILD_HANDOFF_COMMENT_LIMIT } from "./child-handoff.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("child handoff ledger", () => {
  let postgres: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    postgres = await startEmbeddedPostgresTestDatabase("child-handoff-");
    db = createDb(postgres.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await postgres?.cleanup(); });

  async function seedFamily() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Handoff company", issuePrefix: `H${companyId.slice(0, 6)}` });
    const [parentAgent] = await db.insert(agents).values({ companyId, name: "Lead", adapterType: "process", status: "idle" }).returning();
    const [childAgent] = await db.insert(agents).values({ companyId, name: "Worker", adapterType: "process", status: "idle" }).returning();
    const [parent] = await db.insert(issues).values({ companyId, title: "Parent", status: "in_progress", assigneeAgentId: parentAgent!.id }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({
      companyId, mode: "isolated_workspace", strategyType: "git_worktree", name: "child", branchName: "feat/child-work",
    }).returning();
    const [child] = await db.insert(issues).values({
      companyId, parentId: parent!.id, title: "Child", status: "cancelled", assigneeAgentId: childAgent!.id,
      createdByAgentId: parentAgent!.id, executionWorkspaceId: workspace!.id,
    }).returning();
    return { companyId, parentAgent: parentAgent!, childAgent: childAgent!, parent: parent!, child: child! };
  }

  it("returns branch, last failed run and blocking action for a cancelled child", async () => {
    const family = await seedFamily();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: family.companyId, agentId: family.childAgent.id, issueId: family.child.id,
      status: "failed", errorCode: "process_lost", error: "controller vanished", finishedAt: new Date(),
      contextSnapshot: { issueId: family.child.id },
    });
    await db.insert(issueRecoveryActions).values({
      companyId: family.companyId, sourceIssueId: family.child.id, kind: "active_run_watchdog", status: "active",
      ownerType: "board", cause: "native_restart_recovery_blocked", fingerprint: `fp:${runId}`,
      evidence: { runId, reason: "controller_process_space_unverified" }, nextAction: "Confirm the controller stopped.",
    });
    await db.insert(issueWorkProducts).values({
      companyId: family.companyId, issueId: family.child.id, type: "pull_request", provider: "gitlab",
      title: "MR !12", url: "https://git.example/mr/12", status: "open",
    });
    const [document] = await db.insert(documents).values({ companyId: family.companyId, title: "Plan", latestBody: "steps" }).returning();
    await db.insert(issueDocuments).values({ companyId: family.companyId, issueId: family.child.id, documentId: document!.id, key: "plan" });
    await db.insert(issueComments).values({
      companyId: family.companyId, issueId: family.child.id, authorAgentId: family.childAgent.id, authorType: "agent", body: "Pushed the first half.",
    });

    const handoff = await buildChildHandoff(db, { companyId: family.companyId, issueId: family.child.id });

    expect(handoff.predecessor).toMatchObject({ id: family.child.id, title: "Child", status: "cancelled", assigneeAgentId: family.childAgent.id });
    expect(handoff.lastRun).toMatchObject({ id: runId, status: "failed", errorCode: "process_lost", error: "controller vanished" });
    expect(handoff.recoveryAction).toEqual({
      cause: "native_restart_recovery_blocked", reason: "controller_process_space_unverified", nextAction: "Confirm the controller stopped.",
    });
    expect(handoff.workspace).toEqual({ branch: "feat/child-work", headSha: null, hasUncommittedChanges: null });
    expect(handoff.workProducts).toEqual([{ id: expect.any(String), kind: "pull_request", title: "MR !12", url: "https://git.example/mr/12" }]);
    expect(handoff.documents).toEqual([{ key: "plan", title: "Plan", updatedAt: expect.any(Date) }]);
    expect(handoff.recentComments).toEqual([expect.objectContaining({ authorLabel: "Worker", body: "Pushed the first half." })]);
    expect(handoff.verifyBeforeRepeating).toEqual([
      expect.stringContaining("feat/child-work"),
      expect.stringContaining("https://git.example/mr/12"),
      "Confirm the controller stopped.",
    ]);
  });

  it("caps comments at 20 and bodies at 4000", async () => {
    const family = await seedFamily();
    const start = Date.now() - 60_000;
    await db.insert(issueComments).values(Array.from({ length: 25 }, (_, index) => ({
      companyId: family.companyId, issueId: family.child.id, authorAgentId: family.childAgent.id, authorType: "agent" as const,
      body: `${index}:${"x".repeat(5000)}`, createdAt: new Date(start + index * 1000),
    })));

    const handoff = await buildChildHandoff(db, { companyId: family.companyId, issueId: family.child.id });

    expect(CHILD_HANDOFF_COMMENT_LIMIT).toBe(20);
    expect(CHILD_HANDOFF_COMMENT_BODY_LIMIT).toBe(4000);
    expect(handoff.recentComments).toHaveLength(20);
    expect(handoff.recentComments[0]!.body.startsWith("24:")).toBe(true);
    expect(handoff.recentComments.every(comment => comment.body.length <= 4000)).toBe(true);
  });

  it("never includes another company's rows", async () => {
    const family = await seedFamily();
    const other = await seedFamily();
    await db.insert(issueComments).values({
      companyId: other.companyId, issueId: other.child.id, authorAgentId: other.childAgent.id, authorType: "agent", body: "other company secret",
    });
    await db.insert(heartbeatRuns).values({
      companyId: other.companyId, agentId: other.childAgent.id, status: "failed",
      contextSnapshot: { issueId: family.child.id },
    });

    const handoff = await buildChildHandoff(db, { companyId: family.companyId, issueId: family.child.id });

    expect(handoff.lastRun).toBeNull();
    expect(handoff.recentComments).toEqual([]);
    await expect(buildChildHandoff(db, { companyId: family.companyId, issueId: other.child.id })).rejects.toMatchObject({ status: 404 });
  });
});
