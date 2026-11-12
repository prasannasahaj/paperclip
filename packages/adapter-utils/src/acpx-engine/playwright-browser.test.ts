import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPlaywrightBrowserLaunch,
  defaultPlaywrightStorageStatePath,
  readPlaywrightBrowserConfig,
  type PlaywrightBrowserConfig,
} from "./playwright-browser.js";

const ENABLED: PlaywrightBrowserConfig = {
  enabled: true,
  headed: false,
  images: false,
  storageStatePath: null,
  cdpEndpoint: null,
  allowedOrigins: [],
};

describe("readPlaywrightBrowserConfig", () => {
  it("is disabled when the agent has no browser settings", () => {
    expect(readPlaywrightBrowserConfig({}).enabled).toBe(false);
  });

  it("is disabled unless enabled is exactly true", () => {
    expect(readPlaywrightBrowserConfig({ browser: { enabled: "true" } }).enabled).toBe(false);
    expect(readPlaywrightBrowserConfig({ browser: { enabled: true } }).enabled).toBe(true);
  });

  it("defaults to headless without images", () => {
    const config = readPlaywrightBrowserConfig({ browser: { enabled: true } });
    expect(config).toMatchObject({
      headed: false,
      images: false,
      storageStatePath: null,
      cdpEndpoint: null,
      allowedOrigins: [],
    });
  });

  it("reads headed, images, storage state and allowed origins", () => {
    const config = readPlaywrightBrowserConfig({
      browser: {
        enabled: true,
        headed: true,
        images: true,
        storageStatePath: " /tmp/login.json ",
        cdpEndpoint: " http://localhost:9222 ",
        allowedOrigins: ["http://localhost:3000", "", 7],
      },
    });
    expect(config).toEqual({
      enabled: true,
      headed: true,
      images: true,
      storageStatePath: "/tmp/login.json",
      cdpEndpoint: "http://localhost:9222",
      allowedOrigins: ["http://localhost:3000"],
    });
  });
});

describe("buildPlaywrightBrowserLaunch", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-browser-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function launch(config: PlaywrightBrowserConfig, runId = "run-1") {
    return buildPlaywrightBrowserLaunch({
      config,
      instanceRoot: path.join(root, "instance"),
      stateDir: path.join(root, "state"),
      runId,
      env: { PATH: "/usr/bin", HOME: "/home/agent", SECRET_TOKEN: "do-not-forward" },
      nodeBinary: "/usr/local/bin/node",
      cliPath: "/pkg/playwright-mcp/cli.js",
    });
  }

  it("starts an in-memory headless browser so runs cannot share or lock a profile", () => {
    const { server } = launch(ENABLED);
    expect(server.command).toBe("/usr/local/bin/node");
    expect(server.args[0]).toBe("/pkg/playwright-mcp/cli.js");
    expect(server.args).toContain("--isolated");
    expect(server.args).toContain("--headless");
    expect(server.args).not.toContain("--user-data-dir");
  });

  it("omits --headless when headed", () => {
    expect(launch({ ...ENABLED, headed: true }).server.args).not.toContain("--headless");
  });

  it("keeps token cost low by default and sends images only on request", () => {
    const quiet = launch(ENABLED).server.args;
    expect(quiet[quiet.indexOf("--image-responses") + 1]).toBe("omit");
    expect(quiet[quiet.indexOf("--console-level") + 1]).toBe("error");
    const visual = launch({ ...ENABLED, images: true }).server.args;
    expect(visual[visual.indexOf("--image-responses") + 1]).toBe("allow");
  });

  it("gives every run its own output directory", () => {
    const first = launch(ENABLED, "run-a");
    const second = launch(ENABLED, "run-b");
    expect(first.outputDir).not.toBe(second.outputDir);
    expect(fs.statSync(first.outputDir).isDirectory()).toBe(true);
    expect(first.server.args[first.server.args.indexOf("--output-dir") + 1]).toBe(first.outputDir);
  });

  it("starts signed out and says so when no login has been saved", () => {
    const result = launch(ENABLED);
    expect(result.loginRestored).toBe(false);
    expect(result.storageStatePath).toBe(defaultPlaywrightStorageStatePath(path.join(root, "instance")));
    expect(result.server.args).not.toContain("--storage-state");
  });

  it("restores the saved login when the storage state file exists", () => {
    const storageStatePath = path.join(root, "login.json");
    fs.writeFileSync(storageStatePath, JSON.stringify({ cookies: [], origins: [] }));
    const result = launch({ ...ENABLED, storageStatePath });
    expect(result.loginRestored).toBe(true);
    expect(result.server.args[result.server.args.indexOf("--storage-state") + 1]).toBe(storageStatePath);
  });

  it("attaches to a running browser instead of starting an in-memory one", () => {
    const result = launch({ ...ENABLED, cdpEndpoint: "http://localhost:9222" });
    const { args } = result.server;
    expect(args[args.indexOf("--cdp-endpoint") + 1]).toBe("http://localhost:9222");
    expect(args).not.toContain("--isolated");
    expect(args).not.toContain("--headless");
    expect(result.cdpEndpoint).toBe("http://localhost:9222");
  });

  it("ignores a saved login when attaching because the running browser owns its logins", () => {
    const storageStatePath = path.join(root, "login.json");
    fs.writeFileSync(storageStatePath, JSON.stringify({ cookies: [], origins: [] }));
    const result = launch({ ...ENABLED, storageStatePath, cdpEndpoint: "http://localhost:9222" });
    expect(result.loginRestored).toBe(false);
    expect(result.server.args).not.toContain("--storage-state");
  });

  it("restricts navigation when allowed origins are configured", () => {
    const { server } = launch({ ...ENABLED, allowedOrigins: ["http://localhost:3000", "https://qa.example.com"] });
    expect(server.args[server.args.indexOf("--allowed-origins") + 1]).toBe(
      "http://localhost:3000;https://qa.example.com",
    );
  });

  it("forwards only PATH, HOME and the socket directory to the browser process", () => {
    const { server } = launch(ENABLED);
    expect(server.env.map((entry) => entry.name)).toEqual(["PATH", "HOME", "PWTEST_SOCKETS_DIR"]);
    expect(server.env.find((entry) => entry.name === "PATH")?.value).toBe("/usr/bin");
    expect(server.env.find((entry) => entry.name === "HOME")?.value).toBe("/home/agent");
  });

  it.skipIf(process.platform === "win32")(
    "keeps the browser socket path short even when the caller's temp directory is long",
    () => {
      const longTempDir = `/private/var/folders/${"x".repeat(60)}/T/claude-501-sandbox`;
      const { server } = buildPlaywrightBrowserLaunch({
        config: ENABLED,
        instanceRoot: path.join(root, "instance"),
        stateDir: path.join(root, "state"),
        runId: "run-1",
        env: { PATH: "/usr/bin", HOME: "/home/agent", TMPDIR: longTempDir },
        nodeBinary: "/usr/local/bin/node",
        cliPath: "/pkg/playwright-mcp/cli.js",
      });
      const socketsDir = server.env.find((entry) => entry.name === "PWTEST_SOCKETS_DIR")?.value;
      expect(socketsDir).toMatch(/^\/tmp\/pw-[0-9a-f]{8}$/);
    },
  );

  it.skipIf(process.platform === "win32")("uses one socket directory per instance across runs", () => {
    const socketsDir = (runId: string) =>
      launch(ENABLED, runId).server.env.find((entry) => entry.name === "PWTEST_SOCKETS_DIR")?.value;
    expect(socketsDir("run-a")).toMatch(/^\/tmp\/pw-/);
    expect(socketsDir("run-a")).toBe(socketsDir("run-b"));
  });

  it("resolves the bundled Playwright MCP entrypoint by default", () => {
    const { server } = buildPlaywrightBrowserLaunch({
      config: ENABLED,
      instanceRoot: path.join(root, "instance"),
      stateDir: path.join(root, "state"),
      runId: "run-default",
      env: {},
    });
    expect(server.args[0]).toMatch(/@playwright[\\/]mcp[\\/]cli\.js$/);
    expect(fs.existsSync(server.args[0])).toBe(true);
  });
});
