import { describe, expect, it } from "vitest";
import type { TaskChatItem, TaskChatToolItem } from "./task-chat-model";
import {
  buildTaskStatusLine,
  currentActivityLabel,
  formatStatusElapsed,
} from "./task-status-line";

const NOW = 1_000_000_000;

function tool(overrides: Partial<TaskChatToolItem>): TaskChatToolItem {
  return { id: "t1", kind: "tool", name: "Bash", status: "in_progress", ...overrides };
}

describe("formatStatusElapsed", () => {
  it("reads minutes and seconds", () => {
    expect(formatStatusElapsed(8 * 60_000 + 28_000)).toBe("8m 28s");
  });

  it("reads seconds alone under a minute", () => {
    expect(formatStatusElapsed(42_000)).toBe("42s");
  });

  it("never goes negative", () => {
    expect(formatStatusElapsed(-5_000)).toBe("0s");
  });
});

describe("buildTaskStatusLine", () => {
  it("shows state, activity and elapsed time for a running task", () => {
    const segments = buildTaskStatusLine({
      runState: "running",
      activityLabel: "git push origin tac136-fix",
      startedAtMs: NOW - (3 * 60_000 + 5_000),
      nowMs: NOW,
    });
    expect(segments).toEqual([
      { id: "state", text: "Running" },
      { id: "activity", text: "git push origin tac136-fix" },
      { id: "elapsed", text: "3m 5s" },
    ]);
  });

  it("formats usage with tokens and cost", () => {
    const segments = buildTaskStatusLine({
      runState: "running",
      startedAtMs: NOW - 1_000,
      nowMs: NOW,
      usageJson: { inputTokens: 12_000, outputTokens: 800, costUsd: 0.42 },
    });
    expect(segments.find((segment) => segment.id === "usage")?.text).toBe("↑12.0k ↓800 · $0.42");
  });

  it("stays quiet while a run is queued, since startup never reads as queued", () => {
    expect(buildTaskStatusLine({ runState: "queued", startedAtMs: null, nowMs: NOW })).toEqual([]);
  });

  it("returns nothing for a finished run", () => {
    expect(
      buildTaskStatusLine({ runState: "succeeded", startedAtMs: NOW - 5_000, nowMs: NOW }),
    ).toEqual([]);
  });

  it("omits usage when the run reports none", () => {
    const segments = buildTaskStatusLine({
      runState: "running",
      startedAtMs: NOW - 1_000,
      nowMs: NOW,
      usageJson: {},
    });
    expect(segments.some((segment) => segment.id === "usage")).toBe(false);
  });
});

describe("currentActivityLabel", () => {
  it("names the latest running tool with its target", () => {
    const items: TaskChatItem[] = [
      tool({ id: "a", status: "completed", target: "ls" }),
      tool({ id: "b", target: "git push origin tac136-fix" }),
    ];
    expect(currentActivityLabel(items)).toBe("Bash git push origin tac136-fix");
  });

  it("is undefined when no tool is running", () => {
    expect(currentActivityLabel([tool({ status: "completed" })])).toBeUndefined();
  });

  it("clips a very long target", () => {
    const label = currentActivityLabel([tool({ target: "x".repeat(300) })]);
    expect(label!.length).toBeLessThanOrEqual(80);
    expect(label!.endsWith("…")).toBe(true);
  });
});
