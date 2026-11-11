import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
}

describeEmbeddedPostgres("child recovery routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-child-recovery-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  async function seedAgent(companyId: string, name: string) {
    const [agent] = await db.insert(agents).values({
      companyId, name, role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    return agent!;
  }

  async function seedRun(companyId: string, agentId: string, issueId: string) {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, issueId, status: "running", contextSnapshot: { issueId },
    }).returning();
    return run!;
  }

  async function seedFamily() {
    const nonce = randomUUID().slice(0, 6).toUpperCase();
    const [company] = await db.insert(companies).values({
      name: `Child recovery ${nonce}`, issuePrefix: `CR${nonce.slice(0, 4)}`, defaultResponsibleUserId: "board-user",
    }).returning();
    const lead = await seedAgent(company!.id, "Lead");
    const worker = await seedAgent(company!.id, "Worker");
    const stranger = await seedAgent(company!.id, "Stranger");
    const [grandparent] = await db.insert(issues).values({
      companyId: company!.id, title: "Grandparent", status: "in_progress", assigneeAgentId: lead.id, responsibleUserId: "board-user",
    }).returning();
    const [parent] = await db.insert(issues).values({
      companyId: company!.id, parentId: grandparent!.id, title: "Parent", status: "blocked", responsibleUserId: "board-user",
    }).returning();
    const [child] = await db.insert(issues).values({
      companyId: company!.id, parentId: parent!.id, title: "Child", status: "blocked", assigneeAgentId: worker.id,
      responsibleUserId: "board-user",
    }).returning();
    const [strangerTask] = await db.insert(issues).values({
      companyId: company!.id, title: "Unrelated", status: "in_progress", assigneeAgentId: stranger.id, responsibleUserId: "board-user",
    }).returning();
    return { company: company!, lead, worker, stranger, grandparent: grandparent!, parent: parent!, child: child!, strangerTask: strangerTask! };
  }

  describe("GET /issues/:id/handoff", () => {
    it("serves an ancestor agent", async () => {
      const family = await seedFamily();
      const run = await seedRun(family.company.id, family.lead.id, family.grandparent.id);

      const res = await request(createApp(db, agentActor(family.company.id, family.lead.id, run.id)))
        .get(`/api/issues/${family.child.id}/handoff`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.predecessor).toMatchObject({ id: family.child.id, title: "Child" });
    });

    it("refuses an unrelated agent", async () => {
      const family = await seedFamily();
      const run = await seedRun(family.company.id, family.stranger.id, family.strangerTask.id);

      const res = await request(createApp(db, agentActor(family.company.id, family.stranger.id, run.id)))
        .get(`/api/issues/${family.child.id}/handoff`);

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details).toMatchObject({ code: "child_recovery_not_authorized" });
    });

    it("serves the board", async () => {
      const family = await seedFamily();

      const res = await request(createApp(db, boardActor(family.company.id)))
        .get(`/api/issues/${family.child.id}/handoff`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.verifyBeforeRepeating).toEqual([]);
    });
  });
});
