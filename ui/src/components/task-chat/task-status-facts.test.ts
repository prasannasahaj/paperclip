import { describe, expect, it } from "vitest";
import type { Agent, IssueContextUsage, ProviderRateLimitSnapshot } from "@paperclipai/shared";
import { resolveTaskStatusFacts } from "./task-status-facts";

const OBSERVED_AT = "2026-11-13T04:00:00.000Z";
const RESET_AT = "2026-11-13T07:00:00.000Z";

function agent(overrides: Record<string, unknown> = {}): Agent {
  return {
    id: "agent-1",
    adapterType: "claude_local",
    adapterConfig: { model: "claude-sonnet-5-5" },
    ...overrides,
  } as unknown as Agent;
}

function contextUsage(overrides: Partial<IssueContextUsage> = {}): IssueContextUsage {
  return {
    runId: "run-1",
    agentId: "agent-1",
    sessionId: null,
    usedTokens: 380_000,
    windowTokens: 1_000_000,
    observedAt: OBSERVED_AT,
    totals: null,
    costUsd: 0.42,
    compactions: 0,
    ...overrides,
  };
}

function rateLimits(windows: ProviderRateLimitSnapshot["windows"]): ProviderRateLimitSnapshot {
  return {
    schema: "paperclip.provider.rate_limits.v1",
    provider: "anthropic",
    windows,
    credits: null,
    limitReached: null,
    observedAt: OBSERVED_AT,
  };
}

const fiveHourWindow = {
  id: "five_hour",
  label: "5-hour window",
  shortLabel: "5h",
  windowMinutes: 300,
  usedPercent: 35,
  resetsAt: RESET_AT,
  status: "allowed" as const,
};

describe("resolveTaskStatusFacts", () => {
  it("returns no facts when nothing is known", () => {
    expect(resolveTaskStatusFacts({})).toEqual({
      model: "",
      context: null,
      lastReplyAtMs: null,
      rateLimit: null,
      costUsd: null,
    });
  });

  it("reads the model from the assigned agent", () => {
    expect(resolveTaskStatusFacts({ agent: agent() }).model).toBe("claude-sonnet-5-5");
  });

  it("tolerates an agent whose adapter config has not loaded", () => {
    const partialAgent = { id: "agent-1", adapterType: "claude_local" } as unknown as Agent;
    expect(resolveTaskStatusFacts({ agent: partialAgent }).model).toBe("");
  });

  it("reads context and cost from the session usage", () => {
    const facts = resolveTaskStatusFacts({ agent: agent(), contextUsage: contextUsage() });
    expect(facts.context).toEqual({ usedTokens: 380_000, windowTokens: 1_000_000 });
    expect(facts.costUsd).toBe(0.42);
  });

  it("times the prompt cache from the last measurement for a Claude model", () => {
    const facts = resolveTaskStatusFacts({ agent: agent(), contextUsage: contextUsage() });
    expect(facts.lastReplyAtMs).toBe(Date.parse(OBSERVED_AT));
  });

  it("leaves the prompt cache out for a non-Claude model", () => {
    const facts = resolveTaskStatusFacts({
      agent: agent({ adapterType: "codex_local", adapterConfig: { model: "gpt-5.5" } }),
      contextUsage: contextUsage(),
    });
    expect(facts.lastReplyAtMs).toBeNull();
  });

  it("reads the five-hour rate limit window", () => {
    const facts = resolveTaskStatusFacts({
      agent: agent(),
      rateLimits: rateLimits([{ ...fiveHourWindow, id: "weekly", shortLabel: "7d", usedPercent: 90 }, fiveHourWindow]),
    });
    expect(facts.rateLimit).toEqual({ usedPercent: 35, resetsAtMs: Date.parse(RESET_AT) });
  });

  it("skips a five-hour window that reports no usage", () => {
    const facts = resolveTaskStatusFacts({
      agent: agent(),
      rateLimits: rateLimits([{ ...fiveHourWindow, usedPercent: null }]),
    });
    expect(facts.rateLimit).toBeNull();
  });

  it("keeps the rate limit without a reset time when the provider gave none", () => {
    const facts = resolveTaskStatusFacts({
      rateLimits: rateLimits([{ ...fiveHourWindow, resetsAt: null }]),
    });
    expect(facts.rateLimit).toEqual({ usedPercent: 35, resetsAtMs: null });
  });
});
