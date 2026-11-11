import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseObject } from "../server-utils.js";

const PLAYWRIGHT_MCP_SERVER_NAME = "Playwright browser";
const OUTPUT_DIR_MAX_BYTES = 200 * 1024 * 1024;

export interface PlaywrightBrowserConfig {
  enabled: boolean;
  headed: boolean;
  images: boolean;
  storageStatePath: string | null;
  allowedOrigins: string[];
}

export interface PlaywrightBrowserMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface PlaywrightBrowserLaunch {
  server: PlaywrightBrowserMcpServer;
  outputDir: string;
  storageStatePath: string;
  loginRestored: boolean;
}

export function defaultPlaywrightStorageStatePath(instanceRoot: string): string {
  return path.join(instanceRoot, "qa-browser", "storage-state.json");
}

export function readPlaywrightBrowserConfig(config: Record<string, unknown>): PlaywrightBrowserConfig {
  const browser = parseObject(config.browser);
  const storageStatePath = typeof browser.storageStatePath === "string" && browser.storageStatePath.trim()
    ? browser.storageStatePath.trim()
    : null;
  const allowedOrigins = Array.isArray(browser.allowedOrigins)
    ? browser.allowedOrigins.filter((origin): origin is string => typeof origin === "string" && origin.length > 0)
    : [];
  return {
    enabled: browser.enabled === true,
    headed: browser.headed === true,
    images: browser.images === true,
    storageStatePath,
    allowedOrigins,
  };
}

function resolvePlaywrightMcpCli(): string {
  const packageJson = createRequire(import.meta.url).resolve("@playwright/mcp/package.json");
  return path.join(path.dirname(packageJson), "cli.js");
}

export function buildPlaywrightBrowserLaunch(input: {
  config: PlaywrightBrowserConfig;
  instanceRoot: string;
  stateDir: string;
  runId: string;
  env: Record<string, string | undefined>;
  nodeBinary?: string;
  cliPath?: string;
}): PlaywrightBrowserLaunch {
  const { config } = input;
  const storageStatePath = config.storageStatePath ?? defaultPlaywrightStorageStatePath(input.instanceRoot);
  const loginRestored = fs.existsSync(storageStatePath);
  const outputDir = path.join(input.stateDir, "runs", input.runId, "browser");
  fs.mkdirSync(outputDir, { recursive: true });

  const args = [
    input.cliPath ?? resolvePlaywrightMcpCli(),
    "--isolated",
    "--output-dir",
    outputDir,
    "--output-max-size",
    String(OUTPUT_DIR_MAX_BYTES),
    "--console-level",
    "error",
    "--image-responses",
    config.images ? "allow" : "omit",
  ];
  if (!config.headed) args.push("--headless");
  if (loginRestored) args.push("--storage-state", storageStatePath);
  if (config.allowedOrigins.length > 0) args.push("--allowed-origins", config.allowedOrigins.join(";"));

  const environment: Array<{ name: string; value: string }> = [];
  for (const name of ["PATH", "HOME"]) {
    const value = input.env[name];
    if (value) environment.push({ name, value });
  }

  return {
    server: {
      name: PLAYWRIGHT_MCP_SERVER_NAME,
      command: input.nodeBinary ?? process.execPath,
      args,
      env: environment,
    },
    outputDir,
    storageStatePath,
    loginRestored,
  };
}
