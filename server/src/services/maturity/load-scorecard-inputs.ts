import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import type { ModelMixEntry } from "@paperclipai/shared";
import { displayedCostCents, ordinaryInputTokens } from "../costs.js";
import { classifyCommand } from "./classify-command.js";
import type { RunRecord, ToolCommandRecord } from "./build-scorecard.js";

export const MAX_EVENTS = 20_000;
export const MAX_RUNS = 2_000;
export const OUTPUT_TAIL_CHARS = 4_000;

const SHELL_TOOL_NAME = "Bash";
const PROCESS_TRANSPORT = "process";
const EXECUTE_OPERATION = "execute";
const OPENCODE_SHELL_TOOL_NAME = "bash";
const COMPLETED_EVENT_TYPE = "tool.execution.completed";
const TOOL_EVENT_TYPES = ["tool.execution.progressed", COMPLETED_EVENT_TYPE];
const ENVIRONMENT_BLOCK_PATTERNS: readonly RegExp[] = [
  /\bAccessDenied\b/,
  /Access Denied[^\n]*(?:Status Code: 403|Service: Amazon S3)/i,
  /\b403 Forbidden\b/i,
  /\bstatus code:? 403\b/i,
  /Could not resolve all (?:files|dependencies)/i,
  /Unable to locate credentials/i,
  /\bExpiredToken\b/,
];
const NULL_OUTPUT_LITERAL = "null";

export interface ToolEventRow {
  runId: string;
  eventType: string;
  payload: unknown;
  createdAt: Date | string;
}

export interface ShellEventSummary {
  commands: ToolCommandRecord[];
  shellCommandsObserved: number;
}

export interface ScorecardInputs extends ShellEventSummary {
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

function processExecutionCommand(fields: Record<string, unknown>): string | null {
  if (fields.transport !== PROCESS_TRANSPORT || fields.operation !== EXECUTE_OPERATION) return null;
  const name = nonEmptyString(fields.name);
  return name === OPENCODE_SHELL_TOOL_NAME ? null : name;
}

function absorbEvent(execution: ExecutionAccumulator, eventType: string, fields: Record<string, unknown>) {
  if (fields.name === SHELL_TOOL_NAME) execution.isShell = true;
  const processCommand = processExecutionCommand(fields);
  if (processCommand !== null) {
    execution.isShell = true;
    execution.command = processCommand;
  }
  const subject = nonEmptyString(fields.subject);
  if (subject !== null) execution.command = subject;
  if (eventType === COMPLETED_EVENT_TYPE) {
    const output = outputText(fields.output);
    if (output !== null) execution.outputs.push(output);
    execution.completed = true;
    execution.exitCode = numberOrNull(fields.exitCode);
    execution.durationMs = numberOrNull(fields.durationMs);
  }
}

function isEnvironmentBlocked(execution: ExecutionAccumulator): boolean {
  return (
    execution.exitCode !== null &&
    execution.exitCode !== 0 &&
    ENVIRONMENT_BLOCK_PATTERNS.some((pattern) => pattern.test(execution.outputs.join("\n")))
  );
}

function isObservedShellExecution(execution: ExecutionAccumulator): boolean {
  return execution.isShell && execution.completed;
}

function toRecord(execution: ExecutionAccumulator): ToolCommandRecord | null {
  if (!isObservedShellExecution(execution) || execution.command === null) return null;
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

export function toolCommandRecordsFromEvents(events: ToolEventRow[]): ShellEventSummary {
  const executions = new Map<string, ExecutionAccumulator>();
  for (const event of events) {
    const fields = toolFields(event.payload);
    const executionId = fields ? nonEmptyString(fields.executionId) : null;
    if (!fields || executionId === null) continue;
    const startedAtMs = new Date(event.createdAt).getTime();
    absorbEvent(accumulatorFor(executions, event.runId, executionId, startedAtMs), event.eventType, fields);
  }
  const observed = [...executions.values()].filter(isObservedShellExecution);
  return {
    commands: observed.flatMap((execution) => {
      const record = toRecord(execution);
      return record ? [record] : [];
    }),
    shellCommandsObserved: observed.length,
  };
}

function shellToolEventsQuery(companyId: string, issueIds: string[], limit: number) {
  const payload = heartbeatRunEvents.payload;
  const nestedFields = sql`${payload} -> 'prpEvent' -> 'payload'`;
  const toolFieldsJson = sql`case
    when jsonb_typeof(${nestedFields}) = 'object' then ${nestedFields}
    when jsonb_typeof(${payload}) = 'object' then ${payload}
    else '{}'::jsonb end`;
  return sql`
    SELECT
      ${heartbeatRunEvents.runId} AS "runId",
      ${heartbeatRunEvents.eventType} AS "eventType",
      ${heartbeatRunEvents.createdAt} AS "createdAt",
      jsonb_build_object(
        'name', tool.name,
        'subject', tool.subject,
        'executionId', tool."executionId",
        'exitCode', tool."exitCode",
        'durationMs', tool."durationMs",
        'transport', tool.transport,
        'operation', tool.operation,
        'output', case when ${heartbeatRunEvents.eventType} = ${COMPLETED_EVENT_TYPE}
          then right(tool.output, ${OUTPUT_TAIL_CHARS}::int) end
      ) AS payload
    FROM ${heartbeatRunEvents}
    INNER JOIN ${heartbeatRuns} ON ${heartbeatRuns.id} = ${heartbeatRunEvents.runId}
    CROSS JOIN LATERAL jsonb_to_record(${toolFieldsJson}) AS tool(
      name text, subject text, "executionId" text, "exitCode" jsonb, "durationMs" jsonb,
      transport text, operation text, output text
    )
    WHERE ${and(
      eq(heartbeatRunEvents.companyId, companyId),
      eq(heartbeatRuns.companyId, companyId),
      inArray(heartbeatRuns.issueId, issueIds),
      inArray(heartbeatRunEvents.eventType, TOOL_EVENT_TYPES),
    )}
      AND (
        tool.name = ${SHELL_TOOL_NAME}
        OR (tool.transport = ${PROCESS_TRANSPORT} AND tool.operation = ${EXECUTE_OPERATION}
          AND tool.name IS DISTINCT FROM ${OPENCODE_SHELL_TOOL_NAME})
      )
    ORDER BY ${heartbeatRunEvents.createdAt} ASC, ${heartbeatRunEvents.id} ASC
    LIMIT ${limit}::int
  `;
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
  if (issueIds.length === 0) {
    return { commands: [], shellCommandsObserved: 0, runs: [], modelMix: [], truncated: false };
  }

  const [eventResult, runRows, modelRows] = await Promise.all([
    db.execute(shellToolEventsQuery(companyId, issueIds, maxEvents + 1)),
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
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.issueId, issueIds),
        isNotNull(heartbeatRuns.startedAt),
      ))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(MAX_RUNS + 1),
    db
      .select({
        model: costEvents.model,
        costCents: displayedCostCents,
        inputTokens: sql<number>`coalesce(sum(${ordinaryInputTokens}), 0)::double precision`,
        outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::double precision`,
      })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, companyId), inArray(costEvents.issueId, issueIds)))
      .groupBy(costEvents.model),
  ]);

  const eventRows = Array.from(eventResult) as unknown as ToolEventRow[];
  const truncated = eventRows.length > maxEvents || runRows.length > MAX_RUNS;
  return {
    ...toolCommandRecordsFromEvents(eventRows.slice(0, maxEvents)),
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
