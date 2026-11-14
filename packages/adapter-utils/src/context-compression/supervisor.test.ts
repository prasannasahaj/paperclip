import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CavemanBinaries } from "./binaries.js";
import { resolveCompressionHome } from "./company-home.js";
import { PROXY_ENV_ALLOWLIST, createCompressionSupervisor, waitForLoopbackListen } from "./supervisor.js";

const BINARIES: CavemanBinaries = { proxy: "/fake/caveman-proxy", mcp: "/fake/caveman-mcp" };
const LOOPBACK = "127.0.0.1";

class FakeChild extends EventEmitter {
  kill = vi.fn(() => {
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  });

  constructor(readonly pid: number | undefined) {
    super();
  }
}

function createFakeSpawn() {
  const children: FakeChild[] = [];
  const spawnProcess = vi.fn((_command: string, _args: readonly string[], _options: Record<string, unknown>) => {
    const child = new FakeChild(1000 + children.length);
    children.push(child);
    return child as unknown as ChildProcess;
  });
  return { children, spawnProcess, asSpawn: spawnProcess as unknown as typeof spawn };
}

function spawnedEnv(spawnProcess: ReturnType<typeof createFakeSpawn>["spawnProcess"], callIndex = 0) {
  return spawnProcess.mock.calls[callIndex][2].env as Record<string, string | undefined>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("createCompressionSupervisor", () => {
  let instanceRoot: string;

  beforeEach(async () => {
    instanceRoot = await mkdtemp(path.join(os.tmpdir(), "compression-supervisor-"));
  });

  afterEach(async () => {
    await rm(instanceRoot, { recursive: true, force: true });
  });

  function ensureInput(overrides: { companyId?: string; mode?: "on" | "record" } = {}) {
    return { companyId: "company-1", instanceRoot, mode: "on" as const, binaries: BINARIES, ...overrides };
  }

  it("spawns one proxy with the documented env for mode on", async () => {
    const fake = createFakeSpawn();
    const supervisor = createCompressionSupervisor({
      spawn: fake.asSpawn,
      waitForListen: async () => true,
    });

    const availability = await supervisor.ensureRunning(ensureInput());

    const home = resolveCompressionHome(instanceRoot, "company-1");
    expect(fake.spawnProcess).toHaveBeenCalledTimes(1);
    expect(fake.spawnProcess.mock.calls[0][0]).toBe(BINARIES.proxy);
    const env = spawnedEnv(fake.spawnProcess);
    expect(env.CAVEMAN_HOME).toBe(home);
    expect(env.CAVEMAN_LISTEN).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(env.CAVEMAN_MODE).toBe("compress");
    expect(env.CAVEMAN_RECOVERY).toBe("mcp");
    expect(env.DO_NOT_TRACK).toBe("1");
    expect(availability).toEqual({
      available: true,
      baseUrl: `http://${env.CAVEMAN_LISTEN}`,
      home,
      mode: "on",
    });
  });

  it("a second caller arriving mid-start waits for the listen and gets the same result", async () => {
    const fake = createFakeSpawn();
    const listening = deferred<boolean>();
    const supervisor = createCompressionSupervisor({
      spawn: fake.asSpawn,
      waitForListen: () => listening.promise,
    });

    const first = supervisor.ensureRunning(ensureInput());
    await vi.waitFor(() => expect(fake.spawnProcess).toHaveBeenCalledTimes(1));
    let secondSettled = false;
    const second = supervisor.ensureRunning(ensureInput()).then((result) => {
      secondSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondSettled).toBe(false);
    listening.resolve(true);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    expect(secondResult.available).toBe(true);
    expect(fake.spawnProcess).toHaveBeenCalledTimes(1);
  });

  it("a second caller arriving mid-start gets unavailable when the start fails", async () => {
    const fake = createFakeSpawn();
    const firstListen = deferred<boolean>();
    const waitForListen = vi.fn<(port: number, timeoutMs: number) => Promise<boolean>>()
      .mockReturnValueOnce(firstListen.promise)
      .mockResolvedValue(false);
    const supervisor = createCompressionSupervisor({ spawn: fake.asSpawn, waitForListen });

    const first = supervisor.ensureRunning(ensureInput());
    await vi.waitFor(() => expect(fake.spawnProcess).toHaveBeenCalledTimes(1));
    const second = supervisor.ensureRunning(ensureInput());
    firstListen.resolve(false);

    expect((await first).available).toBe(false);
    expect((await second).available).toBe(false);
  });

  it("passes only allowlisted parent env keys to the proxy", async () => {
    const parentSecrets = { DATABASE_URL: "postgres://secret", ANTHROPIC_API_KEY: "sk-secret", CAVEMAN_AUTH_TOKEN: "cloud-token" };
    for (const [key, value] of Object.entries(parentSecrets)) vi.stubEnv(key, value);
    for (const key of PROXY_ENV_ALLOWLIST) vi.stubEnv(key, `parent-${key}`);
    try {
      const fake = createFakeSpawn();
      const supervisor = createCompressionSupervisor({
        spawn: fake.asSpawn,
        waitForListen: async () => true,
      });

      await supervisor.ensureRunning(ensureInput());

      const env = spawnedEnv(fake.spawnProcess);
      for (const key of Object.keys(parentSecrets)) expect(env[key]).toBeUndefined();
      for (const key of PROXY_ENV_ALLOWLIST) expect(env[key]).toBe(`parent-${key}`);
      expect(Object.keys(env).sort()).toEqual(
        [...PROXY_ENV_ALLOWLIST, "CAVEMAN_HOME", "CAVEMAN_LISTEN", "CAVEMAN_MODE", "CAVEMAN_RECOVERY", "DO_NOT_TRACK"].sort(),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports the mode the proxy was started with on first call", async () => {
    const fake = createFakeSpawn();
    const supervisor = createCompressionSupervisor({
      spawn: fake.asSpawn,
      waitForListen: async () => true,
    });

    const availability = await supervisor.ensureRunning(ensureInput({ mode: "record" }));

    expect(availability.available && availability.mode).toBe("record");
  });

  it("reports the original mode when a later call asks for a different mode", async () => {
    const onFirst = createFakeSpawn();
    const onSupervisor = createCompressionSupervisor({
      spawn: onFirst.asSpawn,
      waitForListen: async () => true,
    });
    await onSupervisor.ensureRunning(ensureInput({ mode: "on" }));
    const recordLater = await onSupervisor.ensureRunning(ensureInput({ mode: "record" }));
    expect(recordLater.available && recordLater.mode).toBe("on");
    expect(onFirst.spawnProcess).toHaveBeenCalledTimes(1);

    const recordFirst = createFakeSpawn();
    const recordSupervisor = createCompressionSupervisor({
      spawn: recordFirst.asSpawn,
      waitForListen: async () => true,
    });
    await recordSupervisor.ensureRunning(ensureInput({ mode: "record" }));
    const onLater = await recordSupervisor.ensureRunning(ensureInput({ mode: "on" }));
    expect(onLater.available && onLater.mode).toBe("record");
    expect(recordFirst.spawnProcess).toHaveBeenCalledTimes(1);
  });

  it("mode record sets CAVEMAN_MODE=record and no CAVEMAN_RECOVERY", async () => {
    vi.stubEnv("CAVEMAN_RECOVERY", "inherited-from-parent");
    try {
      const fake = createFakeSpawn();
      const supervisor = createCompressionSupervisor({
        spawn: fake.asSpawn,
        waitForListen: async () => true,
      });

      await supervisor.ensureRunning(ensureInput({ mode: "record" }));

      const env = spawnedEnv(fake.spawnProcess);
      expect(env.CAVEMAN_MODE).toBe("record");
      expect(env.CAVEMAN_RECOVERY).toBeUndefined();
      expect(env.DO_NOT_TRACK).toBe("1");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("sends proxy output to proxy.log in the company home", async () => {
    const fake = createFakeSpawn();
    const supervisor = createCompressionSupervisor({
      spawn: fake.asSpawn,
      waitForListen: async () => true,
    });

    await supervisor.ensureRunning(ensureInput());

    const stdio = fake.spawnProcess.mock.calls[0][2].stdio as unknown[];
    expect(stdio[0]).toBe("ignore");
    expect(typeof stdio[1]).toBe("number");
    expect(stdio[2]).toBe(stdio[1]);
    const home = resolveCompressionHome(instanceRoot, "company-1");
    expect((await stat(path.join(home, "proxy.log"))).isFile()).toBe(true);
    expect(await readFile(path.join(home, "proxy.log"), "utf8")).toBe("");
  });

  it("concurrent ensureRunning calls spawn exactly once", async () => {
    const fake = createFakeSpawn();
    const listening = deferred<boolean>();
    const supervisor = createCompressionSupervisor({
      spawn: fake.asSpawn,
      waitForListen: () => listening.promise,
    });

    const first = supervisor.ensureRunning(ensureInput());
    const second = supervisor.ensureRunning(ensureInput());
    await vi.waitFor(() => expect(fake.spawnProcess).toHaveBeenCalledTimes(1));
    listening.resolve(true);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(fake.spawnProcess).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.available).toBe(true);
  });

  it("reuses a live child on later calls", async () => {
    const fake = createFakeSpawn();
    const supervisor = createCompressionSupervisor({
      spawn: fake.asSpawn,
      waitForListen: async () => true,
    });

    const first = await supervisor.ensureRunning(ensureInput());
    const second = await supervisor.ensureRunning(ensureInput());

    expect(fake.spawnProcess).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("respawns on the same port after the child exited", async () => {
    const fake = createFakeSpawn();
    const supervisor = createCompressionSupervisor({
      spawn: fake.asSpawn,
      waitForListen: async () => true,
    });

    const first = await supervisor.ensureRunning(ensureInput());
    fake.children[0].emit("exit", 1, null);
    const second = await supervisor.ensureRunning(ensureInput());

    expect(fake.spawnProcess).toHaveBeenCalledTimes(2);
    expect(second).toEqual(first);
  });

  it("returns unavailable with a reason when the listener never opens", async () => {
    const fake = createFakeSpawn();
    const supervisor = createCompressionSupervisor({
      spawn: fake.asSpawn,
      waitForListen: async () => false,
    });

    const availability = await supervisor.ensureRunning(ensureInput());

    expect(availability.available).toBe(false);
    expect(availability.available === false && availability.reason).toMatch(/did not start listening/);
    expect(fake.children.length).toBeGreaterThan(0);
    for (const child of fake.children) expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("retries the whole start once and succeeds when the second attempt listens", async () => {
    const fake = createFakeSpawn();
    const waitForListen = vi.fn<(port: number, timeoutMs: number) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const supervisor = createCompressionSupervisor({ spawn: fake.asSpawn, waitForListen });

    const availability = await supervisor.ensureRunning(ensureInput());

    expect(availability.available).toBe(true);
    expect(fake.spawnProcess).toHaveBeenCalledTimes(2);
    expect(fake.children[0].kill).toHaveBeenCalledTimes(1);
    expect(fake.children[1].kill).not.toHaveBeenCalled();
  });

  it("gives up after exactly two failed attempts", async () => {
    const fake = createFakeSpawn();
    const supervisor = createCompressionSupervisor({
      spawn: fake.asSpawn,
      waitForListen: async () => false,
    });

    await supervisor.ensureRunning(ensureInput());

    expect(fake.spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("does not wait for the listener when the child exits during startup", async () => {
    const fake = createFakeSpawn();
    const supervisor = createCompressionSupervisor({
      spawn: fake.asSpawn,
      waitForListen: () => new Promise<boolean>(() => {}),
    });
    fake.spawnProcess.mockImplementation(() => {
      const child = new FakeChild(2000 + fake.children.length);
      fake.children.push(child);
      queueMicrotask(() => child.emit("exit", 1, null));
      return child as unknown as ChildProcess;
    });

    const availability = await supervisor.ensureRunning(ensureInput());

    expect(availability.available).toBe(false);
    expect(availability.available === false && availability.reason).toMatch(/exited/);
  });

  it("resolves unavailable when spawn emits an error event such as ENOENT", async () => {
    const fake = createFakeSpawn();
    const supervisor = createCompressionSupervisor({
      spawn: fake.asSpawn,
      waitForListen: () => new Promise<boolean>(() => {}),
    });
    fake.spawnProcess.mockImplementation(() => {
      const child = new FakeChild(undefined);
      fake.children.push(child);
      queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
      return child as unknown as ChildProcess;
    });

    const availability = await supervisor.ensureRunning(ensureInput());

    expect(availability.available).toBe(false);
    expect(availability.available === false && availability.reason).toContain("ENOENT");
  });

  it("resolves unavailable when spawn throws synchronously", async () => {
    const fake = createFakeSpawn();
    fake.spawnProcess.mockImplementation(() => {
      throw new Error("EACCES");
    });
    const supervisor = createCompressionSupervisor({
      spawn: fake.asSpawn,
      waitForListen: async () => true,
    });

    const availability = await supervisor.ensureRunning(ensureInput());

    expect(availability.available).toBe(false);
    expect(availability.available === false && availability.reason).toContain("EACCES");
  });

  it("resolves unavailable instead of throwing for an invalid company id", async () => {
    const fake = createFakeSpawn();
    const supervisor = createCompressionSupervisor({
      spawn: fake.asSpawn,
      waitForListen: async () => true,
    });

    const availability = await supervisor.ensureRunning(ensureInput({ companyId: "../escape" }));

    expect(availability.available).toBe(false);
    expect(fake.spawnProcess).not.toHaveBeenCalled();
  });

  it("different companies get separate children", async () => {
    const fake = createFakeSpawn();
    const supervisor = createCompressionSupervisor({
      spawn: fake.asSpawn,
      waitForListen: async () => true,
    });

    const first = await supervisor.ensureRunning(ensureInput({ companyId: "company-1" }));
    const second = await supervisor.ensureRunning(ensureInput({ companyId: "company-2" }));

    expect(fake.spawnProcess).toHaveBeenCalledTimes(2);
    expect(first.available && second.available && first.home).not.toBe(second.available && second.home);
    expect(spawnedEnv(fake.spawnProcess, 0).CAVEMAN_HOME).not.toBe(spawnedEnv(fake.spawnProcess, 1).CAVEMAN_HOME);
  });

  it("stopAll terminates every child", async () => {
    const fake = createFakeSpawn();
    const supervisor = createCompressionSupervisor({
      spawn: fake.asSpawn,
      waitForListen: async () => true,
    });
    await supervisor.ensureRunning(ensureInput({ companyId: "company-1" }));
    await supervisor.ensureRunning(ensureInput({ companyId: "company-2" }));

    await supervisor.stopAll();

    expect(fake.children).toHaveLength(2);
    for (const child of fake.children) expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("stopAll does not signal a child that already exited", async () => {
    const fake = createFakeSpawn();
    const supervisor = createCompressionSupervisor({
      spawn: fake.asSpawn,
      waitForListen: async () => true,
    });
    await supervisor.ensureRunning(ensureInput());
    fake.children[0].emit("exit", 0, null);

    await supervisor.stopAll();

    expect(fake.children[0].kill).not.toHaveBeenCalled();
  });

  it("stopAll with no children resolves", async () => {
    const supervisor = createCompressionSupervisor({
      spawn: createFakeSpawn().asSpawn,
      waitForListen: async () => true,
    });

    await expect(supervisor.stopAll()).resolves.toBeUndefined();
  });

  it("stopAll during startup kills the child and reports unavailable without retrying", async () => {
    const fake = createFakeSpawn();
    const listening = deferred<boolean>();
    const supervisor = createCompressionSupervisor({
      spawn: fake.asSpawn,
      waitForListen: () => listening.promise,
    });

    const pending = supervisor.ensureRunning(ensureInput());
    await vi.waitFor(() => expect(fake.spawnProcess).toHaveBeenCalledTimes(1));
    const stopping = supervisor.stopAll();
    listening.resolve(true);

    const availability = await pending;
    await stopping;
    expect(availability.available).toBe(false);
    expect(fake.spawnProcess).toHaveBeenCalledTimes(1);
    expect(fake.children[0].kill).toHaveBeenCalledTimes(1);
  });

  it("can start again after stopAll", async () => {
    const fake = createFakeSpawn();
    const supervisor = createCompressionSupervisor({
      spawn: fake.asSpawn,
      waitForListen: async () => true,
    });
    await supervisor.ensureRunning(ensureInput());
    await supervisor.stopAll();

    const availability = await supervisor.ensureRunning(ensureInput());

    expect(availability.available).toBe(true);
    expect(fake.spawnProcess).toHaveBeenCalledTimes(2);
  });
});

describe("process exit hook", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("registers a single process exit listener for any number of supervisors and companies", async () => {
    vi.resetModules();
    const onceSpy = vi.spyOn(process, "once");
    const { createCompressionSupervisor: createFresh } = await import("./supervisor.js");
    const instanceRoot = await mkdtemp(path.join(os.tmpdir(), "compression-exit-hook-"));
    try {
      for (let index = 0; index < 2; index += 1) {
        const fake = createFakeSpawn();
        const supervisor = createFresh({ spawn: fake.asSpawn, waitForListen: async () => true });
        for (const companyId of ["company-1", "company-2"]) {
          await supervisor.ensureRunning({ companyId, instanceRoot, mode: "on", binaries: BINARIES });
        }
      }
      const exitRegistrations = onceSpy.mock.calls.filter(([event]) => event === "exit");
      expect(exitRegistrations).toHaveLength(1);
    } finally {
      await rm(instanceRoot, { recursive: true, force: true });
    }
  });
});

describe("waitForLoopbackListen", () => {
  it("resolves true once something is listening on the port", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, LOOPBACK, () => resolve()));
    const { port } = server.address() as net.AddressInfo;
    try {
      await expect(waitForLoopbackListen(port, 1000)).resolves.toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("resolves true when the listener opens after the first attempt", async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, LOOPBACK, () => resolve()));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const late = net.createServer();
    const waiting = waitForLoopbackListen(port, 3000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await new Promise<void>((resolve) => late.listen(port, LOOPBACK, () => resolve()));
    try {
      await expect(waiting).resolves.toBe(true);
    } finally {
      await new Promise<void>((resolve) => late.close(() => resolve()));
    }
  });

  it("resolves false after the timeout when nothing listens", async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, LOOPBACK, () => resolve()));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    await expect(waitForLoopbackListen(port, 200)).resolves.toBe(false);
  });
});
