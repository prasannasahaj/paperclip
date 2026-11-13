// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskChatItem, TaskChatToolItem } from "./task-chat-model";
import { TaskChatStatusLine } from "./TaskChatStatusLine";

const START = Date.UTC(2026, 10, 13, 4, 0, 0);

function runningTool(target: string): TaskChatToolItem {
  return { id: "t1", kind: "tool", name: "Bash", status: "in_progress", target };
}

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

  const render = (props: {
    runState: string;
    items?: TaskChatItem[];
    usageJson?: Record<string, unknown> | null;
  }) => {
    act(() => {
      root.render(
        <TaskChatStatusLine
          runState={props.runState}
          items={props.items ?? []}
          startedAtMs={START}
          usageJson={props.usageJson}
        />,
      );
    });
  };

  const line = () => container.querySelector('[data-testid="task-chat-status-line"]');

  it("joins state, current activity and elapsed time with separators", () => {
    render({ runState: "running", items: [runningTool("git push origin fix")] });
    expect(line()?.textContent).toBe("Running · Bash git push origin fix · 5s");
  });

  it("advances the elapsed time every second", () => {
    render({ runState: "running" });
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(line()?.textContent).toBe("Running · 8s");
  });

  it("renders nothing for a finished run", () => {
    render({ runState: "succeeded" });
    expect(line()).toBeNull();
  });

  it("stops ticking after it unmounts", () => {
    render({ runState: "running" });
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});
