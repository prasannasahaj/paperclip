import type { IssueCostSummary } from "@paperclipai/shared";
import { formatCents, formatDurationMs, formatTokens } from "./utils";

export interface IssueUsageAgentLine {
  key: string;
  name: string;
  detail: string;
}

export interface IssueUsageLines {
  headline: string;
  agents: IssueUsageAgentLine[];
}

function costAndTokens(costCents: number, tokens: number): string {
  return [costCents > 0 ? formatCents(costCents) : null, `${formatTokens(tokens)} tokens`]
    .filter(Boolean)
    .join(" · ");
}

export function describeIssueUsage(summary: IssueCostSummary): IssueUsageLines | null {
  const totalTokens = summary.inputTokens + summary.cachedInputTokens + summary.outputTokens;
  if (summary.runCount === 0 && totalTokens === 0) return null;
  const headline = [
    costAndTokens(summary.costCents, totalTokens),
    `${summary.runCount} ${summary.runCount === 1 ? "run" : "runs"}`,
    summary.runtimeMs > 0 ? formatDurationMs(summary.runtimeMs) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const agents = summary.byAgent.map((row) => ({
    key: row.agentId ?? "unattributed",
    name: row.agentName ?? "Unattributed",
    detail: costAndTokens(row.costCents, row.inputTokens + row.cachedInputTokens + row.outputTokens),
  }));
  return { headline, agents };
}
