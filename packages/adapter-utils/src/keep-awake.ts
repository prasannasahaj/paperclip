import { spawn, type ChildProcess } from "node:child_process";

type SpawnSleepAssertion = (
  command: string,
  args: string[],
  options: { stdio: "ignore" },
) => Pick<ChildProcess, "unref" | "on">;

export const KEEP_AWAKE_MAX_SECONDS = 30 * 60;

export interface KeepAwakeOptions {
  platform?: NodeJS.Platform;
  spawnSleepAssertion?: SpawnSleepAssertion;
}

export function preventIdleSleepWhileProcessAlive(
  pid: number,
  options: KeepAwakeOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return;
  if (!Number.isInteger(pid) || pid <= 0) return;
  const spawnSleepAssertion = options.spawnSleepAssertion ?? spawn;
  try {
    const assertion = spawnSleepAssertion("caffeinate", ["-i", "-t", String(KEEP_AWAKE_MAX_SECONDS), "-w", String(pid)], {
      stdio: "ignore",
    });
    assertion.on("error", () => undefined);
    assertion.unref();
  } catch {
    return;
  }
}
