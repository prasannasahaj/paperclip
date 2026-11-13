// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ getMaturityScorecard: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: { getMaturityScorecard: api.getMaturityScorecard } }));
import { ApiError } from "@/api/api-error";
import { MaturityRow } from "./maturity-row";

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
      <MaturityRow issueId="issue-1" hasActiveRun={false} />
    </QueryClientProvider>,
  ));
}

const scorecard = {
  issueId: "issue-1", includeDescendants: true, truncated: false, runCount: 3, reworkRuns: 0,
  recheckAfterFailure: 0, environmentBlockedCount: 0, agentWaitShare: null,
  byKind: [{ kind: "test", commands: 4, failures: 2, firstPassRate: 0.5, medianMs: 38_000, slowestMs: 130_000 }],
  modelMix: [],
  findings: [{ code: "low_first_pass", message: "test rarely passes first time" }],
};

describe("MaturityRow", () => {
  it("renders nothing extra while loading", () => {
    api.getMaturityScorecard.mockReturnValue(new Promise(() => {}));
    render();
    expect(container.textContent).toBe("");
  });

  it("shows the findings and each check kind", async () => {
    api.getMaturityScorecard.mockResolvedValue(scorecard);
    render(); await settle();
    expect(container.textContent).toContain("test rarely passes first time");
    expect(container.textContent).toContain("test: 4 runs, 50% first pass, median 38s, slowest 2m 10s");
  });

  it("stays hidden before the task has any run", async () => {
    api.getMaturityScorecard.mockResolvedValue({ ...scorecard, runCount: 0, byKind: [], findings: [] });
    render(); await settle();
    expect(container.textContent).toBe("");
  });

  it("shows a failed first load with a retry", async () => {
    api.getMaturityScorecard.mockRejectedValueOnce(new ApiError("Internal error", 500, { error: "internal" })).mockResolvedValue(scorecard);
    render(); await settle();
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Retry"));
    expect(retry).toBeTruthy();
    retry!.click(); await settle();
    expect(container.textContent).toContain("test rarely passes first time");
  });
});
