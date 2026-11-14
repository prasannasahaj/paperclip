import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { CavemanBinaries } from "./binaries.js";
import { acquireCompressionPort, resolveCompressionHome } from "./company-home.js";
import type { ContextCompressionMode } from "./config.js";

export type CompressionProxyMode = Exclude<ContextCompressionMode, "off">;

export type ProxyAvailability =
  | { available: true; baseUrl: string; home: string; mode: CompressionProxyMode }
  | { available: false; reason: string };

export interface EnsureRunningInput {
  companyId: string;
  instanceRoot: string;
  mode: CompressionProxyMode;
  binaries: CavemanBinaries;
}

export interface CompressionSupervisor {
  ensureRunning(input: EnsureRunningInput): Promise<ProxyAvailability>;
  stopAll(): Promise<void>;
}

export interface CompressionSupervisorDeps {
  spawn?: typeof spawnChildProcess;
  waitForListen?: (port: number, timeoutMs: number) => Promise<boolean>;
}

interface RunningProxy {
  child: ChildProcess;
  port: number;
  home: string;
  mode: CompressionProxyMode;
  exited: boolean;
  spawnFailure: string | null;
  whenExited: Promise<void>;
}

type StartOutcome = { started: true; proxy: RunningProxy } | { started: false; reason: string };

const LOOPBACK_HOST = "127.0.0.1";
const PROXY_LOG_FILE_NAME = "proxy.log";
const PROXY_LOG_FILE_MODE = 0o600;
const STARTUP_LISTEN_TIMEOUT_MS = 5000;
const STARTUP_CONNECT_RETRY_DELAY_MS = 50;
const START_ATTEMPTS = 2;

function tryConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: LOOPBACK_HOST });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForLoopbackListen(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await tryConnect(port)) return true;
    if (Date.now() + STARTUP_CONNECT_RETRY_DELAY_MS >= deadline) return false;
    await delay(STARTUP_CONNECT_RETRY_DELAY_MS);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const PROXY_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

function buildProxyEnv(input: { home: string; port: number; mode: EnsureRunningInput["mode"] }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PROXY_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.CAVEMAN_HOME = input.home;
  env.CAVEMAN_LISTEN = `${LOOPBACK_HOST}:${input.port}`;
  env.CAVEMAN_MODE = input.mode === "record" ? "record" : "compress";
  if (input.mode === "on") env.CAVEMAN_RECOVERY = "mcp";
  env.DO_NOT_TRACK = "1";
  return env;
}

const liveChildren = new Set<ChildProcess>();
let exitHookRegistered = false;

function killQuietly(child: ChildProcess): void {
  try {
    child.kill();
  } catch {
    return;
  }
}

function registerExitHookOnce(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once("exit", () => {
    for (const child of liveChildren) killQuietly(child);
  });
}

function toBaseUrl(port: number): string {
  return `http://${LOOPBACK_HOST}:${port}`;
}

function toAvailability(proxy: RunningProxy): ProxyAvailability {
  return { available: true, baseUrl: toBaseUrl(proxy.port), home: proxy.home, mode: proxy.mode };
}

export function createCompressionSupervisor(deps: CompressionSupervisorDeps = {}): CompressionSupervisor {
  const spawnProcess = deps.spawn ?? spawnChildProcess;
  const waitForListen = deps.waitForListen ?? waitForLoopbackListen;
  const proxyByCompany = new Map<string, RunningProxy>();
  const startByCompany = new Map<string, Promise<ProxyAvailability>>();
  let shutdownGeneration = 0;

  function spawnProxy(input: EnsureRunningInput, home: string, port: number): RunningProxy {
    const logDescriptor = openSync(path.join(home, PROXY_LOG_FILE_NAME), "a", PROXY_LOG_FILE_MODE);
    let child: ChildProcess;
    try {
      child = spawnProcess(input.binaries.proxy, [], {
        env: buildProxyEnv({ home, port, mode: input.mode }),
        stdio: ["ignore", logDescriptor, logDescriptor],
        windowsHide: true,
      });
    } finally {
      closeSync(logDescriptor);
    }

    let markExited!: () => void;
    const proxy: RunningProxy = {
      child,
      port,
      home,
      mode: input.mode,
      exited: false,
      spawnFailure: null,
      whenExited: new Promise<void>((resolve) => {
        markExited = resolve;
      }),
    };
    const handleGone = () => {
      proxy.exited = true;
      liveChildren.delete(child);
      markExited();
    };
    child.once("exit", handleGone);
    child.on("error", (error) => {
      if (child.pid !== undefined) return;
      proxy.spawnFailure = describeError(error);
      handleGone();
    });

    registerExitHookOnce();
    liveChildren.add(child);
    proxyByCompany.set(input.companyId, proxy);
    return proxy;
  }

  function terminate(companyId: string, proxy: RunningProxy): void {
    if (!proxy.exited) killQuietly(proxy.child);
    if (proxyByCompany.get(companyId) === proxy) proxyByCompany.delete(companyId);
  }

  function describeStartupFailure(proxy: RunningProxy): string {
    if (proxy.spawnFailure) return `caveman-proxy failed to spawn: ${proxy.spawnFailure}`;
    if (proxy.exited) return "caveman-proxy exited before it started listening";
    return `caveman-proxy did not start listening on ${LOOPBACK_HOST}:${proxy.port} within ${STARTUP_LISTEN_TIMEOUT_MS}ms`;
  }

  async function attemptStart(input: EnsureRunningInput, home: string): Promise<StartOutcome> {
    const generation = shutdownGeneration;
    const port = await acquireCompressionPort(home);
    if (generation !== shutdownGeneration) return { started: false, reason: "context compression is shutting down" };

    const proxy = spawnProxy(input, home, port);
    const listening = await Promise.race([
      waitForListen(port, STARTUP_LISTEN_TIMEOUT_MS).catch(() => false),
      proxy.whenExited.then(() => false),
    ]);
    if (listening && !proxy.exited && generation === shutdownGeneration) return { started: true, proxy };

    const reason =
      generation === shutdownGeneration ? describeStartupFailure(proxy) : "context compression is shutting down";
    terminate(input.companyId, proxy);
    return { started: false, reason };
  }

  async function startProxy(input: EnsureRunningInput): Promise<ProxyAvailability> {
    try {
      const generation = shutdownGeneration;
      const home = resolveCompressionHome(input.instanceRoot, input.companyId);
      let outcome = await attemptStart(input, home);
      for (let attempt = 1; !outcome.started && attempt < START_ATTEMPTS && generation === shutdownGeneration; attempt += 1) {
        outcome = await attemptStart(input, home);
      }
      return outcome.started ? toAvailability(outcome.proxy) : { available: false, reason: outcome.reason };
    } catch (error) {
      return { available: false, reason: describeError(error) };
    }
  }

  return {
    async ensureRunning(input) {
      const pendingStart = startByCompany.get(input.companyId);
      if (pendingStart) return pendingStart;

      const running = proxyByCompany.get(input.companyId);
      if (running && !running.exited) return toAvailability(running);
      if (running) proxyByCompany.delete(input.companyId);

      const start = startProxy(input);
      startByCompany.set(input.companyId, start);
      const forget = () => {
        if (startByCompany.get(input.companyId) === start) startByCompany.delete(input.companyId);
      };
      start.then(forget, forget);
      return start;
    },

    async stopAll() {
      shutdownGeneration += 1;
      for (const [companyId, proxy] of [...proxyByCompany]) terminate(companyId, proxy);
      await Promise.allSettled([...startByCompany.values()]);
    },
  };
}

let sharedSupervisor: CompressionSupervisor | null = null;

export function getCompressionSupervisor(): CompressionSupervisor {
  sharedSupervisor ??= createCompressionSupervisor();
  return sharedSupervisor;
}
