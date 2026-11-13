import {
  FAST_CHECK_BUDGET_MS,
  type CheckKind,
  type CheckKindStats,
  type IssueMaturityScorecard,
  type MaturityFinding,
  type ModelMixEntry,
} from "@paperclipai/shared";

export interface ToolCommandRecord {
  runId: string;
  executionId: string;
  kind: CheckKind;
  exitCode: number | null;
  durationMs: number | null;
  environmentBlocked: boolean;
  startedAtMs: number;
}

export interface RunRecord {
  id: string;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  retryOfRunId: string | null;
  scheduledRetryAttempt: number;
  continuationAttempt: number;
}

export interface BuildScorecardInput {
  issueId: string;
  includeDescendants: boolean;
  truncated: boolean;
  commands: ToolCommandRecord[];
  shellCommandsObserved: number;
  runs: RunRecord[];
  modelMix: ModelMixEntry[];
}

const CHECK_KIND_ORDER: CheckKind[] = ["compile", "lint", "typecheck", "test", "mutation", "build"];
const LOW_FIRST_PASS_THRESHOLD = 0.5;
const LOW_FIRST_PASS_MIN_RUNS = 3;
const MAX_WAIT_SHARE = 1;

function isFailure(command: ToolCommandRecord): boolean {
  return command.exitCode !== null && command.exitCode !== 0;
}

function byStartTime(left: ToolCommandRecord, right: ToolCommandRecord): number {
  return left.startedAtMs - right.startedAtMs;
}

function median(sortedValues: number[]): number | null {
  if (sortedValues.length === 0) return null;
  const middle = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 1
    ? sortedValues[middle]
    : (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function firstPassOutcomes(kindCommands: ToolCommandRecord[]): boolean[] {
  const perRun = groupBy(kindCommands, (command) => command.runId);
  const outcomes: boolean[] = [];
  for (const runCommands of perRun.values()) {
    const first = runCommands
      .filter((command) => command.exitCode !== null)
      .sort(byStartTime)[0];
    if (first) outcomes.push(first.exitCode === 0);
  }
  return outcomes;
}

function countRechecksAfterFailure(commands: ToolCommandRecord[]): number {
  const perRunAndKind = groupBy(commands, (command) => `${command.runId}:${command.kind}`);
  let rechecks = 0;
  for (const group of perRunAndKind.values()) {
    let failureSeen = false;
    for (const command of [...group].sort(byStartTime)) {
      if (failureSeen) rechecks += 1;
      if (isFailure(command)) failureSeen = true;
    }
  }
  return rechecks;
}

function buildKindStats(kind: CheckKind, kindCommands: ToolCommandRecord[]): CheckKindStats & { firstPassSample: number } {
  const durations = kindCommands
    .map((command) => command.durationMs)
    .filter((duration): duration is number => duration !== null)
    .sort((left, right) => left - right);
  const outcomes = firstPassOutcomes(kindCommands);
  return {
    kind,
    commands: kindCommands.length,
    failures: kindCommands.filter(isFailure).length,
    firstPassRate: outcomes.length === 0 ? null : outcomes.filter(Boolean).length / outcomes.length,
    firstPassSample: outcomes.length,
    medianMs: median(durations),
    slowestMs: durations.length === 0 ? null : durations[durations.length - 1],
  };
}

function isReworkRun(run: RunRecord): boolean {
  return run.retryOfRunId !== null || run.scheduledRetryAttempt > 0 || run.continuationAttempt > 0;
}

function runtimeMsByRunId(runs: RunRecord[]): Map<string, number> {
  const runtimes = new Map<string, number>();
  for (const run of runs) {
    if (run.startedAtMs === null || run.finishedAtMs === null) continue;
    const runtimeMs = run.finishedAtMs - run.startedAtMs;
    if (runtimeMs > 0) runtimes.set(run.id, runtimeMs);
  }
  return runtimes;
}

function computeAgentWaitShare(commands: ToolCommandRecord[], runs: RunRecord[]): number | null {
  const runtimes = runtimeMsByRunId(runs);
  let totalRuntimeMs = 0;
  for (const runtimeMs of runtimes.values()) totalRuntimeMs += runtimeMs;
  if (totalRuntimeMs === 0) return null;

  const measuredDurations = commands
    .filter((command) => runtimes.has(command.runId))
    .map((command) => command.durationMs)
    .filter((duration): duration is number => duration !== null);
  if (measuredDurations.length === 0) return null;

  const waitShare = measuredDurations.reduce((total, duration) => total + duration, 0) / totalRuntimeMs;
  return Math.min(MAX_WAIT_SHARE, waitShare);
}

function checkPresenceFinding(input: BuildScorecardInput): MaturityFinding | null {
  if (input.shellCommandsObserved === 0) {
    return input.runs.length === 0
      ? null
      : { code: "no_shell_events", message: "No shell commands were recorded for this task, so check timing is unavailable." };
  }
  return input.commands.length === 0
    ? { code: "no_checks_ran", message: "No compile, lint, typecheck, test, mutation or build checks ran for this task." }
    : null;
}

function buildFindings(
  input: BuildScorecardInput,
  environmentBlockedCount: number,
  kindStats: Array<CheckKindStats & { firstPassSample: number }>,
): MaturityFinding[] {
  const { commands } = input;
  const presence = checkPresenceFinding(input);
  const findings: MaturityFinding[] = presence ? [presence] : [];
  if (commands.some((command) => command.durationMs !== null && command.durationMs > FAST_CHECK_BUDGET_MS)) {
    findings.push({
      code: "slow_check",
      message: `At least one check took longer than ${FAST_CHECK_BUDGET_MS / 1000} seconds.`,
    });
  }
  if (environmentBlockedCount > 0) {
    findings.push({
      code: "environment_blocked",
      message: `${environmentBlockedCount} failing check${environmentBlockedCount === 1 ? " was" : "s were"} blocked by the environment.`,
    });
  }
  for (const stats of kindStats) {
    const lowFirstPass =
      stats.firstPassSample >= LOW_FIRST_PASS_MIN_RUNS &&
      stats.firstPassRate !== null &&
      stats.firstPassRate < LOW_FIRST_PASS_THRESHOLD;
    if (lowFirstPass) {
      findings.push({
        code: "low_first_pass",
        message: `${stats.kind} checks passed on the first try in fewer than half of the runs.`,
      });
    }
  }
  return findings;
}

export function buildScorecard(input: BuildScorecardInput): IssueMaturityScorecard {
  const { commands, runs } = input;
  const commandsByKind = groupBy(commands, (command) => command.kind);
  const kindStats = CHECK_KIND_ORDER.flatMap((kind) => {
    const kindCommands = commandsByKind.get(kind);
    return kindCommands ? [buildKindStats(kind, kindCommands)] : [];
  });
  const environmentBlockedCount = commands.filter(
    (command) => isFailure(command) && command.environmentBlocked,
  ).length;

  return {
    issueId: input.issueId,
    includeDescendants: input.includeDescendants,
    truncated: input.truncated,
    runCount: runs.length,
    reworkRuns: runs.filter(isReworkRun).length,
    recheckAfterFailure: countRechecksAfterFailure(commands),
    environmentBlockedCount,
    agentWaitShare: computeAgentWaitShare(commands, runs),
    byKind: kindStats.map(({ firstPassSample: _firstPassSample, ...stats }) => stats),
    modelMix: input.modelMix,
    findings: buildFindings(input, environmentBlockedCount, kindStats),
  };
}
