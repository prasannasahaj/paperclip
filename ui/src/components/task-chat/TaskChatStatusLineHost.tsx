import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { readProviderRateLimits, type Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import type { TaskChatItem } from "./task-chat-model";
import { TaskChatStatusLine } from "./TaskChatStatusLine";
import { resolveTaskStatusFacts } from "./task-status-facts";

const ACTIVE_RUN_REFRESH_MS = 8_000;
const IDLE_STALE_MS = 60_000;
const NO_RUN_STATE = "none";

export function TaskChatStatusLineHost({
  issueId,
  companyId,
  agent,
  runState,
  items,
  startedAtMs,
}: {
  issueId: string | null;
  companyId: string | null;
  agent: Agent | undefined;
  runState: string | null;
  items: readonly TaskChatItem[];
  startedAtMs: number | null;
}) {
  const agentId = agent?.id ?? null;
  const running = runState === "running";
  const contextUsage = useQuery({
    queryKey: queryKeys.issues.contextUsage(issueId ?? "", agentId),
    queryFn: () => issuesApi.getContextUsage(issueId!),
    enabled: Boolean(issueId && agentId),
    refetchInterval: running ? ACTIVE_RUN_REFRESH_MS : false,
    staleTime: running ? 0 : IDLE_STALE_MS,
  });
  const runtimeState = useQuery({
    queryKey: queryKeys.agents.runtimeState(agentId ?? ""),
    queryFn: () => agentsApi.runtimeState(agentId!, companyId ?? undefined),
    enabled: Boolean(agentId && companyId),
    staleTime: IDLE_STALE_MS,
  });
  const rateLimits = readProviderRateLimits(runtimeState.data?.stateJson);
  const facts = useMemo(
    () => resolveTaskStatusFacts({ agent, contextUsage: contextUsage.data, rateLimits }),
    [agent, contextUsage.data, rateLimits],
  );
  return (
    <TaskChatStatusLine
      runState={runState ?? NO_RUN_STATE}
      items={items}
      startedAtMs={startedAtMs}
      facts={facts}
    />
  );
}
