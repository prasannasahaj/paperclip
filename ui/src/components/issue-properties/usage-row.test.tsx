// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ getCostSummary: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: { getCostSummary: api.getCostSummary } }));
import { ApiError } from "@/api/api-error";
import { IssueUsageRow } from "./usage-row";

async function settle() {
  for (let i = 0; i < 8; i++) { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {}); }
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  flushSync(() => root.unmount());
  client.clear();
  document.body.innerHTML = "";
});

function render() {
  flushSync(() => root.render(
    <QueryClientProvider client={client}>
      <IssueUsageRow issueId="issue-1" hasActiveRun={false} />
    </QueryClientProvider>,
  ));
}

const summary = {
  issueId: "issue-1", issueCount: 2, includeDescendants: true, costCents: 0,
  inputTokens: 3_100, cachedInputTokens: 4_000, outputTokens: 1_500, runCount: 3, runtimeMs: 125_000,
  byAgent: [
    { agentId: "a", agentName: "Builder", costCents: 0, inputTokens: 3_000, cachedInputTokens: 4_000, outputTokens: 1_000 },
    { agentId: "b", agentName: "Reviewer", costCents: 0, inputTokens: 100, cachedInputTokens: 0, outputTokens: 500 },
  ],
};

describe("IssueUsageRow", () => {
  it("stays hidden before the task has any run", async () => {
    api.getCostSummary.mockResolvedValue({ ...summary, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, runCount: 0, byAgent: [] });
    render(); await settle();
    expect(container.textContent).toBe("");
  });

  it("shows the task total and each agent's share", async () => {
    api.getCostSummary.mockResolvedValue(summary);
    render(); await settle();
    expect(container.textContent).toContain("8.6k tokens · 3 runs · 2m 5s");
    expect(container.textContent).toContain("Builder");
    expect(container.textContent).toContain("8.0k tokens");
    expect(container.textContent).toContain("Reviewer");
    expect(container.textContent).toContain("600 tokens");
  });

  it("shows a failed first load with a retry", async () => {
    api.getCostSummary.mockRejectedValueOnce(new ApiError("Internal error", 500, { error: "internal" })).mockResolvedValue(summary);
    render(); await settle();
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Retry"));
    expect(retry).toBeTruthy();
    retry!.click(); await settle();
    expect(container.textContent).toContain("3 runs");
  });
});
