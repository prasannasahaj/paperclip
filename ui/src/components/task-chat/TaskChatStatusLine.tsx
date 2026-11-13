import { useEffect, useMemo, useState } from "react";
import type { TaskChatItem } from "./task-chat-model";
import {
  buildTaskStatusLine,
  currentActivityLabel,
  type TaskStatusSegment,
} from "./task-status-line";

const TICK_INTERVAL_MS = 1000;

function useSecondTick(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [active]);
  return nowMs;
}

function segmentsText(segments: readonly TaskStatusSegment[]): string {
  return segments.map((segment) => segment.text).join(" · ");
}

export function TaskChatStatusLine({
  runState,
  items,
  startedAtMs,
  usageJson,
}: {
  runState: string;
  items: readonly TaskChatItem[];
  startedAtMs: number | null;
  usageJson?: Record<string, unknown> | null;
}) {
  const nowMs = useSecondTick(runState === "running");
  const activityLabel = useMemo(() => currentActivityLabel(items), [items]);
  const segments = buildTaskStatusLine({ runState, activityLabel, startedAtMs, nowMs, usageJson });
  if (segments.length === 0) return null;
  return (
    <div
      className="min-w-0 truncate px-1 font-mono text-(length:--text-micro) text-muted-foreground"
      data-testid="task-chat-status-line"
      role="status"
      aria-live="off"
    >
      {segmentsText(segments)}
    </div>
  );
}
