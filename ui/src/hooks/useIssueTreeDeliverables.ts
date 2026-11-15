import { useQuery } from "@tanstack/react-query";
import type { IssueTreeDeliverables } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "@/lib/query-placeholder-data";

export function useIssueTreeDeliverables(
  issueId: string | null | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: queryKeys.issues.treeDeliverables(issueId ?? "__none__"),
    queryFn: ({ signal }) => issuesApi.listTreeDeliverables(issueId!, { signal }),
    enabled: Boolean(issueId) && (options?.enabled ?? true),
    refetchOnMount: "always",
    placeholderData: keepPreviousDataForSameQueryTail<IssueTreeDeliverables>(issueId ?? "__none__"),
  });
}
