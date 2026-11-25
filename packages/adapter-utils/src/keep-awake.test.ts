import { describe, expect, it, vi } from "vitest";
import {
  KEEP_AWAKE_MAX_SECONDS,
  preventIdleSleepWhileProcessAlive,
} from "./keep-awake.js";

function fakeAssertion() {
  return { on: vi.fn(), unref: vi.fn() };
}

describe("preventIdleSleepWhileProcessAlive", () => {
  it("holds an idle-sleep assertion tied to the agent pid, capped at 30 minutes, on macOS", () => {
    const assertion = fakeAssertion();
    const spawnSleepAssertion = vi.fn(() => assertion);

    preventIdleSleepWhileProcessAlive(4242, { platform: "darwin", spawnSleepAssertion });

    expect(spawnSleepAssertion).toHaveBeenCalledWith(
      "caffeinate",
      ["-i", "-t", "1800", "-w", "4242"],
      { stdio: "ignore" },
    );
    expect(assertion.unref).toHaveBeenCalled();
  });

  it("never holds the assertion longer than 30 minutes", () => {
    expect(KEEP_AWAKE_MAX_SECONDS).toBe(30 * 60);
  });

  it.each(["linux", "win32"] as const)("does nothing on %s", (platform) => {
    const spawnSleepAssertion = vi.fn(() => fakeAssertion());

    preventIdleSleepWhileProcessAlive(4242, { platform, spawnSleepAssertion });

    expect(spawnSleepAssertion).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN])("ignores invalid pid %s", (pid) => {
    const spawnSleepAssertion = vi.fn(() => fakeAssertion());

    preventIdleSleepWhileProcessAlive(pid, { platform: "darwin", spawnSleepAssertion });

    expect(spawnSleepAssertion).not.toHaveBeenCalled();
  });

  it("swallows a missing caffeinate binary reported asynchronously", () => {
    const assertion = fakeAssertion();
    const spawnSleepAssertion = vi.fn(() => assertion);

    preventIdleSleepWhileProcessAlive(4242, { platform: "darwin", spawnSleepAssertion });

    const [event, onError] = assertion.on.mock.calls[0];
    expect(event).toBe("error");
    expect(() => onError(new Error("spawn caffeinate ENOENT"))).not.toThrow();
  });

  it("swallows a synchronous spawn failure", () => {
    const spawnSleepAssertion = vi.fn(() => {
      throw new Error("spawn failed");
    });

    expect(() =>
      preventIdleSleepWhileProcessAlive(4242, { platform: "darwin", spawnSleepAssertion }),
    ).not.toThrow();
  });
});
