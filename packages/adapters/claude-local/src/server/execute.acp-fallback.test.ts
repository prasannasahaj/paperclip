import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeClaudeAcp,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  executeClaudeAcp: vi.fn(async () => {
    throw new Error('Transform failed with 1 error: execute.ts:818:0: ERROR: Unexpected "<<"');
  }),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-1",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session-1",
        result: "hello",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => executeClaudeAcp,
  resolveClaudeExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
    ctx.config.engine === "cli"
      ? { engine: "cli", explicit: true }
      : ctx.config.engine === "acp"
      ? { engine: "acp", explicit: true }
      : { engine: "acp", explicit: false },
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: { model: "claude-opus-5", ...config },
    context: {},
    onLog: vi.fn(async (_stream: string, _chunk: string): Promise<void> => {}),
  };
}

describe("claude_local ACP startup fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not start CLI after default ACP fails", async () => {
    const ctx = buildContext();
    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');
    expect(executeClaudeAcp).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("trusts the Paperclip API URL when network access is allowlisted", async () => {
    const paperclipApiUrl = "http://127.0.0.1:4310";
    vi.stubEnv("PAPERCLIP_API_URL", paperclipApiUrl);
    const ctx = buildContext({ engine: "cli", networkScope: "allowlist" });

    await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.any(String),
      null,
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        localProcessSandbox: expect.objectContaining({
          networkScope: "allowlist",
          networkTrustedUrls: [paperclipApiUrl],
        }),
      }),
    );
  });

  it("keeps explicit ACP strict when startup fails", async () => {
    const ctx = buildContext({ engine: "acp" });

    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');

    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});

describe("claude_local CLI engine context compression notice", () => {
  const notice = "[paperclip] Context compression applies to the ACP engine only; this run goes direct.\n";

  function noticeCalls(ctx: ReturnType<typeof buildContext>) {
    return ctx.onLog.mock.calls.filter(([, chunk]) => String(chunk).includes("Context compression"));
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs the direct-run notice exactly once when compression mode is on", async () => {
    const ctx = buildContext({ engine: "cli", contextCompression: "on" });

    await execute(ctx as never);

    expect(noticeCalls(ctx)).toEqual([["stdout", notice]]);
  });

  it("logs the direct-run notice when compression mode is the default", async () => {
    const ctx = buildContext({ engine: "cli" });

    await execute(ctx as never);

    expect(noticeCalls(ctx)).toEqual([["stdout", notice]]);
  });

  it("logs the direct-run notice when compression mode is record", async () => {
    const ctx = buildContext({ engine: "cli", contextCompression: "record" });

    await execute(ctx as never);

    expect(noticeCalls(ctx)).toEqual([["stdout", notice]]);
  });

  it("logs nothing about compression when compression mode is off", async () => {
    const ctx = buildContext({ engine: "cli", contextCompression: "off" });

    await execute(ctx as never);

    expect(noticeCalls(ctx)).toEqual([]);
  });

  it("does not point the CLI at a compression proxy", async () => {
    const ctx = buildContext({ engine: "cli", contextCompression: "on" });

    await execute(ctx as never);

    const [, , , , options] = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [
      unknown,
      unknown,
      unknown,
      unknown,
      { env: Record<string, string> },
    ];
    expect(options.env).not.toHaveProperty("ANTHROPIC_BASE_URL");
  });

  it("still runs the CLI when the log sink rejects the notice", async () => {
    const ctx = buildContext({ engine: "cli", contextCompression: "on" });
    ctx.onLog.mockImplementation(async (_stream: string, chunk: string) => {
      if (chunk.includes("Context compression")) throw new Error("log sink down");
    });

    await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
  });

  it("does not log the CLI notice on the ACP engine", async () => {
    executeClaudeAcp.mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false } as never);
    const ctx = buildContext({ engine: "acp", contextCompression: "on" });

    await execute(ctx as never);

    expect(noticeCalls(ctx)).toEqual([]);
  });
});
