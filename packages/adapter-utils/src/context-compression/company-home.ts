import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const LOOPBACK_HOST = "127.0.0.1";
const PORT_FILE_NAME = "port.json";
const HOME_DIRECTORY_MODE = 0o700;
const PORT_FILE_MODE = 0o600;
const MIN_PORT = 1;
const MAX_PORT = 65535;
const SAFE_COMPANY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface AcquireCompressionPortOptions {
  isPortFree?: (port: number) => Promise<boolean>;
}

export function resolveCompressionHome(instanceRoot: string, companyId: string): string {
  if (!SAFE_COMPANY_ID.test(companyId)) {
    throw new Error(`Invalid companyId for context compression home: ${JSON.stringify(companyId)}`);
  }
  return path.join(instanceRoot, "companies", companyId, "context-compression");
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

function listenOnLoopback(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function isLoopbackPortFree(port: number): Promise<boolean> {
  try {
    await closeServer(await listenOnLoopback(port));
    return true;
  } catch {
    return false;
  }
}

async function allocateLoopbackPort(): Promise<number> {
  const server = await listenOnLoopback(0);
  const { port } = server.address() as net.AddressInfo;
  await closeServer(server);
  return port;
}

async function readPersistedPort(portFile: string): Promise<number | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(portFile, "utf8"));
    const port = (parsed as { port?: unknown } | null)?.port;
    return isValidPort(port) ? port : null;
  } catch {
    return null;
  }
}

async function persistPort(portFile: string, port: number): Promise<void> {
  const pendingFile = `${portFile}.${process.pid}.tmp`;
  await writeFile(pendingFile, `${JSON.stringify({ port })}\n`, { mode: PORT_FILE_MODE });
  await chmod(pendingFile, PORT_FILE_MODE);
  await rename(pendingFile, portFile);
}

async function ensureHomeDirectory(home: string): Promise<void> {
  await mkdir(path.dirname(home), { recursive: true });
  await mkdir(home, { recursive: true, mode: HOME_DIRECTORY_MODE });
  await chmod(home, HOME_DIRECTORY_MODE);
}

async function acquirePortOnce(home: string, isPortFree: (port: number) => Promise<boolean>): Promise<number> {
  await ensureHomeDirectory(home);
  const portFile = path.join(home, PORT_FILE_NAME);
  const persistedPort = await readPersistedPort(portFile);
  if (persistedPort !== null && (await isPortFree(persistedPort))) return persistedPort;
  const port = await allocateLoopbackPort();
  await persistPort(portFile, port);
  return port;
}

const pendingAcquisitionByHome = new Map<string, Promise<unknown>>();

export function acquireCompressionPort(
  home: string,
  options: AcquireCompressionPortOptions = {},
): Promise<number> {
  const isPortFree = options.isPortFree ?? isLoopbackPortFree;
  const previous = pendingAcquisitionByHome.get(home) ?? Promise.resolve();
  const acquisition = previous.catch(() => undefined).then(() => acquirePortOnce(home, isPortFree));
  pendingAcquisitionByHome.set(home, acquisition);
  const release = () => {
    if (pendingAcquisitionByHome.get(home) === acquisition) pendingAcquisitionByHome.delete(home);
  };
  acquisition.then(release, release);
  return acquisition;
}
