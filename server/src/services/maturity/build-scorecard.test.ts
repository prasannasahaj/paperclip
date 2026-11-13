import { describe, expect, it } from "vitest";
import { FAST_CHECK_BUDGET_MS } from "@paperclipai/shared";
import { buildScorecard, type RunRecord, type ToolCommandRecord } from "./build-scorecard.js";

function command(overrides: Partial<ToolCommandRecord> = {}): ToolCommandRecord {
  return {
    runId: "run-1",
    executionId: "exec-1",
    kind: "test",
    exitCode: 0,
    durationMs: 1_000,
    environmentBlocked: false,
    startedAtMs: 1_000,
    ...overrides,
  };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    startedAtMs: 0,
    finishedAtMs: 100_000,
    retryOfRunId: null,
    scheduledRetryAttempt: 0,
    continuationAttempt: 0,
    ...overrides,
  };
}

function scorecard(input: { commands?: ToolCommandRecord[]; runs?: RunRecord[] }) {
  return buildScorecard({
    issueId: "issue-1",
    includeDescendants: false,
    truncated: false,
    commands: input.commands ?? [],
    runs: input.runs ?? [],
    modelMix: [],
  });
}

describe("buildScorecard", () => {
  it("reports no_checks_ran and null rates when there are no commands", () => {
    const result = scorecard({});

    expect(result.byKind).toEqual([]);
    expect(result.agentWaitShare).toBeNull();
    expect(result.findings.map((finding) => finding.code)).toEqual(["no_checks_ran"]);
  });

  it("computes firstPassRate per kind from the first command of each run and kind", () => {
    const result = scorecard({
      runs: [run({ id: "run-1" }), run({ id: "run-2" })],
      commands: [
        command({ runId: "run-1", executionId: "a", startedAtMs: 1, exitCode: 1 }),
        command({ runId: "run-1", executionId: "b", startedAtMs: 2, exitCode: 0 }),
        command({ runId: "run-2", executionId: "c", startedAtMs: 1, exitCode: 0 }),
        command({ runId: "run-2", executionId: "d", startedAtMs: 2, exitCode: 1 }),
      ],
    });

    expect(result.byKind).toHaveLength(1);
    expect(result.byKind[0]).toMatchObject({ kind: "test", commands: 4, failures: 2, firstPassRate: 0.5 });
  });

  it("ignores commands whose exitCode is null in pass rate and failures", () => {
    const result = scorecard({
      runs: [run()],
      commands: [
        command({ executionId: "a", startedAtMs: 1, exitCode: null }),
        command({ executionId: "b", startedAtMs: 2, exitCode: 0 }),
        command({ executionId: "c", startedAtMs: 3, exitCode: null }),
      ],
    });

    expect(result.byKind[0]).toMatchObject({ failures: 0, firstPassRate: 1 });
  });

  it("ignores commands whose durationMs is null in median and slowest", () => {
    const result = scorecard({
      runs: [run()],
      commands: [
        command({ executionId: "a", startedAtMs: 1, durationMs: 1_000 }),
        command({ executionId: "b", startedAtMs: 2, durationMs: null }),
        command({ executionId: "c", startedAtMs: 3, durationMs: 3_000 }),
      ],
    });

    expect(result.byKind[0]).toMatchObject({ medianMs: 2_000, slowestMs: 3_000 });
  });

  it("counts recheckAfterFailure when a kind runs again in the same run after a failure", () => {
    const result = scorecard({
      runs: [run({ id: "run-1" }), run({ id: "run-2" })],
      commands: [
        command({ runId: "run-1", executionId: "a", startedAtMs: 1, exitCode: 1 }),
        command({ runId: "run-1", executionId: "b", startedAtMs: 2, exitCode: 0 }),
        command({ runId: "run-1", executionId: "c", startedAtMs: 3, exitCode: 0 }),
        command({ runId: "run-2", executionId: "d", startedAtMs: 1, exitCode: 0 }),
        command({ runId: "run-2", executionId: "e", startedAtMs: 2, exitCode: 0 }),
        command({ runId: "run-2", executionId: "f", startedAtMs: 3, kind: "lint", exitCode: 1 }),
      ],
    });

    expect(result.recheckAfterFailure).toBe(2);
  });

  it("counts reworkRuns for runs with retryOfRunId or scheduledRetryAttempt or continuationAttempt above zero", () => {
    const result = scorecard({
      runs: [
        run({ id: "plain" }),
        run({ id: "retry", retryOfRunId: "plain" }),
        run({ id: "scheduled", scheduledRetryAttempt: 1 }),
        run({ id: "continued", continuationAttempt: 2 }),
      ],
    });

    expect(result.runCount).toBe(4);
    expect(result.reworkRuns).toBe(3);
  });

  it("agentWaitShare is summed check duration divided by summed run runtime and null when runtime is zero", () => {
    const withRuntime = scorecard({
      runs: [run({ startedAtMs: 0, finishedAtMs: 100_000 })],
      commands: [
        command({ executionId: "a", startedAtMs: 1, durationMs: 10_000 }),
        command({ executionId: "b", startedAtMs: 2, durationMs: 15_000 }),
        command({ executionId: "c", startedAtMs: 3, durationMs: null }),
      ],
    });
    const withoutRuntime = scorecard({
      runs: [run({ startedAtMs: null, finishedAtMs: null })],
      commands: [command()],
    });

    expect(withRuntime.agentWaitShare).toBe(0.25);
    expect(withoutRuntime.agentWaitShare).toBeNull();
  });

  it("emits slow_check when any check exceeds FAST_CHECK_BUDGET_MS", () => {
    const slow = scorecard({
      runs: [run()],
      commands: [command({ durationMs: FAST_CHECK_BUDGET_MS + 1 })],
    });
    const atBudget = scorecard({
      runs: [run()],
      commands: [command({ durationMs: FAST_CHECK_BUDGET_MS })],
    });

    expect(slow.findings.map((finding) => finding.code)).toContain("slow_check");
    expect(atBudget.findings.map((finding) => finding.code)).not.toContain("slow_check");
  });

  it("emits environment_blocked when a failing command is flagged environmentBlocked", () => {
    const blocked = scorecard({
      runs: [run()],
      commands: [command({ exitCode: 1, environmentBlocked: true })],
    });
    const passing = scorecard({
      runs: [run()],
      commands: [command({ exitCode: 0, environmentBlocked: true })],
    });

    expect(blocked.environmentBlockedCount).toBe(1);
    expect(blocked.findings.map((finding) => finding.code)).toContain("environment_blocked");
    expect(passing.environmentBlockedCount).toBe(0);
    expect(passing.findings.map((finding) => finding.code)).not.toContain("environment_blocked");
  });

  it("emits low_first_pass when a kind has at least 3 runs and firstPassRate below 0.5", () => {
    const runs = [run({ id: "r1" }), run({ id: "r2" }), run({ id: "r3" })];
    const failingFirst = scorecard({
      runs,
      commands: [
        command({ runId: "r1", executionId: "a", exitCode: 1 }),
        command({ runId: "r2", executionId: "b", exitCode: 1 }),
        command({ runId: "r3", executionId: "c", exitCode: 0 }),
      ],
    });
    const tooFewRuns = scorecard({
      runs,
      commands: [
        command({ runId: "r1", executionId: "a", exitCode: 1 }),
        command({ runId: "r2", executionId: "b", exitCode: 1 }),
      ],
    });

    expect(failingFirst.findings.map((finding) => finding.code)).toContain("low_first_pass");
    expect(tooFewRuns.findings.map((finding) => finding.code)).not.toContain("low_first_pass");
  });
});
