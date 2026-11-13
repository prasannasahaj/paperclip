import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildPaperclipEnv, defaultAgentTestWorkerCount } from "./server-utils.js";

const agent = { id: "agent-1", companyId: "company-1" };
const WORKER_KEYS = ["VITEST_MAX_WORKERS", "PAPERCLIP_AGENT_TEST_WORKERS"] as const;

describe("defaultAgentTestWorkerCount", () => {
  it("uses a quarter of the cores", () => {
    expect(defaultAgentTestWorkerCount(15)).toBe(3);
  });

  it("never drops below one worker", () => {
    expect(defaultAgentTestWorkerCount(1)).toBe(1);
    expect(defaultAgentTestWorkerCount(3)).toBe(1);
  });
});

describe("buildPaperclipEnv test worker cap", () => {
  const savedHostValues = new Map(WORKER_KEYS.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const [key, value] of savedHostValues) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function clearWorkerSettings() {
    for (const key of WORKER_KEYS) delete process.env[key];
  }

  it("caps vitest workers by core count by default", () => {
    clearWorkerSettings();
    expect(buildPaperclipEnv(agent).VITEST_MAX_WORKERS).toBe(
      String(defaultAgentTestWorkerCount(os.availableParallelism())),
    );
  });

  it("uses PAPERCLIP_AGENT_TEST_WORKERS when the operator sets it", () => {
    clearWorkerSettings();
    process.env.PAPERCLIP_AGENT_TEST_WORKERS = "2";
    expect(buildPaperclipEnv(agent).VITEST_MAX_WORKERS).toBe("2");
  });

  it.each(["abc", "0", "-1", "1.5", ""])(
    "falls back to the core-count default when PAPERCLIP_AGENT_TEST_WORKERS is %j",
    (invalidChoice) => {
      clearWorkerSettings();
      process.env.PAPERCLIP_AGENT_TEST_WORKERS = invalidChoice;
      expect(buildPaperclipEnv(agent).VITEST_MAX_WORKERS).toBe(
        String(defaultAgentTestWorkerCount(os.availableParallelism())),
      );
    },
  );

  it("leaves a host-defined VITEST_MAX_WORKERS alone", () => {
    clearWorkerSettings();
    process.env.VITEST_MAX_WORKERS = "9";
    expect(buildPaperclipEnv(agent)).not.toHaveProperty("VITEST_MAX_WORKERS");
  });
});
