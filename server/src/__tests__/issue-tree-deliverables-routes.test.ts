import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const ROOT_PATH = `/api/issues/${ROOT_ID}/tree-deliverables`;

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockListIssueTreeDeliverables = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/issue-tree-deliverables.js", () => ({
  listIssueTreeDeliverables: mockListIssueTreeDeliverables,
}));

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
};

const deliverables = {
  rootIssueId: ROOT_ID,
  tasks: [],
  omitted: { tasks: false, workProducts: false, documents: false },
};

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueTreeDeliverablesRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issue-tree-deliverables.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueTreeDeliverablesRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("issue tree deliverables route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({ id: ROOT_ID, companyId: "company-1" });
    mockAccessService.decide.mockResolvedValue({ allowed: true });
    mockListIssueTreeDeliverables.mockResolvedValue(deliverables);
  });

  it("returns the deliverables for a readable root", async () => {
    const app = await createApp(boardActor);

    const res = await request(app).get(ROOT_PATH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(deliverables);
    expect(mockListIssueTreeDeliverables).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for a root in another company without calling the service", async () => {
    mockIssueService.getById.mockResolvedValue({ id: ROOT_ID, companyId: "company-2" });
    const app = await createApp(boardActor);

    const res = await request(app).get(ROOT_PATH);

    expect(res.status).toBe(404);
    expect(mockListIssueTreeDeliverables).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing root without calling the service", async () => {
    mockIssueService.getById.mockResolvedValue(null);
    const app = await createApp(boardActor);

    const res = await request(app).get(ROOT_PATH);

    expect(res.status).toBe(404);
    expect(mockListIssueTreeDeliverables).not.toHaveBeenCalled();
  });

  it("denies a root the actor cannot read without calling the service", async () => {
    mockAccessService.decide.mockResolvedValue({ allowed: false, reason: "deny_issue_private" });
    const app = await createApp(boardActor);

    const res = await request(app).get(ROOT_PATH);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Issue not found" });
    expect(mockListIssueTreeDeliverables).not.toHaveBeenCalled();
  });

  it("answers an unreadable root exactly like a missing root", async () => {
    mockIssueService.getById.mockResolvedValue(null);
    const missing = await request(await createApp(boardActor)).get(ROOT_PATH);
    mockIssueService.getById.mockResolvedValue({ id: ROOT_ID, companyId: "company-1" });
    mockAccessService.decide.mockResolvedValue({ allowed: false, reason: "deny_issue_private" });

    const unreadable = await request(await createApp(boardActor)).get(ROOT_PATH);

    expect(unreadable.status).toBe(missing.status);
    expect(unreadable.body).toEqual(missing.body);
  });

  it("passes the actor, not just the company, to the service", async () => {
    const app = await createApp(boardActor);

    await request(app).get(ROOT_PATH);

    expect(mockListIssueTreeDeliverables).toHaveBeenCalledWith(
      expect.anything(),
      { companyId: "company-1", rootIssueId: ROOT_ID, actor: boardActor },
    );
  });

  it("serves an agent actor from its own company", async () => {
    const agentActor = { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key" };
    const app = await createApp(agentActor);

    const res = await request(app).get(ROOT_PATH);

    expect(res.status).toBe(200);
    expect(mockListIssueTreeDeliverables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actor: agentActor }),
    );
  });

  it("rejects an unauthenticated caller without calling the service", async () => {
    const app = await createApp({ type: "none" });

    const res = await request(app).get(ROOT_PATH);

    expect(res.status).toBe(403);
    expect(mockListIssueTreeDeliverables).not.toHaveBeenCalled();
  });

  it("asks the access service for issue read on the root's resource and scope", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: ROOT_ID,
      companyId: "company-1",
      projectId: "project-1",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      status: "in_progress",
    });
    const app = await createApp(boardActor);

    await request(app).get(ROOT_PATH);

    expect(mockAccessService.decide).toHaveBeenCalledWith({
      actor: boardActor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: "company-1",
        issueId: ROOT_ID,
        projectId: "project-1",
        parentIssueId: "parent-1",
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        status: "in_progress",
      },
      scope: {
        issueId: ROOT_ID,
        projectId: "project-1",
        parentIssueId: "parent-1",
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
      },
    });
  });

  it("does not write an activity log entry", async () => {
    const app = await createApp(boardActor);

    await request(app).get(ROOT_PATH);

    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
