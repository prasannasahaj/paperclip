import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import {
  captureLocalProcess,
  capturedProcessExited,
  descendantPids,
  killCapturedLocalProcess,
  killCapturedLocalProcessTree,
} from "./local-process-control.js";

const PROCESS_TABLE = [
  { pid: 10, ppid: 1 },
  { pid: 11, ppid: 10 },
  { pid: 12, ppid: 10 },
  { pid: 13, ppid: 11 },
  { pid: 99, ppid: 1 },
];

it("lists only the descendants of the root, deepest first", () => {
  expect(descendantPids(10, PROCESS_TABLE)).toEqual([13, 11, 12]);
});

it("returns nothing for a root with no children", () => {
  expect(descendantPids(99, PROCESS_TABLE)).toEqual([]);
});

it("survives a cyclic process table without looping", () => {
  const cyclic = [{ pid: 20, ppid: 21 }, { pid: 21, ppid: 20 }];
  expect(descendantPids(20, cyclic)).toEqual([21]);
});

it("never lists init or the current process as a descendant", () => {
  const table = [{ pid: 1, ppid: 10 }, { pid: process.pid, ppid: 10 }, { pid: 11, ppid: 10 }];
  expect(descendantPids(10, table)).toEqual([11]);
});

it("does not signal anything when the captured child already exited", () => {
  const exited = { pid: 10, exitCode: 0, signalCode: null, kill: vi.fn(() => true) };
  const killPid = vi.fn();
  expect(killCapturedLocalProcessTree(exited, { readProcessTable: () => PROCESS_TABLE, killPid })).toBe(false);
  expect(killPid).not.toHaveBeenCalled();
  expect(exited.kill).not.toHaveBeenCalled();
});

it("kills descendants before the root and reports success", () => {
  const order: string[] = [];
  const live = { pid: 10, exitCode: null, signalCode: null, kill: vi.fn(() => { order.push("root"); return true; }) };
  const killed = killCapturedLocalProcessTree(live, {
    readProcessTable: () => PROCESS_TABLE,
    killPid: (pid) => order.push(String(pid)),
  });
  expect(killed).toBe(true);
  expect(order).toEqual(["13", "11", "12", "root"]);
});

it("still kills the root when the process table cannot be read", () => {
  const live = { pid: 10, exitCode: null, signalCode: null, kill: vi.fn(() => true) };
  const killPid = vi.fn();
  const killed = killCapturedLocalProcessTree(live, {
    readProcessTable: () => { throw new Error("ps unavailable"); },
    killPid,
  });
  expect(killed).toBe(true);
  expect(killPid).not.toHaveBeenCalled();
  expect(live.kill).toHaveBeenCalledWith("SIGKILL");
});

function processIsGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch { return true; }
}

it("removes the tool processes a stopped run leaves behind", async () => {
  const grandchildScript = "const c=require('node:child_process').spawn('sleep',['60'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)";
  const child = spawn(process.execPath, ["-e", grandchildScript], { stdio: ["ignore", "pipe", "ignore"] });
  let grandchildPid = 0;
  try {
    await once(child, "spawn");
    const [chunk] = await once(child.stdout!, "data");
    grandchildPid = Number(String(chunk).trim());
    expect(processIsGone(grandchildPid)).toBe(false);
    const exited = once(child, "exit");
    expect(killCapturedLocalProcessTree(captureLocalProcess(child.pid!))).toBe(true);
    await exited;
    await vi.waitFor(() => expect(processIsGone(grandchildPid)).toBe(true));
  } finally {
    if (grandchildPid && !processIsGone(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
    if (!capturedProcessExited(child)) child.kill("SIGKILL");
  }
});

it("captures and terminates the actual spawned child on the current platform", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await once(child, "spawn");
    const captured = captureLocalProcess(child.pid!);
    expect(captured).toBe(child);
    expect(capturedProcessExited(captured)).toBe(false);
    const exited = once(child, "exit");
    expect(killCapturedLocalProcess(captured)).toBe(true);
    await exited;
    expect(capturedProcessExited(captured)).toBe(true);
    expect(captureLocalProcess(child.pid!)).toBeUndefined();
  } finally {
    if (!capturedProcessExited(child)) child.kill("SIGKILL");
  }
});

it("never signals an exited child even if another process has reused its PID", () => {
  const original = { pid: 123, exitCode: 0, signalCode: null, kill: vi.fn(() => true) };
  const replacement = { pid: 123, exitCode: null, signalCode: null, kill: vi.fn(() => true) };
  expect(killCapturedLocalProcess(original)).toBe(false);
  expect(original.kill).not.toHaveBeenCalled();
  expect(replacement.kill).not.toHaveBeenCalled();
});

it("fails closed when the spawned handle was not captured", () => {
  expect(killCapturedLocalProcess(undefined)).toBe(false);
  expect(capturedProcessExited(undefined)).toBe(false);
});

it("reports an unsuccessful signal without throwing", () => {
  expect(killCapturedLocalProcess({ exitCode: null, signalCode: null, kill: () => false })).toBe(false);
  expect(killCapturedLocalProcess({ exitCode: null, signalCode: null, kill: () => { throw new Error("gone"); } })).toBe(false);
});
