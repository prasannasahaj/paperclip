import { describe, expect, it, vi } from "vitest";
import { attachContextCompression } from "./attach.js";
import type { CavemanBinaries } from "./binaries.js";
import type { CompressionProxyMode, CompressionSupervisor, ProxyAvailability } from "./supervisor.js";

const BINARIES: CavemanBinaries = { proxy: "/fake/caveman-proxy", mcp: "/fake/caveman-mcp" };
const BASE_URL = "http://127.0.0.1:43111";
const HOME = "/fake/instance/companies/company-1/context-compression";

function availableAt(mode: CompressionProxyMode): ProxyAvailability {
  return { available: true, baseUrl: BASE_URL, home: HOME, mode };
}

function createHarness(
  overrides: {
    config?: Record<string, unknown>;
    acpxAgent?: string;
    executionTargetIsRemote?: boolean;
    env?: Record<string, string>;
    hostEnv?: NodeJS.ProcessEnv;
    binaries?: CavemanBinaries | null;
    ensureRunning?: () => Promise<ProxyAvailability>;
    resolveBinaries?: () => Promise<CavemanBinaries | null>;
  } = {},
) {
  const ensureRunning = vi.fn(overrides.ensureRunning ?? (async () => availableAt("on")));
  const supervisor: CompressionSupervisor = { ensureRunning, stopAll: vi.fn(async () => {}) };
  const resolveBinaries = vi.fn(overrides.resolveBinaries ?? (async () => (overrides.binaries === undefined ? BINARIES : overrides.binaries)));
  const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
  const env: Record<string, string> = overrides.env ?? {};
  const mcpServers: Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> = [];
  const attach = () =>
    attachContextCompression({
      config: overrides.config ?? {},
      companyId: "company-1",
      instanceRoot: "/fake/instance",
      acpxAgent: overrides.acpxAgent ?? "claude",
      executionTargetIsRemote: overrides.executionTargetIsRemote ?? false,
      env,
      hostEnv: overrides.hostEnv ?? {},
      mcpServers,
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      supervisor,
      resolveBinaries: resolveBinaries as never,
    });
  return { attach, ensureRunning, resolveBinaries, logs, env, mcpServers };
}

describe("attachContextCompression", () => {
  it("attaches env and MCP server when eligible", async () => {
    const harness = createHarness();

    const result = await harness.attach();

    expect(result).toEqual({ attached: true, baseUrl: BASE_URL });
    expect(harness.env.ANTHROPIC_BASE_URL).toBe(BASE_URL);
    expect(harness.env.DO_NOT_TRACK).toBe("1");
    expect(harness.mcpServers).toEqual([
      { name: "Caveman recovery", command: BINARIES.mcp, args: [], env: [{ name: "CAVEMAN_HOME", value: HOME }] },
    ]);
    expect(harness.logs).toEqual([{ stream: "stdout", chunk: "[paperclip] Context compression: on\n" }]);
    expect(harness.ensureRunning).toHaveBeenCalledWith({
      companyId: "company-1",
      instanceRoot: "/fake/instance",
      mode: "on",
      binaries: BINARIES,
    });
  });

  it("skips with reason disabled when mode is off without logging", async () => {
    const harness = createHarness({ config: { contextCompression: "off" } });

    const result = await harness.attach();

    expect(result).toEqual({ attached: false, reason: "disabled" });
    expect(harness.logs).toEqual([]);
    expect(harness.env).toEqual({});
    expect(harness.resolveBinaries).not.toHaveBeenCalled();
    expect(harness.ensureRunning).not.toHaveBeenCalled();
  });

  it("skips silently for non-claude agents", async () => {
    const harness = createHarness({ acpxAgent: "codex" });

    expect(await harness.attach()).toEqual({ attached: false, reason: "not-claude" });
    expect(harness.logs).toEqual([]);
    expect(harness.ensureRunning).not.toHaveBeenCalled();
  });

  it("skips silently for remote targets even when the host env pins a base url", async () => {
    const harness = createHarness({ executionTargetIsRemote: true, hostEnv: { ANTHROPIC_BASE_URL: "https://gateway.example" } });

    expect(await harness.attach()).toEqual({ attached: false, reason: "remote-target" });
    expect(harness.logs).toEqual([]);
    expect(harness.ensureRunning).not.toHaveBeenCalled();
  });

  it("skips and logs once when the adapter env already sets ANTHROPIC_BASE_URL", async () => {
    const harness = createHarness({ env: { ANTHROPIC_BASE_URL: "https://gateway.example" } });

    expect(await harness.attach()).toEqual({ attached: false, reason: "base-url-pinned" });
    expect(harness.logs).toHaveLength(1);
    expect(harness.logs[0].chunk).toMatch(/^\[paperclip\] Context compression .*ANTHROPIC_BASE_URL/);
    expect(harness.env.ANTHROPIC_BASE_URL).toBe("https://gateway.example");
    expect(harness.ensureRunning).not.toHaveBeenCalled();
  });

  it("skips and logs once when the host env sets ANTHROPIC_BASE_URL", async () => {
    const harness = createHarness({ hostEnv: { ANTHROPIC_BASE_URL: "https://gateway.example" } });

    expect(await harness.attach()).toEqual({ attached: false, reason: "base-url-pinned" });
    expect(harness.logs).toHaveLength(1);
    expect(harness.ensureRunning).not.toHaveBeenCalled();
  });

  it("treats blank ANTHROPIC_BASE_URL values as unset", async () => {
    const harness = createHarness({ env: { ANTHROPIC_BASE_URL: "" }, hostEnv: { ANTHROPIC_BASE_URL: "   " } });

    expect(await harness.attach()).toEqual({ attached: true, baseUrl: BASE_URL });
    expect(harness.env.ANTHROPIC_BASE_URL).toBe(BASE_URL);
  });

  it.each([
    ["CLAUDE_CODE_USE_BEDROCK=1 in the adapter env", { env: { CLAUDE_CODE_USE_BEDROCK: "1" } }],
    ["CLAUDE_CODE_USE_BEDROCK=true in the adapter env", { env: { CLAUDE_CODE_USE_BEDROCK: "true" } }],
    ["ANTHROPIC_BEDROCK_BASE_URL in the adapter env", { env: { ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example" } }],
    ["CLAUDE_CODE_USE_BEDROCK=1 in the host env", { hostEnv: { CLAUDE_CODE_USE_BEDROCK: "1" } }],
    ["ANTHROPIC_BEDROCK_BASE_URL in the host env", { hostEnv: { ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example" } }],
  ])("skips and logs once on Bedrock flags: %s", async (_label, overrides) => {
    const harness = createHarness(overrides);

    expect(await harness.attach()).toEqual({ attached: false, reason: "bedrock" });
    expect(harness.logs).toHaveLength(1);
    expect(harness.logs[0].chunk).toMatch(/^\[paperclip\] Context compression .*Bedrock/);
    expect(harness.ensureRunning).not.toHaveBeenCalled();
  });

  it("does not treat a falsy Bedrock flag as Bedrock", async () => {
    const harness = createHarness({ env: { CLAUDE_CODE_USE_BEDROCK: "0", ANTHROPIC_BEDROCK_BASE_URL: "  " } });

    expect(await harness.attach()).toEqual({ attached: true, baseUrl: BASE_URL });
  });

  it("logs exactly one warning and skips when binaries are missing", async () => {
    const harness = createHarness({ binaries: null });

    expect(await harness.attach()).toEqual({ attached: false, reason: "binaries-missing" });
    expect(harness.logs).toHaveLength(1);
    expect(harness.logs[0].stream).toBe("stderr");
    expect(harness.logs[0].chunk).toMatch(/^\[paperclip\] Context compression .*caveman-proxy/);
    expect(harness.ensureRunning).not.toHaveBeenCalled();
  });

  it("logs one warning with the reason and skips when the proxy is unavailable", async () => {
    const harness = createHarness({ ensureRunning: async () => ({ available: false, reason: "port already taken" }) });

    expect(await harness.attach()).toEqual({ attached: false, reason: "proxy-unavailable" });
    expect(harness.logs).toHaveLength(1);
    expect(harness.logs[0].stream).toBe("stderr");
    expect(harness.logs[0].chunk).toContain("port already taken");
    expect(harness.env).toEqual({});
    expect(harness.mcpServers).toEqual([]);
  });

  it("attaches env but no MCP server when record was requested and the proxy runs in record", async () => {
    const harness = createHarness({
      config: { contextCompression: "record" },
      ensureRunning: async () => availableAt("record"),
    });

    expect(await harness.attach()).toEqual({ attached: true, baseUrl: BASE_URL });
    expect(harness.env.ANTHROPIC_BASE_URL).toBe(BASE_URL);
    expect(harness.env.DO_NOT_TRACK).toBe("1");
    expect(harness.mcpServers).toEqual([]);
    expect(harness.ensureRunning).toHaveBeenCalledWith(expect.objectContaining({ mode: "record" }));
    expect(harness.logs).toEqual([{ stream: "stdout", chunk: "[paperclip] Context compression: record\n" }]);
  });

  it("attaches the MCP server when record was requested but the running proxy started in on", async () => {
    const harness = createHarness({
      config: { contextCompression: "record" },
      ensureRunning: async () => availableAt("on"),
    });

    expect(await harness.attach()).toEqual({ attached: true, baseUrl: BASE_URL });
    expect(harness.env.ANTHROPIC_BASE_URL).toBe(BASE_URL);
    expect(harness.mcpServers.map((server) => server.name)).toEqual(["Caveman recovery"]);
    expect(harness.logs).toEqual([{ stream: "stdout", chunk: "[paperclip] Context compression: on\n" }]);
  });

  it("attaches no MCP server when on was requested but the running proxy started in record", async () => {
    const harness = createHarness({
      config: { contextCompression: "on" },
      ensureRunning: async () => availableAt("record"),
    });

    expect(await harness.attach()).toEqual({ attached: true, baseUrl: BASE_URL });
    expect(harness.env.ANTHROPIC_BASE_URL).toBe(BASE_URL);
    expect(harness.mcpServers).toEqual([]);
    expect(harness.logs).toEqual([{ stream: "stdout", chunk: "[paperclip] Context compression: record\n" }]);
  });

  it("does not push a duplicate MCP server when attached twice to the same collections", async () => {
    const harness = createHarness();

    await harness.attach();
    await harness.attach();

    expect(harness.mcpServers).toHaveLength(1);
  });

  it("never throws when the supervisor rejects", async () => {
    const harness = createHarness({
      ensureRunning: async () => {
        throw new Error("supervisor exploded");
      },
    });

    expect(await harness.attach()).toEqual({ attached: false, reason: "proxy-unavailable" });
    expect(harness.logs).toHaveLength(1);
    expect(harness.logs[0].stream).toBe("stderr");
    expect(harness.logs[0].chunk).toContain("supervisor exploded");
  });

  it("never throws when binary resolution rejects", async () => {
    const harness = createHarness({
      resolveBinaries: async () => {
        throw new Error("disk unreadable");
      },
    });

    expect(await harness.attach()).toEqual({ attached: false, reason: "proxy-unavailable" });
    expect(harness.logs).toHaveLength(1);
    expect(harness.logs[0].chunk).toContain("disk unreadable");
  });
});
