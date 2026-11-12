import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { describeIssueUsage } from "../../lib/issue-usage-lines";
import { QueryErrorState, useQueryView } from "../QueryView";
import { PropertyRow } from "./primitives";

const ACTIVE_RUN_REFRESH_MS = 8_000;

export function IssueUsageRow({ issueId, hasActiveRun }: { issueId: string; hasActiveRun: boolean }) {
  const query = useQuery({
    queryKey: queryKeys.issues.costSummary(issueId),
    queryFn: () => issuesApi.getCostSummary(issueId),
    refetchInterval: hasActiveRun ? ACTIVE_RUN_REFRESH_MS : false,
    staleTime: hasActiveRun ? 0 : 60_000,
  });
  const view = useQueryView(query);
  const wasActive = useRef(hasActiveRun);
  const { refetch } = query;
  useEffect(() => {
    if (wasActive.current && !hasActiveRun) void refetch();
    wasActive.current = hasActiveRun;
  }, [hasActiveRun, refetch]);

  if (view.kind === "error" && !view.data) {
    return (
      <PropertyRow label="Usage">
        <QueryErrorState
          error={view.error}
          size="inline"
          action="load task usage"
          onRetry={view.retry}
          retrying={view.isFetching}
        />
      </PropertyRow>
    );
  }
  const usage = view.data ? describeIssueUsage(view.data) : null;
  if (!usage) return null;
  return (
    <PropertyRow label="Usage" wrap>
      <div className="flex min-w-0 flex-col gap-0.5 text-xs" data-testid="issue-usage-row">
        <span className="font-mono tabular-nums">{usage.headline}</span>
        {usage.agents.length > 1
          ? usage.agents.map((agent) => (
              <span key={agent.key} className="flex min-w-0 justify-between gap-3 text-muted-foreground">
                <span className="truncate">{agent.name}</span>
                <span className="shrink-0 font-mono tabular-nums">{agent.detail}</span>
              </span>
            ))
          : null}
      </div>
    </PropertyRow>
  );
}
