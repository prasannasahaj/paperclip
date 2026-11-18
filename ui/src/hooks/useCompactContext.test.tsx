// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getContextUsage: vi.fn(), compactContext: vi.fn() }));
const toast = vi.hoisted(() => ({ pushToast: vi.fn() }));
vi.mock("@/api/issues", () => ({
  issuesApi: { getContextUsage: api.getContextUsage, compactContext: api.compactContext },
}));
vi.mock("@/context/ToastContext", () => ({ useOptionalToastActions: () => toast }));

import { useCompactContext } from "./useCompactContext";

type CompactContext = ReturnType<typeof useCompactContext>;

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let latest: CompactContext;

function Probe({ issueId }: { issueId: string | null }) {
  latest = useCompactContext(issueId, "agent-1");
  return null;
}

async function render(issueId: string | null = "issue-1") {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe issueId={issueId} />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function reading(compaction: Record<string, unknown>) {
  return {
    runId: "run-1",
    agentId: "agent-1",
    sessionId: "session-1",
    usedTokens: 26_672,
    windowTokens: 258_400,
    observedAt: new Date().toISOString(),
    totals: null,
    costUsd: null,
    compactions: 0,
    compaction,
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  document.body.innerHTML = "";
});

describe("useCompactContext", () => {
  it("is available and requests a compaction of the issue", async () => {
    api.getContextUsage.mockResolvedValue(reading({ status: "available", reasonCode: null, reason: null }));
    api.compactContext.mockResolvedValue({ requestId: "request-1", runId: "run-2" });
    await render();
    expect(latest.state?.status).toBe("available");
    await act(async () => {
      await latest.compact();
    });
    expect(api.compactContext).toHaveBeenCalledTimes(1);
    expect(api.compactContext).toHaveBeenCalledWith("issue-1");
  });

  it("carries the server's reason when compaction is unavailable", async () => {
    api.getContextUsage.mockResolvedValue(
      reading({
        status: "unavailable",
        reasonCode: "agent_busy",
        reason: "Available when the agent finishes its current run.",
      }),
    );
    await render();
    expect(latest.state).toEqual({
      status: "unavailable",
      reason: "Available when the agent finishes its current run.",
    });
  });

  it("is pending while a compaction run is in flight", async () => {
    api.getContextUsage.mockResolvedValue(
      reading({ status: "pending", reasonCode: null, reason: null, runId: "run-2" }),
    );
    await render();
    expect(latest.state).toEqual({ status: "pending" });
  });

  it("toasts and resolves when the compaction request is rejected", async () => {
    api.getContextUsage.mockResolvedValue(reading({ status: "available", reasonCode: null, reason: null }));
    api.compactContext.mockRejectedValue(new Error("Task execution is disabled."));
    await render();
    await act(async () => {
      await latest.compact();
    });
    expect(toast.pushToast).toHaveBeenCalledWith({
      title: "Could not compact the context",
      body: "Task execution is disabled.",
      tone: "error",
    });
  });

  it("does nothing without an issue", async () => {
    await render(null);
    expect(latest.state).toBeNull();
    await act(async () => {
      await latest.compact();
    });
    expect(api.getContextUsage).not.toHaveBeenCalled();
    expect(api.compactContext).not.toHaveBeenCalled();
  });
});
