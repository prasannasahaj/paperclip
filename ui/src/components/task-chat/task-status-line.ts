import type { TaskChatItem } from "./task-chat-model";

const ACTIVITY_LABEL_MAX_CHARS = 80;
const CLAUDE_PROMPT_CACHE_TTL_MS = 60 * 60_000;
const CONTEXT_COMPACT_REMAINING_PERCENT = 20;
const CONTEXT_WARN_REMAINING_PERCENT = 40;
const RATE_ALERT_USED_PERCENT = 80;
const RATE_WARN_USED_PERCENT = 50;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

export type TaskStatusTone = "ok" | "warn" | "alert" | "muted";

export interface TaskStatusSegment {
  id: "state" | "activity" | "model" | "context" | "cache" | "rate" | "cost" | "elapsed";
  text: string;
  tone: TaskStatusTone;
}

export interface TaskStatusLineInput {
  runState: string;
  activityLabel?: string;
  startedAtMs: number | null;
  nowMs: number;
  model?: string;
  context?: { usedTokens: number; windowTokens: number } | null;
  lastReplyAtMs?: number | null;
  rateLimit?: { usedPercent: number; resetsAtMs: number | null } | null;
  costUsd?: number | null;
}

export function formatStatusElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function formatRemaining(remainingMs: number): string {
  const totalMinutes = Math.floor(remainingMs / MS_PER_MINUTE);
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`;
}

const CLAUDE_MODEL_PATTERN = /^claude[-\s]+([a-z]+)[-\s]+(\d+)(?:[-.\s](\d{1,2})(?!\d))?/;

export function shortModelName(rawModel: string): string {
  const model = rawModel.trim().toLowerCase();
  const claude = CLAUDE_MODEL_PATTERN.exec(model);
  if (!claude) return model;
  const [, family, major, minor] = claude;
  return `${family} ${major}${minor ? `.${minor}` : ""}`;
}

function contextSegment(context: TaskStatusLineInput["context"]): TaskStatusSegment | null {
  if (!context || context.windowTokens <= 0) return null;
  const usedPercent = (context.usedTokens / context.windowTokens) * 100;
  const remaining = Math.min(100, Math.max(0, Math.round(100 - usedPercent)));
  if (remaining <= CONTEXT_COMPACT_REMAINING_PERCENT) {
    return { id: "context", text: `ctx ${remaining}% COMPACT`, tone: "alert" };
  }
  const tone = remaining <= CONTEXT_WARN_REMAINING_PERCENT ? "warn" : "ok";
  return { id: "context", text: `ctx ${remaining}%`, tone };
}

function cacheSegment(lastReplyAtMs: number | null | undefined, nowMs: number): TaskStatusSegment | null {
  if (lastReplyAtMs == null) return null;
  const remainingMs = lastReplyAtMs + CLAUDE_PROMPT_CACHE_TTL_MS - nowMs;
  if (remainingMs <= 0) return { id: "cache", text: "cache cold", tone: "warn" };
  return { id: "cache", text: `cache ${formatRemaining(remainingMs)}`, tone: "muted" };
}

function rateSegment(rateLimit: TaskStatusLineInput["rateLimit"], nowMs: number): TaskStatusSegment | null {
  if (!rateLimit) return null;
  const used = Math.round(rateLimit.usedPercent);
  const tone: TaskStatusTone =
    used >= RATE_ALERT_USED_PERCENT ? "alert" : used >= RATE_WARN_USED_PERCENT ? "warn" : "ok";
  const resetsInMs = rateLimit.resetsAtMs === null ? 0 : rateLimit.resetsAtMs - nowMs;
  const reset = resetsInMs > 0 ? ` ↻${formatRemaining(resetsInMs)}` : "";
  return { id: "rate", text: `5h ${used}%${reset}`, tone };
}

export function buildTaskStatusLine(input: TaskStatusLineInput): TaskStatusSegment[] {
  const running = input.runState === "running";
  const segments: Array<TaskStatusSegment | null> = [
    running ? { id: "state", text: "Running", tone: "ok" } : null,
    running && input.activityLabel ? { id: "activity", text: input.activityLabel, tone: "muted" } : null,
    input.model ? { id: "model", text: shortModelName(input.model), tone: "muted" } : null,
    contextSegment(input.context),
    cacheSegment(input.lastReplyAtMs, input.nowMs),
    rateSegment(input.rateLimit, input.nowMs),
    input.costUsd ? { id: "cost", text: `$${input.costUsd.toFixed(2)}`, tone: "muted" } : null,
    running && input.startedAtMs !== null
      ? { id: "elapsed", text: formatStatusElapsed(input.nowMs - input.startedAtMs), tone: "muted" }
      : null,
  ];
  return segments.filter((segment): segment is TaskStatusSegment => segment !== null);
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
