import { formatTokens } from "@/lib/utils";
import { summarizeRunUsage } from "@/lib/run-usage-summary";
import type { TaskChatItem } from "./task-chat-model";

const ACTIVITY_LABEL_MAX_CHARS = 80;

const ACTIVE_RUN_STATE_LABELS: Record<string, string> = {
  running: "Running",
};

export interface TaskStatusSegment {
  id: "state" | "activity" | "elapsed" | "usage";
  text: string;
}

export interface TaskStatusLineInput {
  runState: string;
  activityLabel?: string;
  startedAtMs: number | null;
  nowMs: number;
  usageJson?: Record<string, unknown> | null;
}

export function formatStatusElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function formatUsage(usageJson: Record<string, unknown> | null | undefined): string | undefined {
  const usage = summarizeRunUsage(usageJson);
  if (!usage) return undefined;
  const tokens =
    usage.inputTokens !== undefined || usage.outputTokens !== undefined
      ? `↑${formatTokens(usage.inputTokens ?? 0)} ↓${formatTokens(usage.outputTokens ?? 0)}`
      : undefined;
  const cost = usage.costUsd !== undefined ? `$${usage.costUsd.toFixed(2)}` : undefined;
  const text = [tokens, cost].filter(Boolean).join(" · ");
  return text || undefined;
}

export function buildTaskStatusLine(input: TaskStatusLineInput): TaskStatusSegment[] {
  const stateLabel = ACTIVE_RUN_STATE_LABELS[input.runState];
  if (!stateLabel) return [];
  const segments: TaskStatusSegment[] = [{ id: "state", text: stateLabel }];
  if (input.activityLabel) segments.push({ id: "activity", text: input.activityLabel });
  if (input.startedAtMs !== null) {
    segments.push({ id: "elapsed", text: formatStatusElapsed(input.nowMs - input.startedAtMs) });
  }
  const usage = formatUsage(input.usageJson);
  if (usage) segments.push({ id: "usage", text: usage });
  return segments;
}

function clipLabel(label: string): string {
  return label.length <= ACTIVITY_LABEL_MAX_CHARS
    ? label
    : `${label.slice(0, ACTIVITY_LABEL_MAX_CHARS - 1)}…`;
}

export function currentActivityLabel(items: readonly TaskChatItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "tool" && item.status === "in_progress") {
      return clipLabel([item.name, item.target].filter(Boolean).join(" "));
    }
  }
  return undefined;
}
