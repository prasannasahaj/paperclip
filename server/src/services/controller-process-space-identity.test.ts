import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ read: vi.fn(), link: vi.fn(), sysctl: vi.fn(), selfBirth: vi.fn() }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(),
  readFileSync: state.read, readlinkSync: state.link }));
const hostnameValue = vi.hoisted(() => ({ current: "same-host.local" }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), hostname: () => hostnameValue.current }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFileSync: state.sysctl }));
vi.mock("./hot-restart.js", () => ({ readProcessStartedAt: state.selfBirth }));

const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const firstBoot = "00000000-0000-4000-8000-000000000001";
const secondBoot = "00000000-0000-4000-8000-000000000002";
function legacyHashFor(hostname: string, bootSession: string) {
  return createHash("sha256").update([hostname, bootSession].join("\0")).digest("hex").slice(0, 32);
}
function platform(value: string) { Object.defineProperty(process, "platform", { ...descriptor, value }); }
async function fresh() { vi.resetModules(); return import("./controller-process-identity.js"); }

beforeEach(() => {
  vi.resetAllMocks();
  hostnameValue.current = "same-host.local";
  state.read.mockReturnValue(firstBoot + "\n"); state.link.mockReturnValue("pid:[42]");
  state.sysctl.mockReturnValue(firstBoot.toUpperCase() + "\n");
  state.selfBirth.mockResolvedValue("2026-11-07T00:00:00.000Z");
});
afterEach(() => { Object.defineProperty(process, "platform", descriptor); vi.restoreAllMocks(); });

describe("controller process-space identity", () => {
  it("keeps Linux boot and PID-namespace isolation without launching a command", async () => {
    platform("linux");
    const original = await (await fresh()).currentControllerProcess();
    expect(original.hostHash).toMatch(/^[0-9a-f]{32}$/);
    expect(state.read).toHaveBeenCalledWith("/proc/sys/kernel/random/boot_id", "utf8");
    expect(state.link).toHaveBeenCalledWith("/proc/self/ns/pid");
    expect(state.sysctl).not.toHaveBeenCalled();
    state.link.mockReturnValue("pid:[43]");
    expect((await (await fresh()).currentControllerProcess()).hostHash).not.toBe(original.hostHash);
    state.link.mockReturnValue("pid:[42]"); state.read.mockReturnValue(secondBoot);
    expect((await (await fresh()).currentControllerProcess()).hostHash).not.toBe(original.hostHash);
  });

  it("uses Darwin kernel boot UUID once per module, never a rounded clock identity", async () => {
    platform("darwin");
    const owner = await fresh();
    const first = await owner.currentControllerProcess();
    expect(first.hostHash).toMatch(/^[0-9a-f]{32}$/);
    expect(state.sysctl).toHaveBeenCalledExactlyOnceWith("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"],
      { encoding: "utf8", timeout: 1_500, maxBuffer: 4_096, windowsHide: true });
    expect(state.read).not.toHaveBeenCalled(); expect(state.link).not.toHaveBeenCalled();
    state.sysctl.mockReturnValue(secondBoot);
    expect((await owner.currentControllerProcess()).hostHash).toBe(first.hostHash);
    expect(state.sysctl).toHaveBeenCalledTimes(1);
    expect((await (await fresh()).currentControllerProcess()).hostHash).not.toBe(first.hostHash);
    expect(state.sysctl).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(first)).not.toContain(firstBoot);
    // Old weak/foreign receipts retain their original deadline: no local probe.
    expect(owner.sameProcessSpace("old-rounded-clock-hash")).toBe(false);
    expect(owner.sameProcessSpace(first.hostHash)).toBe(true);
  });

  it("keeps the Darwin identity when the network changes the hostname", async () => {
    platform("darwin");
    const before = (await (await fresh()).currentControllerProcess()).hostHash;
    hostnameValue.current = "same-host.communityfibre.co.uk";
    expect((await (await fresh()).currentControllerProcess()).hostHash).toBe(before);
  });

  it("accepts a Darwin receipt saved by the previous release under the mDNS or bare hostname", async () => {
    platform("darwin");
    hostnameValue.current = "same-host.communityfibre.co.uk";
    const owner = await fresh();
    for (const legacyHostname of ["same-host.local", "same-host", "same-host.communityfibre.co.uk"]) {
      expect(owner.sameProcessSpace(legacyHashFor(legacyHostname, firstBoot))).toBe(true);
    }
    expect(owner.canonicalProcessSpace(legacyHashFor("same-host.local", firstBoot))).toBe(owner.currentProcessSpaceHash());
  });

  it("refuses a Darwin receipt under an unrelated hostname or another boot", async () => {
    platform("darwin");
    const owner = await fresh();
    expect(owner.sameProcessSpace(legacyHashFor("other-host.local", firstBoot))).toBe(false);
    expect(owner.sameProcessSpace(legacyHashFor("same-host.local", secondBoot))).toBe(false);
    expect(owner.canonicalProcessSpace(legacyHashFor("other-host.local", firstBoot))).toBe(legacyHashFor("other-host.local", firstBoot));
  });

  it("judges a legacy-alias controller with a dead PID as exited", async () => {
    platform("darwin");
    const owner = await fresh();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    expect(await owner.controllerProcessExited({ bootId: "old", pid: 2_000_000_001,
      hostHash: legacyHashFor("same-host.local", firstBoot), processStartedAt: null })).toBe(true);
    expect(kill).toHaveBeenCalledWith(2_000_000_001, 0);
  });

  it("never treats an unreadable Darwin identity as matching any receipt", async () => {
    platform("darwin");
    state.sysctl.mockImplementation(() => { throw new Error("sysctl unavailable"); });
    const owner = await fresh();
    expect(owner.sameProcessSpace("unknown")).toBe(false);
    expect(owner.canonicalProcessSpace("unknown")).toBe("unknown");
  });

  it.each(["unreadable", "malformed", "unsupported"] as const)("fails closed without an owner PID probe for %s identity", async mode => {
    platform(mode === "unsupported" ? "win32" : "darwin");
    if (mode === "unreadable") state.sysctl.mockImplementation(() => { throw new Error("sysctl unavailable"); });
    if (mode === "malformed") state.sysctl.mockReturnValue("not-a-kernel-uuid");
    const owner = await fresh();
    expect((await owner.currentControllerProcess()).hostHash).toBe("unknown");
    expect(owner.sameProcessSpace("unknown")).toBe(false);
    if (mode === "unsupported") expect(state.sysctl).not.toHaveBeenCalled();
  });
});
