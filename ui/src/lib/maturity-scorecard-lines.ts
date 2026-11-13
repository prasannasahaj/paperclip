import type { CheckKindStats, IssueMaturityScorecard, ModelMixEntry } from "@paperclipai/shared";
import { formatCents, formatDurationMs } from "./utils";

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function describeCheckKind(stats: CheckKindStats): string {
  const parts = [
    count(stats.commands, "run"),
    stats.firstPassRate === null ? null : `${percent(stats.firstPassRate)} first pass`,
    stats.medianMs === null ? null : `median ${formatDurationMs(stats.medianMs)}`,
    stats.slowestMs === null ? null : `slowest ${formatDurationMs(stats.slowestMs)}`,
  ];
  return `${stats.kind}: ${parts.filter(Boolean).join(", ")}`;
}

function describeRework(scorecard: IssueMaturityScorecard): string | null {
  if (scorecard.reworkRuns === 0 && scorecard.recheckAfterFailure === 0) return null;
  return `rework: ${count(scorecard.reworkRuns, "run")}, ${count(scorecard.recheckAfterFailure, "recheck")} after failure`;
}

function describeModel(entry: ModelMixEntry): string {
  return `${entry.model}: ${formatCents(entry.costCents)}`;
}

export function formatMaturityScorecardLines(scorecard: IssueMaturityScorecard): string[] {
  const noChecksRan = scorecard.findings.some((finding) => finding.code === "no_checks_ran");
  const modelsByCost = [...scorecard.modelMix].sort((a, b) => b.costCents - a.costCents);
  const lines = [
    ...scorecard.findings.map((finding) => finding.message),
    ...(noChecksRan ? [] : scorecard.byKind.map(describeCheckKind)),
    scorecard.agentWaitShare === null ? null : `checks: ${percent(scorecard.agentWaitShare)} of run time`,
    describeRework(scorecard),
    ...modelsByCost.map(describeModel),
    scorecard.truncated ? "partial: event limit reached" : null,
  ];
  return lines.filter((line): line is string => line !== null);
}
