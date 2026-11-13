// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskChatItem, TaskChatToolItem } from "./task-chat-model";
import { TaskChatStatusLine } from "./TaskChatStatusLine";
import type { TaskStatusLineInput } from "./task-status-line";

const START = Date.UTC(2026, 10, 13, 4, 0, 0);

function runningTool(target: string): TaskChatToolItem {
  return { id: "t1", kind: "tool", name: "Bash", status: "in_progress", target };
}

type SessionFacts = Pick<TaskStatusLineInput, "model" | "context" | "lastReplyAtMs" | "rateLimit" | "costUsd">;

describe("TaskChatStatusLine", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START + 5_000);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const render = (props: { runState: string; items?: TaskChatItem[]; facts?: SessionFacts }) => {
    act(() => {
      root.render(
        <TaskChatStatusLine
          runState={props.runState}
          items={props.items ?? []}
          startedAtMs={START}
          facts={props.facts ?? {}}
        />,
      );
    });
  };

  const line = () => container.querySelector('[data-testid="task-chat-status-line"]');

  it("joins the live segments and session facts with separators", () => {
    render({
      runState: "running",
      items: [runningTool("git push origin fix")],
      facts: { model: "claude-sonnet-5-5" },
    });
    expect(line()?.textContent).toBe("Running │ Bash git push origin fix │ sonnet 5.5 │ 5s");
  });

  it("advances the elapsed time every second while running", () => {
    render({ runState: "running" });
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(line()?.textContent).toBe("Running │ 8s");
  });

  it("renders nothing for a finished run with no session facts", () => {
    render({ runState: "succeeded" });
    expect(line()).toBeNull();
  });

  it("keeps showing session facts after the run finished", () => {
    render({ runState: "succeeded", facts: { model: "claude-sonnet-5-5", costUsd: 0.42 } });
    expect(line()?.textContent).toBe("sonnet 5.5 │ $0.42");
  });

  it("marks a nearly full context window in the alert tone", () => {
    render({ runState: "succeeded", facts: { context: { usedTokens: 900, windowTokens: 1000 } } });
    const context = container.querySelector('[data-segment="context"]');
    expect(context?.textContent).toBe("ctx 10% COMPACT");
    expect(context?.className).toContain("text-destructive");
  });

  it("stops ticking after it unmounts", () => {
    render({ runState: "running" });
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});
