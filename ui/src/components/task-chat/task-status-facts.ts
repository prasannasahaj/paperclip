import type { Agent, IssueContextUsage, ProviderRateLimitSnapshot } from "@paperclipai/shared";
import { composerDefaultModel } from "./composer-run-settings";
import type { TaskStatusSessionFacts } from "./TaskChatStatusLine";

const FIVE_HOUR_WINDOW_LABEL = "5h";
const CLAUDE_MODEL_PREFIX = "claude";

function fiveHourRateLimit(rateLimits: ProviderRateLimitSnapshot | null | undefined): TaskStatusSessionFacts["rateLimit"] {
  const window = rateLimits?.windows.find((candidate) => candidate.shortLabel === FIVE_HOUR_WINDOW_LABEL);
  if (!window || window.usedPercent === null) return null;
  const resetsAtMs = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return { usedPercent: window.usedPercent, resetsAtMs: Number.isFinite(resetsAtMs) ? resetsAtMs : null };
}

export function resolveTaskStatusFacts(sources: {
  agent?: Agent;
  contextUsage?: IssueContextUsage | null;
  rateLimits?: ProviderRateLimitSnapshot | null;
}): TaskStatusSessionFacts {
  const model = sources.agent?.adapterConfig ? composerDefaultModel(sources.agent) : "";
  const usage = sources.contextUsage ?? null;
  const claudeSession = model.toLowerCase().startsWith(CLAUDE_MODEL_PREFIX);
  return {
    model,
    context: usage ? { usedTokens: usage.usedTokens, windowTokens: usage.windowTokens } : null,
    lastReplyAtMs: usage && claudeSession ? Date.parse(usage.observedAt) : null,
    rateLimit: fiveHourRateLimit(sources.rateLimits),
    costUsd: usage?.costUsd ?? null,
  };
}
