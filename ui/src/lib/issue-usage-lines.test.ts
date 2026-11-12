import { describe, expect, it } from "vitest";
import type { IssueCostSummary } from "@paperclipai/shared";
import { describeIssueUsage } from "./issue-usage-lines";

const summary = (overrides: Partial<IssueCostSummary> = {}): IssueCostSummary => ({
  issueId: "i1",
  issueCount: 1,
  includeDescendants: true,
  costCents: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  runCount: 0,
  runtimeMs: 0,
  byAgent: [],
  ...overrides,
});

describe("describeIssueUsage", () => {
  it("returns null before any run or token has been recorded", () => {
    expect(describeIssueUsage(summary())).toBeNull();
  });

  it("leads with tokens and omits an unpriced zero cost", () => {
    const usage = describeIssueUsage(summary({ inputTokens: 1000, cachedInputTokens: 4000, outputTokens: 500, runCount: 3, runtimeMs: 125_000 }));
    expect(usage?.headline).toBe("5.5k tokens · 3 runs · 2m 5s");
  });

  it("adds the cost when priced", () => {
    const usage = describeIssueUsage(summary({ costCents: 1250, inputTokens: 1000, runCount: 1 }));
    expect(usage?.headline).toBe("$12.50 · 1.0k tokens · 1 run");
  });

  it("lists each agent with its own tokens and cost, keeping the server order", () => {
    const usage = describeIssueUsage(summary({
      runCount: 2,
      inputTokens: 3100,
      byAgent: [
        { agentId: "a", agentName: "Builder", costCents: 50, inputTokens: 3000, cachedInputTokens: 0, outputTokens: 0 },
        { agentId: null, agentName: null, costCents: 0, inputTokens: 100, cachedInputTokens: 0, outputTokens: 0 },
      ],
    }));
    expect(usage?.agents).toEqual([
      { key: "a", name: "Builder", detail: "$0.50 · 3.0k tokens" },
      { key: "unattributed", name: "Unattributed", detail: "100 tokens" },
    ]);
  });
});
