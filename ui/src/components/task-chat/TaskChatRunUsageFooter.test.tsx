// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskChatRunUsageFooter } from "./TaskChatRunUsageFooter";

describe("TaskChatRunUsageFooter", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (usageJson: Record<string, unknown>) => {
    act(() => {
      root.render(<TaskChatRunUsageFooter usageJson={usageJson} />);
    });
  };

  it("shows tokens, cached tokens and cost on one line", () => {
    render({ inputTokens: 1200, outputTokens: 300, cachedInputTokens: 9000, costUsd: 0.424 });
    expect(container.querySelector("[data-testid=task-chat-run-usage-footer]")?.textContent).toBe(
      "↑1.2k ↓300 · 9.0k cached · $0.42",
    );
  });

  it("renders nothing when the run reported no usage", () => {
    render({});
    expect(container.firstChild).toBeNull();
  });
});
