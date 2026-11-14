import { access, constants } from "node:fs/promises";
import path from "node:path";

export interface CavemanBinaries {
  proxy: string;
  mcp: string;
}

const EXECUTABLE_SUFFIX = process.platform === "win32" ? ".exe" : "";

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readPathDirectories(env: NodeJS.ProcessEnv): string[] {
  const rawPath = env.PATH ?? env.Path ?? "";
  return rawPath.split(path.delimiter).filter((directory) => directory.length > 0);
}

async function findExecutable(directories: string[], binaryName: string): Promise<string | null> {
  for (const directory of directories) {
    const candidate = path.join(directory, binaryName);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function resolveBinary(input: {
  overridePath: string | undefined;
  binaryName: string;
  searchDirectories: string[];
}): Promise<string | null> {
  const overridePath = input.overridePath?.trim();
  if (overridePath && (await isExecutable(overridePath))) return overridePath;
  return findExecutable(input.searchDirectories, `${input.binaryName}${EXECUTABLE_SUFFIX}`);
}

export async function resolveCavemanBinaries(input: {
  env: NodeJS.ProcessEnv;
  homeDir: string;
}): Promise<CavemanBinaries | null> {
  const searchDirectories = [...readPathDirectories(input.env), path.join(input.homeDir, ".caveman", "bin")];
  const [proxy, mcp] = await Promise.all([
    resolveBinary({ overridePath: input.env.CAVEMAN_PROXY_BIN, binaryName: "caveman-proxy", searchDirectories }),
    resolveBinary({ overridePath: input.env.CAVEMAN_MCP_BIN, binaryName: "caveman-mcp", searchDirectories }),
  ]);
  if (!proxy || !mcp) return null;
  return { proxy, mcp };
}
