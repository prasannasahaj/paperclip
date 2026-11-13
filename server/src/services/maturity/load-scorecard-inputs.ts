import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import type { ModelMixEntry } from "@paperclipai/shared";
import { classifyCommand } from "./classify-command.js";
import type { RunRecord, ToolCommandRecord } from "./build-scorecard.js";

export const MAX_EVENTS = 20_000;
export const MAX_RUNS = 2_000;

const SHELL_TOOL_NAME = "Bash";
const COMPLETED_EVENT_TYPE = "tool.execution.completed";
const TOOL_EVENT_TYPES = ["tool.execution.progressed", COMPLETED_EVENT_TYPE];
const ENVIRONMENT_BLOCK_PATTERN = /AccessDenied|Could not resolve|Access Denied|403/i;
const NULL_OUTPUT_LITERAL = "null";

export interface ToolEventRow {
  runId: string;
  eventType: string;
  payload: unknown;
  createdAt: Date | string;
}

export interface ScorecardInputs {
  commands: ToolCommandRecord[];
  runs: RunRecord[];
  modelMix: ModelMixEntry[];
  truncated: boolean;
}

interface ExecutionAccumulator {
  runId: string;
  executionId: string;
  isShell: boolean;
  command: string | null;
  completed: boolean;
  exitCode: number | null;
  durationMs: number | null;
  outputs: string[];
  startedAtMs: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolFields(payload: unknown): Record<string, unknown> | null {
  const root = asRecord(payload);
  if (!root) return null;
  return asRecord(asRecord(root.prpEvent)?.payload) ?? root;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function outputText(value: unknown): string | null {
  const text = nonEmptyString(value);
  return text !== null && text !== NULL_OUTPUT_LITERAL ? text : null;
}

function accumulatorFor(
  executions: Map<string, ExecutionAccumulator>,
  runId: string,
  executionId: string,
  startedAtMs: number,
): ExecutionAccumulator {
  const key = `${runId}:${executionId}`;
  const existing = executions.get(key);
  if (existing) {
    existing.startedAtMs = Math.min(existing.startedAtMs, startedAtMs);
    return existing;
  }
  const created: ExecutionAccumulator = {
    runId,
    executionId,
    isShell: false,
    command: null,
    completed: false,
    exitCode: null,
    durationMs: null,
    outputs: [],
    startedAtMs,
  };
  executions.set(key, created);
  return created;
}

function absorbEvent(execution: ExecutionAccumulator, eventType: string, fields: Record<string, unknown>) {
  if (fields.name === SHELL_TOOL_NAME) execution.isShell = true;
  const subject = nonEmptyString(fields.subject);
  if (subject !== null) execution.command = subject;
  const output = outputText(fields.output);
  if (output !== null) execution.outputs.push(output);
  if (eventType === COMPLETED_EVENT_TYPE) {
    execution.completed = true;
    execution.exitCode = numberOrNull(fields.exitCode);
    execution.durationMs = numberOrNull(fields.durationMs);
  }
}

function isEnvironmentBlocked(execution: ExecutionAccumulator): boolean {
  return (
    execution.exitCode !== null &&
    execution.exitCode !== 0 &&
    ENVIRONMENT_BLOCK_PATTERN.test(execution.outputs.join("\n"))
  );
}

function toRecord(execution: ExecutionAccumulator): ToolCommandRecord | null {
  if (!execution.isShell || !execution.completed || execution.command === null) return null;
  const kind = classifyCommand(execution.command);
  if (kind === null) return null;
  return {
    runId: execution.runId,
    executionId: execution.executionId,
    kind,
    exitCode: execution.exitCode,
    durationMs: execution.durationMs,
    environmentBlocked: isEnvironmentBlocked(execution),
    startedAtMs: execution.startedAtMs,
  };
}

export function toolCommandRecordsFromEvents(events: ToolEventRow[]): ToolCommandRecord[] {
  const executions = new Map<string, ExecutionAccumulator>();
  for (const event of events) {
    const fields = toolFields(event.payload);
    const executionId = fields ? nonEmptyString(fields.executionId) : null;
    if (!fields || executionId === null) continue;
    const startedAtMs = new Date(event.createdAt).getTime();
    absorbEvent(accumulatorFor(executions, event.runId, executionId, startedAtMs), event.eventType, fields);
  }
  return [...executions.values()].flatMap((execution) => {
    const record = toRecord(execution);
    return record ? [record] : [];
  });
}

function toMs(value: Date | null): number | null {
  return value ? value.getTime() : null;
}

export async function loadScorecardInputs(
  db: Db,
  input: { companyId: string; issueIds: string[]; maxEvents?: number },
): Promise<ScorecardInputs> {
  const { companyId, issueIds } = input;
  const maxEvents = input.maxEvents ?? MAX_EVENTS;
  if (issueIds.length === 0) return { commands: [], runs: [], modelMix: [], truncated: false };

  const [eventRows, runRows, modelRows] = await Promise.all([
    db
      .select({
        runId: heartbeatRunEvents.runId,
        eventType: heartbeatRunEvents.eventType,
        payload: heartbeatRunEvents.payload,
        createdAt: heartbeatRunEvents.createdAt,
      })
      .from(heartbeatRunEvents)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, heartbeatRunEvents.runId))
      .where(and(
        eq(heartbeatRunEvents.companyId, companyId),
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.issueId, issueIds),
        inArray(heartbeatRunEvents.eventType, TOOL_EVENT_TYPES),
      ))
      .orderBy(asc(heartbeatRunEvents.createdAt), asc(heartbeatRunEvents.id))
      .limit(maxEvents + 1),
    db
      .select({
        id: heartbeatRuns.id,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        retryOfRunId: heartbeatRuns.retryOfRunId,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        continuationAttempt: heartbeatRuns.continuationAttempt,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.issueId, issueIds)))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(MAX_RUNS + 1),
    db
      .select({
        model: costEvents.model,
        costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::double precision`,
        outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::double precision`,
      })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, companyId), inArray(costEvents.issueId, issueIds)))
      .groupBy(costEvents.model),
  ]);

  const truncated = eventRows.length > maxEvents || runRows.length > MAX_RUNS;
  return {
    commands: toolCommandRecordsFromEvents(eventRows.slice(0, maxEvents)),
    runs: runRows.slice(0, MAX_RUNS).map((run) => ({
      id: run.id,
      startedAtMs: toMs(run.startedAt),
      finishedAtMs: toMs(run.finishedAt),
      retryOfRunId: run.retryOfRunId,
      scheduledRetryAttempt: run.scheduledRetryAttempt,
      continuationAttempt: run.continuationAttempt,
    })),
    modelMix: modelRows.map((row) => ({
      model: row.model,
      costCents: Number(row.costCents),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
    })),
    truncated,
  };
}
