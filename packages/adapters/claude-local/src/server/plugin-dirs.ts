import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

const PLUGIN_MANIFEST_RELATIVE_PATH = path.join(".claude-plugin", "plugin.json");

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

export function resolveClaudePluginStoreDir(env: NodeJS.ProcessEnv, companyId: string): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.resolve(instanceRoot, "companies", companyId, "claude-plugins");
}

export async function listStoredClaudePluginDirs(storeDir: string): Promise<string[]> {
  const entries = await fs.readdir(storeDir, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(storeDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
  const installed: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, PLUGIN_MANIFEST_RELATIVE_PATH))) installed.push(candidate);
  }
  return installed;
}

export async function resolveClaudePluginDirs(input: {
  env: NodeJS.ProcessEnv;
  companyId: string;
  configuredPluginDirs: string[];
}): Promise<string[]> {
  const stored = await listStoredClaudePluginDirs(resolveClaudePluginStoreDir(input.env, input.companyId));
  const configured = input.configuredPluginDirs
    .map((dir) => nonEmpty(dir))
    .filter((dir): dir is string => dir !== null)
    .map((dir) => path.resolve(dir));
  return [...new Set([...stored, ...configured])];
}

export function buildClaudePluginArgs(pluginDirs: string[]): string[] {
  return pluginDirs.flatMap((dir) => ["--plugin-dir", dir]);
}

export function shouldUseStrictMcpConfig(input: { runtimeMcpServerCount: number; pluginDirCount: number }): boolean {
  return input.runtimeMcpServerCount > 0 && input.pluginDirCount === 0;
}
