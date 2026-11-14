import os from "node:os";
import { resolveCavemanBinaries } from "./binaries.js";
import { resolveRecoveryStorePath } from "./company-home.js";
import { readContextCompressionMode } from "./config.js";
import { getCompressionSupervisor, type CompressionSupervisor } from "./supervisor.js";

export type CompressionSkipReason =
  | "disabled"
  | "not-claude"
  | "remote-target"
  | "binaries-missing"
  | "base-url-pinned"
  | "bedrock"
  | "vertex"
  | "proxy-unavailable";

export interface CompressionMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface AttachContextCompressionInput {
  config: Record<string, unknown>;
  companyId: string;
  instanceRoot: string;
  acpxAgent: string;
  executionTargetIsRemote: boolean;
  env: Record<string, string>;
  hostEnv: NodeJS.ProcessEnv;
  mcpServers: Array<CompressionMcpServer | { name: string }>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
  supervisor?: CompressionSupervisor;
  resolveBinaries?: typeof resolveCavemanBinaries;
}

export type AttachContextCompressionResult =
  | { attached: true; baseUrl: string }
  | { attached: false; reason: CompressionSkipReason };

export const RECOVERY_MCP_SERVER_NAME = "caveman";
const LOG_PREFIX = "[paperclip] Context compression";

function isPresent(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isTruthyFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

function hasBedrockSettings(source: Record<string, string | undefined>): boolean {
  return isTruthyFlag(source.CLAUDE_CODE_USE_BEDROCK) || isPresent(source.ANTHROPIC_BEDROCK_BASE_URL);
}

function hasVertexSettings(source: Record<string, string | undefined>): boolean {
  return isTruthyFlag(source.CLAUDE_CODE_USE_VERTEX) || isPresent(source.ANTHROPIC_VERTEX_BASE_URL);
}

export function isRecoveryMcpServer(server: { name: string }): boolean {
  return server.name === RECOVERY_MCP_SERVER_NAME;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function skip(reason: CompressionSkipReason): AttachContextCompressionResult {
  return { attached: false, reason };
}

async function logQuietly(
  onLog: AttachContextCompressionInput["onLog"],
  stream: "stdout" | "stderr",
  chunk: string,
): Promise<void> {
  try {
    await onLog(stream, chunk);
  } catch {
    return;
  }
}

async function attachWhenEligible(input: AttachContextCompressionInput): Promise<AttachContextCompressionResult> {
  const requestedMode = readContextCompressionMode(input.config);
  if (requestedMode === "off") return skip("disabled");
  if (input.acpxAgent !== "claude") return skip("not-claude");
  if (input.executionTargetIsRemote) return skip("remote-target");

  if (isPresent(input.env.ANTHROPIC_BASE_URL) || isPresent(input.hostEnv.ANTHROPIC_BASE_URL)) {
    await logQuietly(
      input.onLog,
      "stdout",
      `${LOG_PREFIX} skipped: ANTHROPIC_BASE_URL is already set, so Claude keeps using that endpoint.\n`,
    );
    return skip("base-url-pinned");
  }
  if (hasBedrockSettings(input.env) || hasBedrockSettings(input.hostEnv)) {
    await logQuietly(input.onLog, "stdout", `${LOG_PREFIX} skipped: Claude is configured for Bedrock.\n`);
    return skip("bedrock");
  }
  if (hasVertexSettings(input.env) || hasVertexSettings(input.hostEnv)) {
    await logQuietly(input.onLog, "stdout", `${LOG_PREFIX} skipped: Claude is configured for Vertex AI.\n`);
    return skip("vertex");
  }

  const resolveBinaries = input.resolveBinaries ?? resolveCavemanBinaries;
  const binaries = await resolveBinaries({ env: input.hostEnv, homeDir: os.homedir() });
  if (!binaries) {
    await logQuietly(
      input.onLog,
      "stderr",
      `${LOG_PREFIX} unavailable: caveman-proxy and caveman-mcp were not found on PATH or in ~/.caveman/bin; continuing without it.\n`,
    );
    return skip("binaries-missing");
  }

  const supervisor = input.supervisor ?? getCompressionSupervisor();
  const availability = await supervisor.ensureRunning({
    companyId: input.companyId,
    instanceRoot: input.instanceRoot,
    mode: requestedMode,
    binaries,
  });
  if (!availability.available) {
    await logQuietly(
      input.onLog,
      "stderr",
      `${LOG_PREFIX} unavailable: ${availability.reason}; continuing without it.\n`,
    );
    return skip("proxy-unavailable");
  }

  input.env.ANTHROPIC_BASE_URL = availability.baseUrl;
  input.env.DO_NOT_TRACK = "1";
  const alreadyHasRecoveryServer = input.mcpServers.some(isRecoveryMcpServer);
  if (availability.mode === "on" && !alreadyHasRecoveryServer) {
    input.mcpServers.push({
      name: RECOVERY_MCP_SERVER_NAME,
      command: binaries.mcp,
      args: [],
      env: [
        { name: "CAVEMAN_HOME", value: availability.home },
        { name: "CAVEMAN_CCR_DB", value: resolveRecoveryStorePath(availability.home) },
        { name: "CAVEMAN_MCP_EPHEMERAL", value: "0" },
      ],
    });
  }
  await logQuietly(input.onLog, "stdout", `${LOG_PREFIX}: ${availability.mode}\n`);
  return { attached: true, baseUrl: availability.baseUrl };
}

export async function attachContextCompression(
  input: AttachContextCompressionInput,
): Promise<AttachContextCompressionResult> {
  try {
    return await attachWhenEligible(input);
  } catch (error) {
    await logQuietly(
      input.onLog,
      "stderr",
      `${LOG_PREFIX} unavailable: ${describeError(error)}; continuing without it.\n`,
    );
    return skip("proxy-unavailable");
  }
}
