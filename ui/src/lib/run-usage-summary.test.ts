import { describe, expect, it } from "vitest";
import { summarizeRunUsage } from "./run-usage-summary";

describe("summarizeRunUsage", () => {
  it("reads camelCase usage with cost and cached tokens", () => {
    expect(
      summarizeRunUsage({ inputTokens: 1200, outputTokens: 300, cachedInputTokens: 9000, costUsd: 0.42 }),
    ).toEqual({ inputTokens: 1200, outputTokens: 300, cachedInputTokens: 9000, costUsd: 0.42 });
  });

  it("falls back to snake_case keys the server also emits", () => {
    expect(
      summarizeRunUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, total_cost_usd: 0.01 }),
    ).toEqual({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 7, costUsd: 0.01 });
  });

  it("omits fields the run did not report instead of showing zero", () => {
    expect(summarizeRunUsage({ inputTokens: 10, outputTokens: 5 })).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("omits a zero cost because it means unpriced, not free", () => {
    expect(summarizeRunUsage({ inputTokens: 10, outputTokens: 5, costUsd: 0 })).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("returns null when there is nothing to show", () => {
    expect(summarizeRunUsage(null)).toBeNull();
    expect(summarizeRunUsage({})).toBeNull();
    expect(summarizeRunUsage({ inputTokens: "many", billingType: "api" })).toBeNull();
  });
});
