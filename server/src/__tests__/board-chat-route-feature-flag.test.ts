import express from "express";
import { EventEmitter } from "node:events";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetExperimental = vi.hoisted(() => vi.fn());
const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(),
}));
const mockSpawn = vi.hoisted(() => vi.fn());
const mockPrepareManagedAiRuntime = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]): Promise<unknown> => {
    throw new Error("no default AI connection");
  }),
);

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
  issueService: () => mockIssueService,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mockSpawn,
}));

vi.mock("../services/ai-connection-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/ai-connection-runtime.js")>()),
  prepareManagedAiRuntime: mockPrepareManagedAiRuntime,
}));

vi.mock("../services/fast-responses.js", () => ({
  enqueueFastResponse: vi.fn(async () => undefined),
  supersedeFastResponse: vi.fn(async () => undefined),
}));

vi.mock("../routes/authz.js", () => ({
  getActorInfo: () => ({ actorType: "user", actorId: "user-1", agentId: null, runId: null }),
  assertCompanyAccess: () => {},
}));

async function createApp(deploymentMode: "local_trusted" | "authenticated" = "local_trusted") {
  const { boardChatRoutes } = await import("../routes/board-chat.js");
  const app = express();
  app.use(express.json());
  app.use("/api", boardChatRoutes({ transaction: async (effect: (tx: unknown) => unknown) => effect({}) } as any, { deploymentMode }));
  return app;
}

describe("POST /api/board/chat/stream feature flag guard (PAP-137)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 FEATURE_DISABLED when enableConferenceRoomChat is off", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: false });
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Conference Room Chat is not enabled",
      code: "FEATURE_DISABLED",
    });
    // The guard must fire before anything is persisted.
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("returns 403 DEPLOYMENT_MODE_UNSUPPORTED outside local_trusted even with the flag on", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    const app = await createApp("authenticated");

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("DEPLOYMENT_MODE_UNSUPPORTED");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("lets requests past the guard when the flag is on (400 on missing body, not 403)", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    const app = await createApp();

    // Omit the body so the request stops at validation — proves the guard
    // admitted it without spawning the chat subprocess.
    const res = await request(app).post("/api/board/chat/stream").send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "companyId and message are required" });
  });
});

describe("board-chat client disconnect", () => {
  function makeFakeProc() {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.exitCode = null;
    proc.killed = false;
    proc.kill = vi.fn(() => {
      proc.killed = true;
    });
    return proc;
  }

  it("kills the spawned subprocess when the client disconnects mid-stream", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    mockIssueService.list.mockResolvedValue([
      { id: "issue-1", title: "Board Operations", status: "todo" },
    ]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    mockIssueService.listComments.mockResolvedValue([]);
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc);
    const app = await createApp();

    const req = request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });
    // Start the request without awaiting the (never-ending) SSE response.
    const pending = req.then(
      () => undefined,
      () => undefined,
    );

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    expect(fakeProc.kill).not.toHaveBeenCalled();

    // Client walks away mid-stream.
    req.abort();
    await vi.waitFor(() => expect(fakeProc.kill).toHaveBeenCalledWith("SIGTERM"));

    // Let the subprocess close handler run so the slot is released.
    fakeProc.exitCode = 143;
    fakeProc.emit("close", 143);
    await pending;
  });
});

describe("board-chat history role classification", () => {
  it("treats only board-concierge comments as assistant turns", async () => {
    const { isConciergeReply } = await import("../routes/board-chat.js");

    // The relay's own persisted replies.
    expect(
      isConciergeReply({ authorAgentId: null, authorUserId: "board-concierge" }),
    ).toBe(true);

    // A human board user.
    expect(isConciergeReply({ authorAgentId: null, authorUserId: "user-1" })).toBe(
      false,
    );

    // An agent commenting on the standing issue is NOT this assistant — its
    // words must not be serialized as the assistant's own prior turns.
    expect(
      isConciergeReply({ authorAgentId: "agent-1", authorUserId: null }),
    ).toBe(false);

    // Defensive: an agent comment can never impersonate the concierge even if
    // both author fields are somehow set.
    expect(
      isConciergeReply({ authorAgentId: "agent-1", authorUserId: "board-concierge" }),
    ).toBe(false);
  });
});

describe("board-chat Claude CLI failures", () => {
  const authFailureResult = {
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: 401,
    error: "authentication_failed",
    result: "Failed to authenticate: OAuth session expired and could not be refreshed",
  };

  it("tells the operator to log in again when the CLI reports an expired session", async () => {
    const { describeBoardChatFailure } = await import("../routes/board-chat.js");

    const message = describeBoardChatFailure(authFailureResult);
    expect(message).toContain("CLAUDE_CONFIG_DIR");
    expect(message).not.toContain("/login");
  });

  it("falls back to the CLI failure description for non-auth errors", async () => {
    const { describeBoardChatFailure } = await import("../routes/board-chat.js");

    expect(
      describeBoardChatFailure({ type: "result", subtype: "error_max_turns", is_error: true, result: "Hit the turn limit" }),
    ).toContain("Hit the turn limit");
  });

  it("explains silent failures: timeouts, login prompts on stderr, and plain crashes", async () => {
    const { describeSilentBoardChatFailure } = await import("../routes/board-chat.js");

    expect(describeSilentBoardChatFailure({ timedOut: true, exitCode: null, stderr: "" })).toContain("too long");
    expect(describeSilentBoardChatFailure({ timedOut: false, exitCode: 1, stderr: "Please run /login" })).toContain("CLAUDE_CONFIG_DIR");
    expect(describeSilentBoardChatFailure({ timedOut: false, exitCode: 1, stderr: "boom" })).toContain("couldn't respond");
    expect(describeSilentBoardChatFailure({ timedOut: false, exitCode: 0, stderr: "" })).toBeNull();
  });

  it("points at AI connections settings when the managed connection is what expired", async () => {
    const { describeBoardChatFailure } = await import("../routes/board-chat.js");

    const message = describeBoardChatFailure(authFailureResult, true);
    expect(message).toContain("AI connections");
    expect(message).not.toContain("CLAUDE_CONFIG_DIR");
  });

  it("recognises failed results and ignores successful ones", async () => {
    const { isFailedClaudeResult } = await import("../routes/board-chat.js");

    expect(isFailedClaudeResult(authFailureResult)).toBe(true);
    expect(isFailedClaudeResult({ type: "result", subtype: "success", is_error: false, result: "ok" })).toBe(false);
    expect(isFailedClaudeResult({ type: "assistant" })).toBe(false);
  });

  it("streams an error event and persists no concierge reply when the CLI fails to authenticate", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    mockIssueService.list.mockResolvedValue([{ id: "issue-1", title: "Board Operations", status: "todo" }]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", createdAt: new Date() });
    mockIssueService.listComments.mockResolvedValue([]);
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.exitCode = null;
    proc.killed = false;
    proc.kill = vi.fn();
    mockSpawn.mockReturnValue(proc);
    const app = await createApp();

    const pending = request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" })
      .buffer(true)
      .parse((res, callback) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => callback(null, body));
      });
    const done = pending.then((res) => res.body as string);

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    const assistantError = {
      type: "assistant",
      error: "authentication_failed",
      message: { content: [{ type: "text", text: authFailureResult.result }] },
    };
    proc.stdout.emit("data", Buffer.from(`${JSON.stringify(assistantError)}\n${JSON.stringify(authFailureResult)}\n`));
    proc.emit("close", 1);

    const stream = await done;
    expect(stream).toContain('"type":"error"');
    expect(stream).toContain("CLAUDE_CONFIG_DIR");
    expect(stream).not.toContain('"type":"chunk"');
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
  });
});

describe("board-chat Claude connection", () => {
  function makeProc() {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.exitCode = null;
    proc.killed = false;
    proc.kill = vi.fn();
    return proc;
  }

  async function startChat(proc: any) {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    mockIssueService.list.mockResolvedValue([{ id: "issue-1", title: "Board Operations", status: "todo" }]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", createdAt: new Date() });
    mockIssueService.listComments.mockResolvedValue([]);
    mockSpawn.mockReturnValue(proc);
    const app = await createApp();
    const finished = request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" })
      .then(() => undefined, () => undefined);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    return finished;
  }

  it("runs claude with the responsible user's default AI connection and releases it afterwards", async () => {
    const cleanup = vi.fn(async () => undefined);
    mockPrepareManagedAiRuntime.mockResolvedValue({
      config: { env: { CLAUDE_CONFIG_DIR: "/managed/home/provider", ANTHROPIC_AUTH_TOKEN: "managed-value" } },
      cleanup,
    });
    const proc = makeProc();
    const finished = startChat(proc);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    const spawnEnv = mockSpawn.mock.calls[0][2].env;
    expect(spawnEnv.CLAUDE_CONFIG_DIR).toBe("/managed/home/provider");
    expect(spawnEnv.ANTHROPIC_AUTH_TOKEN).toBe("managed-value");
    expect(spawnEnv.PAPERCLIP_COMPANY_ID).toBe("company-1");
    expect(mockPrepareManagedAiRuntime).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        responsibleUserId: "user-1",
        binding: { provider: "anthropic", method: "subscription", mode: "responsible_user" },
      }),
    );
    expect(cleanup).not.toHaveBeenCalled();

    proc.emit("close", 0);
    await finished;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("falls back to the host environment when no AI connection can be used", async () => {
    mockPrepareManagedAiRuntime.mockRejectedValue(new Error("no default AI connection"));
    const proc = makeProc();
    const finished = startChat(proc);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    const spawnEnv = mockSpawn.mock.calls[0][2].env;
    expect(spawnEnv.PAPERCLIP_COMPANY_ID).toBe("company-1");
    expect(spawnEnv.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);

    proc.emit("close", 0);
    await finished;
  });
});
