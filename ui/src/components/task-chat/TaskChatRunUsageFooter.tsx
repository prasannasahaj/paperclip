import { formatTokens } from "@/lib/utils";
import { summarizeRunUsage } from "@/lib/run-usage-summary";

export function TaskChatRunUsageFooter({ usageJson }: { usageJson?: Record<string, unknown> | null }) {
  const usage = summarizeRunUsage(usageJson);
  if (!usage) return null;
  const { inputTokens, outputTokens, cachedInputTokens, costUsd } = usage;
  const segments = [
    inputTokens !== undefined || outputTokens !== undefined
      ? `↑${formatTokens(inputTokens ?? 0)} ↓${formatTokens(outputTokens ?? 0)}`
      : undefined,
    cachedInputTokens !== undefined ? `${formatTokens(cachedInputTokens)} cached` : undefined,
    costUsd !== undefined ? `$${costUsd.toFixed(2)}` : undefined,
  ].filter(Boolean);
  return (
    <div
      className="px-1 font-mono text-(length:--text-micro) text-muted-foreground"
      data-testid="task-chat-run-usage-footer"
    >
      {segments.join(" · ")}
    </div>
  );
}
