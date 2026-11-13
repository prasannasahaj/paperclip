import { describe, expect, it } from "vitest";
import type { IssueMaturityScorecard } from "@paperclipai/shared";
import { formatMaturityScorecardLines } from "./maturity-scorecard-lines";

function scorecard(overrides: Partial<IssueMaturityScorecard> = {}): IssueMaturityScorecard {
  return {
    issueId: "issue-1",
    includeDescendants: true,
    truncated: false,
    runCount: 3,
    reworkRuns: 0,
    recheckAfterFailure: 0,
    environmentBlockedCount: 0,
    agentWaitShare: null,
    byKind: [],
    modelMix: [],
    findings: [],
    ...overrides,
  };
}

const testKind = {
  kind: "test" as const,
  commands: 4,
  failures: 2,
  firstPassRate: 0.5,
  medianMs: 38_000,
  slowestMs: 130_000,
};

describe("formatMaturityScorecardLines", () => {
  it("shows each finding message first", () => {
    const lines = formatMaturityScorecardLines(
      scorecard({
        findings: [
          { code: "slow_check", message: "test takes longer than a minute" },
          { code: "low_first_pass", message: "test rarely passes first time" },
        ],
        byKind: [testKind],
      }),
    );
    expect(lines.slice(0, 2)).toEqual(["test takes longer than a minute", "test rarely passes first time"]);
    expect(lines[2]).toContain("test:");
  });

  it('formats a check kind as "test: 4 runs, 50% first pass, median 38s, slowest 2m 10s"', () => {
    expect(formatMaturityScorecardLines(scorecard({ byKind: [testKind] }))).toContain(
      "test: 4 runs, 50% first pass, median 38s, slowest 2m 10s",
    );
  });

  it("omits first pass and durations that are unknown", () => {
    const lines = formatMaturityScorecardLines(
      scorecard({
        byKind: [{ kind: "lint", commands: 1, failures: 0, firstPassRate: null, medianMs: null, slowestMs: null }],
      }),
    );
    expect(lines).toContain("lint: 1 run");
  });

  it("rounds durations to whole seconds and drops zero seconds from minutes", () => {
    const lines = formatMaturityScorecardLines(
      scorecard({
        byKind: [{ kind: "build", commands: 2, failures: 0, firstPassRate: 1, medianMs: 59_600, slowestMs: 120_000 }],
      }),
    );
    expect(lines).toContain("build: 2 runs, 100% first pass, median 1m, slowest 2m");
  });

  it("prints wait share only when known", () => {
    expect(formatMaturityScorecardLines(scorecard({ agentWaitShare: 0.123 }))).toContain("checks: 12% of run time");
    expect(formatMaturityScorecardLines(scorecard()).join("\n")).not.toContain("of run time");
  });

  it("prints rework only when there was rework or a recheck after failure", () => {
    expect(formatMaturityScorecardLines(scorecard()).join("\n")).not.toContain("rework");
    const lines = formatMaturityScorecardLines(scorecard({ reworkRuns: 2, recheckAfterFailure: 1 }));
    expect(lines).toContain("rework: 2 runs, 1 recheck after failure");
  });

  it('prints "partial" when truncated', () => {
    const lines = formatMaturityScorecardLines(scorecard({ truncated: true }));
    expect(lines[lines.length - 1]).toBe("partial: event limit reached");
    expect(formatMaturityScorecardLines(scorecard()).join("\n")).not.toContain("partial");
  });

  it('prints "no checks ran" for the no_checks_ran finding and no per-kind lines', () => {
    const lines = formatMaturityScorecardLines(
      scorecard({ findings: [{ code: "no_checks_ran", message: "no checks ran" }], byKind: [testKind] }),
    );
    expect(lines).toEqual(["no checks ran"]);
  });

  it("prints the no_shell_events message and no per-kind lines", () => {
    const message = "No shell commands were recorded for this task, so check timing is unavailable.";
    const lines = formatMaturityScorecardLines(
      scorecard({ findings: [{ code: "no_shell_events", message }], byKind: [testKind] }),
    );
    expect(lines).toEqual([message]);
  });

  it("lists model mix as model and cost, largest first", () => {
    const lines = formatMaturityScorecardLines(
      scorecard({
        modelMix: [
          { model: "small-model", costCents: 5, inputTokens: 1, outputTokens: 1 },
          { model: "claude-opus-5-5", costCents: 124, inputTokens: 1, outputTokens: 1 },
        ],
      }),
    );
    expect(lines.slice(-2)).toEqual(["claude-opus-5-5: $1.24", "small-model: $0.05"]);
  });
});
