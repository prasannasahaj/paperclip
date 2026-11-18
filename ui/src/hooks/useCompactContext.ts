import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueContextCompaction } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { useOptionalToastActions } from "../context/ToastContext";
import type { ContextCompactState } from "../components/ContextUsageMeter";

export const CONTEXT_USAGE_STALE_MS = 60_000;

export function contextCompactState(
  compaction: IssueContextCompaction | undefined,
  requesting: boolean,
  onCompact: () => void,
): ContextCompactState | null {
  if (!compaction) return null;
  if (requesting || compaction.status === "pending") return { status: "pending" };
  if (compaction.status === "unavailable") {
    return { status: "unavailable", reason: compaction.reason ?? "Compaction is unavailable right now." };
  }
  return { status: "available", onCompact };
}

export function useCompactContextRequest(issueId: string | null, assigneeAgentId: string | null) {
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  return useMutation({
    mutationFn: () => issuesApi.compactContext(issueId!),
    onSettled: async () => {
      if (!issueId) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.contextUsage(issueId, assigneeAgentId) }),
      ]);
    },
    onError: (error) => {
      toast?.pushToast({
        title: "Could not compact the context",
        body: error instanceof Error ? error.message : "Try again in a moment.",
        tone: "error",
      });
    },
  });
}

export function useCompactContext(issueId: string | null, assigneeAgentId: string | null) {
  const usage = useQuery({
    queryKey: queryKeys.issues.contextUsage(issueId ?? "", assigneeAgentId),
    queryFn: () => issuesApi.getContextUsage(issueId!),
    enabled: Boolean(issueId),
    staleTime: CONTEXT_USAGE_STALE_MS,
  });
  const request = useCompactContextRequest(issueId, assigneeAgentId);
  const { mutateAsync } = request;
  const compact = useCallback(async () => {
    if (!issueId) return;
    await mutateAsync();
  }, [issueId, mutateAsync]);
  const compactFromButton = useCallback(() => {
    compact().catch(() => undefined);
  }, [compact]);
  const state = issueId
    ? contextCompactState(usage.data?.compaction, request.isPending, compactFromButton)
    : null;
  return { state, compact };
}
