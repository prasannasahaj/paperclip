import { Fragment, useEffect, useMemo, useState } from "react";
import type { TaskChatItem } from "./task-chat-model";
import {
  buildTaskStatusLine,
  currentActivityLabel,
  type TaskStatusLineInput,
  type TaskStatusTone,
} from "./task-status-line";

const RUNNING_TICK_INTERVAL_MS = 1000;
const IDLE_TICK_INTERVAL_MS = 30_000;

const TONE_CLASS: Record<TaskStatusTone, string> = {
  ok: "text-foreground",
  warn: "text-(--status-task-icon-todo)",
  alert: "text-destructive",
  muted: "text-muted-foreground",
};

function useTick(intervalMs: number): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}

export type TaskStatusSessionFacts = Pick<
  TaskStatusLineInput,
  "model" | "context" | "lastReplyAtMs" | "rateLimit" | "costUsd"
>;

export function TaskChatStatusLine({
  runState,
  items,
  startedAtMs,
  facts,
}: {
  runState: string;
  items: readonly TaskChatItem[];
  startedAtMs: number | null;
  facts: TaskStatusSessionFacts;
}) {
  const running = runState === "running";
  const nowMs = useTick(running ? RUNNING_TICK_INTERVAL_MS : IDLE_TICK_INTERVAL_MS);
  const activityLabel = useMemo(() => currentActivityLabel(items), [items]);
  const segments = buildTaskStatusLine({ runState, activityLabel, startedAtMs, nowMs, ...facts });
  if (segments.length === 0) return null;
  return (
    <div
      className="min-w-0 truncate whitespace-pre px-1 font-mono text-(length:--text-micro) text-muted-foreground"
      data-testid="task-chat-status-line"
    >
      {segments.map((segment, index) => (
        <Fragment key={segment.id}>
          {index > 0 ? <span aria-hidden className="text-border">{" │ "}</span> : null}
          <span data-segment={segment.id} className={TONE_CLASS[segment.tone]}>
            {segment.text}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
