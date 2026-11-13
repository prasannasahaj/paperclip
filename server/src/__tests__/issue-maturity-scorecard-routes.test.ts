import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueMaturityScorecard } from "@paperclipai/shared";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));
const mockLoadIssueMaturityScorecard = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());

const accessibleIssue = {
  id: "issue-1",
  companyId: "company-1",
  projectId: null,
  parentId: null,
  assigneeAgentId: null,
  assigneeUserId: null,
  status: "todo",
};

const scorecard: IssueMaturityScorecard = {
  issueId: "issue-1",
  includeDescendants: true,
  truncated: false,
  runCount: 2,
  reworkRuns: 1,
  recheckAfterFailure: 1,
  environmentBlockedCount: 0,
  agentWaitShare: 0.25,
  byKind: [],
  modelMix: [{ model: "sonnet", costCents: 8, inputTokens: 150, outputTokens: 15 }],
  findings: [],
};

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
  }));
  vi.doMock("../services/maturity/issue-maturity-scorecard.js", () => ({
    loadIssueMaturityScorecard: mockLoadIssueMaturityScorecard,
  }));
}

describe("issue maturity scorecard route", () => {
  const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
    const [maturityRouteModule, middlewareModule] = await Promise.all([
      vi.importActual<typeof import("../routes/maturity.js")>("../routes/maturity.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    return { ...maturityRouteModule, errorHandler: middlewareModule.errorHandler };
  });

  function createApp(actor: unknown = { type: "board", userId: "board-user", source: "local_implicit" }) {
    const { maturityRoutes, errorHandler } = routeModules.value;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor as typeof req.actor;
      next();
    });
    app.use("/api", maturityRoutes({} as never));
    app.use(errorHandler);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(accessibleIssue);
    mockIssueService.getByIdentifier.mockResolvedValue(accessibleIssue);
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "issue:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockLoadIssueMaturityScorecard.mockResolvedValue(scorecard);
  });

  it("returns the scorecard for an accessible issue", async () => {
    const res = await request(createApp()).get("/api/issues/issue-1/maturity-scorecard");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(scorecard);
    expect(mockLoadIssueMaturityScorecard).toHaveBeenCalledWith(expect.anything(), "company-1", "issue-1", {
      excludeRoot: false,
    });
  });

  it("resolves issue identifiers", async () => {
    const res = await request(createApp()).get("/api/issues/pc1a2-1/maturity-scorecard");

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PC1A2-1");
  });

  it.each(["true", "1"])("honors excludeRoot=%s", async (value) => {
    const res = await request(createApp()).get("/api/issues/issue-1/maturity-scorecard").query({ excludeRoot: value });

    expect(res.status).toBe(200);
    expect(mockLoadIssueMaturityScorecard).toHaveBeenCalledWith(expect.anything(), "company-1", "issue-1", {
      excludeRoot: true,
    });
  });

  it("treats any other excludeRoot value as false", async () => {
    await request(createApp()).get("/api/issues/issue-1/maturity-scorecard").query({ excludeRoot: "yes" });

    expect(mockLoadIssueMaturityScorecard).toHaveBeenCalledWith(expect.anything(), "company-1", "issue-1", {
      excludeRoot: false,
    });
  });

  it("returns 404 for an issue that does not exist", async () => {
    mockIssueService.getById.mockResolvedValue(null);

    const res = await request(createApp()).get("/api/issues/missing/maturity-scorecard");

    expect(res.status).toBe(404);
    expect(mockLoadIssueMaturityScorecard).not.toHaveBeenCalled();
  });

  it("returns 404 for an issue in another company", async () => {
    const app = createApp({ type: "board", userId: "board-user", source: "session", companyIds: ["company-2"] });

    const res = await request(app).get("/api/issues/issue-1/maturity-scorecard");

    expect(res.status).toBe(404);
    expect(mockLoadIssueMaturityScorecard).not.toHaveBeenCalled();
  });

  it("returns 404 for an agent of another company", async () => {
    const app = createApp({ type: "agent", agentId: "agent-9", companyId: "company-2", source: "agent_key" });

    const res = await request(app).get("/api/issues/issue-1/maturity-scorecard");

    expect(res.status).toBe(404);
    expect(mockLoadIssueMaturityScorecard).not.toHaveBeenCalled();
  });

  it("returns 403 when the actor may not read the issue", async () => {
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      action: "issue:read",
      reason: "deny_test",
      explanation: "Denied by test mock.",
    });

    const res = await request(createApp()).get("/api/issues/issue-1/maturity-scorecard");

    expect(res.status).toBe(403);
    expect(mockLoadIssueMaturityScorecard).not.toHaveBeenCalled();
  });

  it("does not write to the activity log", async () => {
    await request(createApp()).get("/api/issues/issue-1/maturity-scorecard");

    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
