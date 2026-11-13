import { describe, expect, it } from "vitest";
import type { TaskChatItem, TaskChatToolItem } from "./task-chat-model";
import {
  buildTaskStatusLine,
  currentActivityLabel,
  formatStatusElapsed,
  shortModelName,
  type TaskStatusLineInput,
} from "./task-status-line";

const NOW = 1_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function tool(overrides: Partial<TaskChatToolItem>): TaskChatToolItem {
  return { id: "t1", kind: "tool", name: "Bash", status: "in_progress", ...overrides };
}

function build(overrides: Partial<TaskStatusLineInput>) {
  return buildTaskStatusLine({ runState: "none", startedAtMs: null, nowMs: NOW, ...overrides });
}

const texts = (input: Partial<TaskStatusLineInput>) => build(input).map((segment) => segment.text);
const segment = (input: Partial<TaskStatusLineInput>, id: string) =>
  build(input).find((candidate) => candidate.id === id);

describe("formatStatusElapsed", () => {
  it("reads minutes and seconds", () => {
    expect(formatStatusElapsed(8 * MINUTE + 28_000)).toBe("8m 28s");
  });

  it("reads seconds alone under a minute", () => {
    expect(formatStatusElapsed(42_000)).toBe("42s");
  });

  it("never goes negative", () => {
    expect(formatStatusElapsed(-5_000)).toBe("0s");
  });
});

describe("shortModelName", () => {
  it.each([
    ["claude-sonnet-5-5", "sonnet 5.5"],
    ["claude-opus-4-1-20250805", "opus 4.1"],
    ["claude-fable-5-2", "fable 5.2"],
    ["Claude Sonnet 5.5", "sonnet 5.5"],
    ["gpt-5.5", "gpt-5.5"],
    ["", ""],
  ])("shortens %j to %j", (raw, short) => {
    expect(shortModelName(raw)).toBe(short);
  });
});

describe("buildTaskStatusLine", () => {
  it("orders state, activity, model, context, cache, rate limit, cost and elapsed time", () => {
    expect(
      texts({
        runState: "running",
        activityLabel: "Bash git push",
        startedAtMs: NOW - (3 * MINUTE + 5_000),
        model: "claude-sonnet-5-5",
        context: { usedTokens: 380_000, windowTokens: 1_000_000 },
        lastReplyAtMs: NOW - 18 * MINUTE,
        rateLimit: { usedPercent: 35, resetsAtMs: NOW + 2 * HOUR + 5 * MINUTE },
        costUsd: 0.42,
      }),
    ).toEqual([
      "Running",
      "Bash git push",
      "sonnet 5.5",
      "ctx 62%",
      "cache 42m",
      "5h 35% ↻2h5m",
      "$0.42",
      "3m 5s",
    ]);
  });

  it("keeps the session facts but drops live-run segments once the run finished", () => {
    expect(
      texts({
        runState: "succeeded",
        startedAtMs: NOW - MINUTE,
        model: "claude-sonnet-5-5",
        costUsd: 1.5,
      }),
    ).toEqual(["sonnet 5.5", "$1.50"]);
  });

  it("stays quiet about state while queued so startup never reads as queued", () => {
    expect(texts({ runState: "queued", model: "claude-sonnet-5-5" })).toEqual(["sonnet 5.5"]);
  });

  it("returns nothing when there is no data", () => {
    expect(build({})).toEqual([]);
  });

  it.each([
    [90, "ctx 10% COMPACT", "alert"],
    [80, "ctx 20% COMPACT", "alert"],
    [65, "ctx 35%", "warn"],
    [20, "ctx 80%", "ok"],
  ])("reads %i%% used context as %s", (usedPercent, text, tone) => {
    const found = segment({ context: { usedTokens: usedPercent * 10, windowTokens: 1000 } }, "context");
    expect(found).toEqual({ id: "context", text, tone });
  });

  it("omits context when the window size is unknown", () => {
    expect(segment({ context: { usedTokens: 100, windowTokens: 0 } }, "context")).toBeUndefined();
  });

  it("counts the prompt cache down in hours and minutes", () => {
    expect(segment({ lastReplyAtMs: NOW - 5 * MINUTE }, "cache")?.text).toBe("cache 55m");
    expect(segment({ lastReplyAtMs: NOW }, "cache")?.text).toBe("cache 1h0m");
  });

  it("calls the cache cold after the time to live passes", () => {
    expect(segment({ lastReplyAtMs: NOW - 2 * HOUR }, "cache")).toEqual({
      id: "cache",
      text: "cache cold",
      tone: "warn",
    });
  });

  it("omits the cache segment when no reply time is known", () => {
    expect(segment({ lastReplyAtMs: null }, "cache")).toBeUndefined();
  });

  it.each([
    [85, "alert"],
    [55, "warn"],
    [10, "ok"],
  ])("tones a five-hour window at %i%% as %s", (usedPercent, tone) => {
    expect(segment({ rateLimit: { usedPercent, resetsAtMs: null } }, "rate")).toEqual({
      id: "rate",
      text: `5h ${usedPercent}%`,
      tone,
    });
  });

  it("drops the reset countdown once the window has rolled over", () => {
    expect(segment({ rateLimit: { usedPercent: 40, resetsAtMs: NOW - 1000 } }, "rate")?.text).toBe("5h 40%");
  });

  it("omits cost when none was reported", () => {
    expect(segment({ costUsd: null }, "cost")).toBeUndefined();
    expect(segment({ costUsd: 0 }, "cost")).toBeUndefined();
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
