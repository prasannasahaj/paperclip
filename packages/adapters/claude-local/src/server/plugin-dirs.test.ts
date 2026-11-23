import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildClaudePluginArgs,
  listStoredClaudePluginDirs,
  resolveClaudePluginDirs,
  resolveClaudePluginStoreDir,
  shouldUseStrictMcpConfig,
} from "./plugin-dirs.js";

async function writePlugin(root: string, name: string) {
  const manifestDir = path.join(root, name, ".claude-plugin");
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(path.join(manifestDir, "plugin.json"), JSON.stringify({ name }));
}

describe("claude plugin dirs", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugin-dirs-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("lists only directories that carry a plugin manifest, sorted, skipping dot directories", async () => {
    await writePlugin(tmp, "zeta");
    await writePlugin(tmp, "alpha");
    await writePlugin(tmp, ".staging");
    await fs.mkdir(path.join(tmp, "not-a-plugin"), { recursive: true });

    const listed = await listStoredClaudePluginDirs(tmp);

    expect(listed).toEqual([path.join(tmp, "alpha"), path.join(tmp, "zeta")]);
  });

  it("returns nothing when the store directory does not exist", async () => {
    expect(await listStoredClaudePluginDirs(path.join(tmp, "missing"))).toEqual([]);
  });

  it("scopes the store to the company under the instance root", () => {
    const storeDir = resolveClaudePluginStoreDir({ PAPERCLIP_HOME: tmp, PAPERCLIP_INSTANCE_ID: "dev" }, "company-1");

    expect(storeDir).toBe(path.join(tmp, "instances", "dev", "companies", "company-1", "claude-plugins"));
  });

  it("merges stored and configured plugin dirs without duplicates", async () => {
    const env = { PAPERCLIP_HOME: tmp, PAPERCLIP_INSTANCE_ID: "dev" };
    const storeDir = resolveClaudePluginStoreDir(env, "company-1");
    await writePlugin(storeDir, "atlassian");
    const stored = path.join(storeDir, "atlassian");

    const resolved = await resolveClaudePluginDirs({
      env,
      companyId: "company-1",
      configuredPluginDirs: [stored, "  ", path.join(tmp, "extra")],
    });

    expect(resolved).toEqual([stored, path.join(tmp, "extra")]);
  });

  it("emits one --plugin-dir pair per directory", () => {
    expect(buildClaudePluginArgs(["/a", "/b"])).toEqual(["--plugin-dir", "/a", "--plugin-dir", "/b"]);
  });

  it("drops strict MCP config only when plugins are loaded", () => {
    expect(shouldUseStrictMcpConfig({ runtimeMcpServerCount: 1, pluginDirCount: 0 })).toBe(true);
    expect(shouldUseStrictMcpConfig({ runtimeMcpServerCount: 1, pluginDirCount: 2 })).toBe(false);
    expect(shouldUseStrictMcpConfig({ runtimeMcpServerCount: 0, pluginDirCount: 0 })).toBe(false);
  });
});
