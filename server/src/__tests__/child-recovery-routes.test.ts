import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
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

  describe("POST /issues/:id/respawn", () => {
    async function seedRespawnChain(family: Awaited<ReturnType<typeof seedFamily>>, length: number) {
      let latest = family.child;
      for (let generation = 1; generation <= length; generation += 1) {
        const [successor] = await db.insert(issues).values({
          companyId: family.company.id, parentId: family.parent.id, title: `Respawn ${generation}: Child`, status: "todo",
          assigneeAgentId: family.worker.id, responsibleUserId: "board-user", originKind: "respawn", originId: `respawn:${latest.id}`,
        }).returning();
        latest = successor!;
      }
      return latest;
    }

    it("respawns for an ancestor agent and replays the same successor", async () => {
      const family = await seedFamily();
      const run = await seedRun(family.company.id, family.lead.id, family.grandparent.id);
      const app = createApp(db, agentActor(family.company.id, family.lead.id, run.id));

      const first = await request(app).post(`/api/issues/${family.child.id}/respawn`).send({ reason: "Controller vanished" });
      const replay = await request(app).post(`/api/issues/${family.child.id}/respawn`).send({ reason: "Controller vanished" });

      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body).toMatchObject({ outcome: "respawned", generation: 1, created: true });
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body).toMatchObject({ successorIssueId: first.body.successorIssueId, created: false });
    });

    it("refuses an unrelated agent", async () => {
      const family = await seedFamily();
      const run = await seedRun(family.company.id, family.stranger.id, family.strangerTask.id);

      const res = await request(createApp(db, agentActor(family.company.id, family.stranger.id, run.id)))
        .post(`/api/issues/${family.child.id}/respawn`).send({ reason: "Taking over" });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details).toMatchObject({ code: "child_recovery_not_authorized" });
    });

    it("refuses an agent respawning a healthy child that still has a live run", async () => {
      const family = await seedFamily();
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, family.child.id));
      await seedRun(family.company.id, family.worker.id, family.child.id);
      const leadRun = await seedRun(family.company.id, family.lead.id, family.grandparent.id);

      const res = await request(createApp(db, agentActor(family.company.id, family.lead.id, leadRun.id)))
        .post(`/api/issues/${family.child.id}/respawn`).send({ reason: "Looks slow" });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.details).toMatchObject({ code: "child_respawn_predecessor_live", issueId: family.child.id });
      const [child] = await db.select().from(issues).where(eq(issues.id, family.child.id));
      expect(child!.status).toBe("in_progress");
    });

    it("lets the board respawn a child that still has a live run", async () => {
      const family = await seedFamily();
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, family.child.id));
      await seedRun(family.company.id, family.worker.id, family.child.id);

      const res = await request(createApp(db, boardActor(family.company.id)))
        .post(`/api/issues/${family.child.id}/respawn`).send({ reason: "Operator decision" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });

    it("answers 409 child_respawn_exhausted once the lineage cap is reached", async () => {
      const family = await seedFamily();
      const third = await seedRespawnChain(family, 3);

      const res = await request(createApp(db, boardActor(family.company.id)))
        .post(`/api/issues/${third.id}/respawn`).send({ reason: "Still failing" });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.details).toMatchObject({ code: "child_respawn_exhausted", issueId: third.id });
    });

    it("rejects a body without a reason", async () => {
      const family = await seedFamily();

      const res = await request(createApp(db, boardActor(family.company.id)))
        .post(`/api/issues/${family.child.id}/respawn`).send({});

      expect(res.status, JSON.stringify(res.body)).toBe(400);
    });
  });
});
