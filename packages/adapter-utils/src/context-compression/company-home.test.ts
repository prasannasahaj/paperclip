import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireCompressionPort, resolveCompressionHome } from "./company-home.js";

const LOOPBACK = "127.0.0.1";

async function listenOnLoopback(port = 0): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK, () => resolve());
  });
  return server;
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("resolveCompressionHome", () => {
  const instanceRoot = path.join(os.tmpdir(), "instance-root");

  it("places the home under companies/<companyId>/context-compression", () => {
    expect(resolveCompressionHome(instanceRoot, "company-1")).toBe(
      path.join(instanceRoot, "companies", "company-1", "context-compression"),
    );
  });

  it("gives two companies different homes", () => {
    expect(resolveCompressionHome(instanceRoot, "company-1")).not.toBe(
      resolveCompressionHome(instanceRoot, "company-2"),
    );
  });

  it("accepts a uuid company id", () => {
    const companyId = "3f2b8c1e-9d4a-4e6b-8a1f-0c5d7e9b2a14";
    expect(resolveCompressionHome(instanceRoot, companyId)).toContain(companyId);
  });

  it.each([
    ["a forward slash", "company/one"],
    ["a backslash", "company\\one"],
    ["a parent traversal", ".."],
    ["a traversal prefix", "../other"],
    ["a current directory", "."],
    ["an absolute path", "/etc/passwd"],
    ["an empty string", ""],
    ["whitespace", "  "],
    ["a null byte", "company\0one"],
  ])("rejects a companyId containing %s", (_label, companyId) => {
    expect(() => resolveCompressionHome(instanceRoot, companyId)).toThrow(/companyId/);
  });
});

describe("acquireCompressionPort", () => {
  let sandbox: string;
  let home: string;
  let portFile: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), "company-home-"));
    home = resolveCompressionHome(sandbox, "company-1");
    portFile = path.join(home, "port.json");
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("allocates a loopback port and persists port.json", async () => {
    const port = await acquireCompressionPort(home);

    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
    expect(JSON.parse(await readFile(portFile, "utf8"))).toEqual({ port });

    const server = await listenOnLoopback(port);
    await closeServer(server);
  });

  it.skipIf(process.platform === "win32")("persists port.json with mode 0600 in a 0700 home", async () => {
    await acquireCompressionPort(home);

    expect((await stat(portFile)).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it("returns the same port on a second call when it is free", async () => {
    const first = await acquireCompressionPort(home);
    const second = await acquireCompressionPort(home);

    expect(second).toBe(first);
  });

  it("allocates and persists a new port when the stored one is not free", async () => {
    const first = await acquireCompressionPort(home);

    const second = await acquireCompressionPort(home, { isPortFree: async (port) => port !== first });

    expect(second).not.toBe(first);
    expect(JSON.parse(await readFile(portFile, "utf8"))).toEqual({ port: second });
  });

  it("allocates a new port when the stored one is held by a real listener", async () => {
    const holder = await listenOnLoopback();
    try {
      const heldPort = (holder.address() as net.AddressInfo).port;
      await acquireCompressionPort(home);
      await writeFile(portFile, JSON.stringify({ port: heldPort }));

      const port = await acquireCompressionPort(home);

      expect(port).not.toBe(heldPort);
      expect(JSON.parse(await readFile(portFile, "utf8"))).toEqual({ port });
    } finally {
      await closeServer(holder);
    }
  });

  it.each([
    ["corrupt json", "{not json"],
    ["a non-numeric port", JSON.stringify({ port: "abc" })],
    ["a string port", JSON.stringify({ port: "8080" })],
    ["a fractional port", JSON.stringify({ port: 80.5 })],
    ["a zero port", JSON.stringify({ port: 0 })],
    ["a negative port", JSON.stringify({ port: -1 })],
    ["a port above 65535", JSON.stringify({ port: 70000 })],
    ["a missing port", JSON.stringify({})],
    ["a null document", "null"],
  ])("replaces port.json holding %s with a fresh valid port", async (_label, contents) => {
    await acquireCompressionPort(home);
    await writeFile(portFile, contents);

    const port = await acquireCompressionPort(home);

    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
    expect(JSON.parse(await readFile(portFile, "utf8"))).toEqual({ port });
  });

  it("gives concurrent callers on the same home the same port", async () => {
    const ports = await Promise.all(Array.from({ length: 8 }, () => acquireCompressionPort(home)));

    expect(new Set(ports).size).toBe(1);
    expect(JSON.parse(await readFile(portFile, "utf8"))).toEqual({ port: ports[0] });
  });

  it("gives different companies independent ports files", async () => {
    const otherHome = resolveCompressionHome(sandbox, "company-2");

    const [portOne, portTwo] = await Promise.all([acquireCompressionPort(home), acquireCompressionPort(otherHome)]);

    expect(JSON.parse(await readFile(portFile, "utf8"))).toEqual({ port: portOne });
    expect(JSON.parse(await readFile(path.join(otherHome, "port.json"), "utf8"))).toEqual({ port: portTwo });
  });
});
