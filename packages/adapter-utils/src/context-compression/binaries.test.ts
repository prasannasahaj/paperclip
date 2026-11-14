import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCavemanBinaries } from "./binaries.js";

const PROXY_NAME = process.platform === "win32" ? "caveman-proxy.exe" : "caveman-proxy";
const MCP_NAME = process.platform === "win32" ? "caveman-mcp.exe" : "caveman-mcp";

async function writeStub(directory: string, fileName: string, mode = 0o755) {
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, fileName);
  await writeFile(filePath, "#!/bin/sh\n");
  await chmod(filePath, mode);
  return filePath;
}

describe("resolveCavemanBinaries", () => {
  let sandbox: string;
  let homeDir: string;
  let pathDir: string;
  let overrideDir: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), "caveman-binaries-"));
    homeDir = path.join(sandbox, "home");
    pathDir = path.join(sandbox, "path-bin");
    overrideDir = path.join(sandbox, "override-bin");
    await mkdir(homeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("prefers CAVEMAN_PROXY_BIN and CAVEMAN_MCP_BIN overrides", async () => {
    await writeStub(pathDir, PROXY_NAME);
    await writeStub(pathDir, MCP_NAME);
    const overrideProxy = await writeStub(overrideDir, "custom-proxy");
    const overrideMcp = await writeStub(overrideDir, "custom-mcp");

    const resolved = await resolveCavemanBinaries({
      env: { PATH: pathDir, CAVEMAN_PROXY_BIN: overrideProxy, CAVEMAN_MCP_BIN: overrideMcp },
      homeDir,
    });

    expect(resolved).toEqual({ proxy: overrideProxy, mcp: overrideMcp });
  });

  it("finds both on PATH", async () => {
    const proxy = await writeStub(pathDir, PROXY_NAME);
    const mcp = await writeStub(pathDir, MCP_NAME);

    const resolved = await resolveCavemanBinaries({ env: { PATH: pathDir }, homeDir });

    expect(resolved).toEqual({ proxy, mcp });
  });

  it("falls back to ~/.caveman/bin", async () => {
    const homeBin = path.join(homeDir, ".caveman", "bin");
    const proxy = await writeStub(homeBin, PROXY_NAME);
    const mcp = await writeStub(homeBin, MCP_NAME);

    const resolved = await resolveCavemanBinaries({ env: { PATH: pathDir }, homeDir });

    expect(resolved).toEqual({ proxy, mcp });
  });

  it("returns null when either binary is missing", async () => {
    await writeStub(pathDir, PROXY_NAME);

    const resolved = await resolveCavemanBinaries({ env: { PATH: pathDir }, homeDir });

    expect(resolved).toBeNull();
  });

  it("ignores a directory named like the binary", async () => {
    const directoryOnPath = path.join(sandbox, "first-bin");
    await mkdir(path.join(directoryOnPath, PROXY_NAME), { recursive: true });
    const overrideDirectory = path.join(sandbox, "override-dir");
    await mkdir(overrideDirectory, { recursive: true });
    const env = {
      PATH: [directoryOnPath, pathDir].join(path.delimiter),
      CAVEMAN_MCP_BIN: overrideDirectory,
    };

    expect(await resolveCavemanBinaries({ env, homeDir })).toBeNull();

    const proxy = await writeStub(pathDir, PROXY_NAME);
    const mcp = await writeStub(pathDir, MCP_NAME);

    expect(await resolveCavemanBinaries({ env, homeDir })).toEqual({ proxy, mcp });
  });

  it.skipIf(process.platform === "win32")("ignores non-executable files", async () => {
    await writeStub(pathDir, PROXY_NAME, 0o644);
    await writeStub(pathDir, MCP_NAME);

    const resolved = await resolveCavemanBinaries({ env: { PATH: pathDir }, homeDir });

    expect(resolved).toBeNull();
  });
});
