import { ChildProcess, execFileSync } from "node:child_process";
import { channel } from "node:diagnostics_channel";

// Node publishes the real ChildProcess before its spawn event. ACP's spawn
// callback only exposes a PID, so correlate it here while retaining the handle
// for all later control. Never resolve a numeric PID again when stopping it.
// https://nodejs.org/api/diagnostics_channel.html#event-child_process
const children = new Map<number, ChildProcess>();
channel("child_process").subscribe((message) => {
  const child = (message as { process?: unknown }).process;
  if (!(child instanceof ChildProcess)) return;
  child.once("spawn", () => {
    if (child.pid) children.set(child.pid, child);
  });
  const remove = () => {
    if (child.pid && children.get(child.pid) === child) children.delete(child.pid);
  };
  child.once("exit", remove);
  child.once("close", remove);
});

export function captureLocalProcess(pid: number): ChildProcess | undefined {
  return children.get(pid);
}

export function capturedProcessExited(child: Pick<ChildProcess, "exitCode" | "signalCode"> | undefined): boolean {
  return Boolean(child && (child.exitCode !== null || child.signalCode !== null));
}

export interface ProcessTableRow {
  pid: number;
  ppid: number;
}

export function descendantPids(rootPid: number, table: readonly ProcessTableRow[]): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const row of table) {
    const siblings = childrenByParent.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else childrenByParent.set(row.ppid, [row.pid]);
  }
  const visited = new Set<number>([rootPid]);
  const deepestFirst: number[] = [];
  const visit = (pid: number) => {
    for (const childPid of childrenByParent.get(pid) ?? []) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      visit(childPid);
      if (childPid > 1 && childPid !== process.pid) deepestFirst.push(childPid);
    }
  };
  visit(rootPid);
  return deepestFirst;
}

export function readProcessTable(): ProcessTableRow[] {
  const listing = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return listing
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid]) => Number.isInteger(pid) && Number.isInteger(ppid))
    .map(([pid, ppid]) => ({ pid, ppid }));
}

function signalPid(pid: number): void {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

export interface ProcessTreeKillDependencies {
  readProcessTable: () => ProcessTableRow[];
  killPid: (pid: number) => void;
}

export function killCapturedLocalProcessTree(
  child: (Pick<ChildProcess, "exitCode" | "signalCode" | "kill"> & { pid?: number }) | undefined,
  dependencies: ProcessTreeKillDependencies = { readProcessTable, killPid: signalPid },
): boolean {
  if (!child || capturedProcessExited(child)) return false;
  if (child.pid && process.platform !== "win32") {
    try {
      for (const pid of descendantPids(child.pid, dependencies.readProcessTable())) dependencies.killPid(pid);
    } catch {
      return killCapturedLocalProcess(child);
    }
  }
  return killCapturedLocalProcess(child);
}

export function killCapturedLocalProcess(child: Pick<ChildProcess, "exitCode" | "signalCode" | "kill"> | undefined): boolean {
  if (!child || capturedProcessExited(child)) return false;
  try { return child.kill("SIGKILL"); } catch { return false; }
}
