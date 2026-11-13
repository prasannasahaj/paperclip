import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { formatMaturityScorecardLines } from "../../lib/maturity-scorecard-lines";
import { QueryErrorState, useQueryView } from "../QueryView";
import { PropertyRow } from "./primitives";

const ACTIVE_RUN_REFRESH_MS = 8_000;

export function MaturityRow({ issueId, hasActiveRun }: { issueId: string; hasActiveRun: boolean }) {
  const query = useQuery({
    queryKey: queryKeys.issues.maturityScorecard(issueId),
    queryFn: () => issuesApi.getMaturityScorecard(issueId),
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
      <PropertyRow label="Maturity">
        <QueryErrorState
          error={view.error}
          size="inline"
          action="load task maturity"
          onRetry={view.retry}
          retrying={view.isFetching}
        />
      </PropertyRow>
    );
  }
  if (!view.data || view.data.runCount === 0) return null;
  const lines = formatMaturityScorecardLines(view.data);
  if (lines.length === 0) return null;
  return (
    <PropertyRow label="Maturity" wrap>
      <div className="flex min-w-0 flex-col gap-0.5 text-xs" data-testid="issue-maturity-row">
        {lines.map((line, index) => (
          <span key={index} className="min-w-0 break-words font-mono tabular-nums">{line}</span>
        ))}
      </div>
    </PropertyRow>
  );
}
