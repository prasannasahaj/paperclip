import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { issueTreeIssueIds } from "../costs.js";
import { loadScorecardInputs, toolCommandRecordsFromEvents } from "./load-scorecard-inputs.js";

const RUN_ID = "run-1";
const EXECUTION_ID = "exec-1";

interface ToolEventOptions {
  eventType: "tool.execution.started" | "tool.execution.progressed" | "tool.execution.completed";
  at: string;
  executionId?: string;
  runId?: string;
  name?: string;
  fields?: Record<string, unknown>;
  wrapped?: boolean;
}

function toolEvent(options: ToolEventOptions) {
  const inner = {
    name: options.name ?? "Bash",
    executionId: options.executionId ?? EXECUTION_ID,
    ...options.fields,
  };
  return {
    runId: options.runId ?? RUN_ID,
    eventType: options.eventType,
    createdAt: options.at,
    payload: options.wrapped === false ? inner : { prpEvent: { payload: inner } },
  };
}

function progressed(command: string, at = "2026-01-01T00:00:01.000Z", extra: Partial<ToolEventOptions> = {}) {
  return toolEvent({ eventType: "tool.execution.progressed", at, fields: { subject: command }, ...extra });
}

function completed(
  fields: Record<string, unknown>,
  at = "2026-01-01T00:00:05.000Z",
  extra: Partial<ToolEventOptions> = {},
) {
  return toolEvent({ eventType: "tool.execution.completed", at, fields, ...extra });
}

describe("toolCommandRecordsFromEvents", () => {
  it("joins a progressed and completed event by execution id into a classified record", () => {
    const records = toolCommandRecordsFromEvents([
      progressed("./gradlew test"),
      completed({ exitCode: 1, durationMs: 4200 }),
    ]);

    expect(records).toEqual([
      {
        runId: RUN_ID,
        executionId: EXECUTION_ID,
        kind: "test",
        exitCode: 1,
        durationMs: 4200,
        environmentBlocked: false,
        startedAtMs: Date.parse("2026-01-01T00:00:01.000Z"),
      },
    ]);
  });

  it("excludes a command that has no completed event", () => {
    const records = toolCommandRecordsFromEvents([
      toolEvent({ eventType: "tool.execution.started", at: "2026-01-01T00:00:00.000Z", fields: { subject: null } }),
      progressed("./gradlew test"),
    ]);

    expect(records).toEqual([]);
  });

  it("excludes tools that are not Bash", () => {
    const records = toolCommandRecordsFromEvents([
      progressed("./gradlew test", undefined, { name: "Read" }),
      completed({ exitCode: 0, durationMs: 10 }, undefined, { name: "Read" }),
    ]);

    expect(records).toEqual([]);
  });

  it("drops commands that are not checks", () => {
    const records = toolCommandRecordsFromEvents([
      progressed("ls -la"),
      completed({ exitCode: 0, durationMs: 10 }),
    ]);

    expect(records).toEqual([]);
  });

  it("flags a non-zero exit whose output shows an environment block", () => {
    const records = toolCommandRecordsFromEvents([
      progressed("./gradlew build"),
      completed({ exitCode: 1, durationMs: 900, output: "Could not resolve com.example:lib: AccessDenied" }),
    ]);

    expect(records[0]).toMatchObject({ kind: "build", environmentBlocked: true });
  });

  it("does not flag an environment block when the command succeeded", () => {
    const records = toolCommandRecordsFromEvents([
      progressed("pnpm test"),
      completed({ exitCode: 0, durationMs: 900, output: "403 handled gracefully" }),
    ]);

    expect(records[0]).toMatchObject({ environmentBlocked: false });
  });

  it("reads the output from the progressed event when the completed event has none", () => {
    const records = toolCommandRecordsFromEvents([
      progressed("pnpm test", undefined, { fields: { subject: "pnpm test", output: "Access Denied" } }),
      completed({ exitCode: 2, durationMs: 300, output: "null" }),
    ]);

    expect(records[0]).toMatchObject({ environmentBlocked: true });
  });

  it("uses the last non-empty subject as the command", () => {
    const records = toolCommandRecordsFromEvents([
      progressed("echo starting", "2026-01-01T00:00:01.000Z"),
      progressed("pnpm vitest run", "2026-01-01T00:00:02.000Z"),
      progressed("", "2026-01-01T00:00:03.000Z"),
      completed({ exitCode: 0, durationMs: 10 }),
    ]);

    expect(records[0]).toMatchObject({ kind: "test" });
  });

  it("keeps null exit code and duration for a completed command without them", () => {
    const records = toolCommandRecordsFromEvents([
      progressed("pnpm lint"),
      completed({ exitCode: null, durationMs: null }),
    ]);

    expect(records[0]).toMatchObject({ kind: "lint", exitCode: null, durationMs: null, environmentBlocked: false });
  });

  it("reads fields placed directly on the payload by other adapters", () => {
    const records = toolCommandRecordsFromEvents([
      progressed("tsc --noEmit", undefined, { wrapped: false }),
      completed({ exitCode: 0, durationMs: 1500 }, undefined, { wrapped: false }),
    ]);

    expect(records).toMatchObject([{ kind: "typecheck", exitCode: 0, durationMs: 1500 }]);
  });

  it("starts a command at its earliest event and keeps executions in different runs apart", () => {
    const records = toolCommandRecordsFromEvents([
      progressed("pnpm test", "2026-01-01T00:00:09.000Z", { runId: "run-2" }),
      completed({ exitCode: 0, durationMs: 5 }, "2026-01-01T00:00:10.000Z", { runId: "run-2" }),
      toolEvent({ eventType: "tool.execution.started", at: "2026-01-01T00:00:00.000Z" }),
      progressed("pnpm test", "2026-01-01T00:00:01.000Z"),
      completed({ exitCode: 1, durationMs: 7 }, "2026-01-01T00:00:02.000Z"),
    ]);

    const byRun = Object.fromEntries(records.map((record) => [record.runId, record]));
    expect(records).toHaveLength(2);
    expect(byRun["run-1"]).toMatchObject({ exitCode: 1, startedAtMs: Date.parse("2026-01-01T00:00:00.000Z") });
    expect(byRun["run-2"]).toMatchObject({ exitCode: 0, startedAtMs: Date.parse("2026-01-01T00:00:09.000Z") });
  });

  it("accepts Date and ISO string timestamps", () => {
    const at = new Date("2026-01-01T00:00:01.000Z");
    const records = toolCommandRecordsFromEvents([
      { ...progressed("pnpm test"), createdAt: at },
      completed({ exitCode: 0, durationMs: 1 }),
    ]);

    expect(records[0]?.startedAtMs).toBe(at.getTime());
  });

  it("ignores events whose payload is not an object", () => {
    const records = toolCommandRecordsFromEvents([
      { runId: RUN_ID, eventType: "tool.execution.progressed", createdAt: new Date(), payload: null },
      { runId: RUN_ID, eventType: "tool.execution.completed", createdAt: new Date(), payload: "text" },
    ]);

    expect(records).toEqual([]);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("loadScorecardInputs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-maturity-inputs-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "active",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(companyId: string, parentId: string | null = null) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, parentId, title: "Issue", status: "todo" });
    return id;
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    issueId: string,
    extra: Partial<typeof heartbeatRuns.$inferInsert> = {},
  ) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      issueId,
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      finishedAt: new Date("2026-01-01T00:01:00.000Z"),
      ...extra,
    });
    return id;
  }

  async function seedEvents(
    companyId: string,
    agentId: string,
    runId: string,
    events: Array<{ eventType: string; payload: Record<string, unknown>; at?: string }>,
  ) {
    let seq = 0;
    for (const event of events) {
      seq += 1;
      await db.insert(heartbeatRunEvents).values({
        companyId,
        agentId,
        runId,
        seq,
        eventType: event.eventType,
        payload: event.payload,
        createdAt: new Date(event.at ?? `2026-01-01T00:00:0${seq}.000Z`),
      });
    }
  }

  function testCommandEvents(executionId: string, exitCode: number, command = "pnpm test") {
    return [
      { eventType: "tool.execution.started", payload: { prpEvent: { payload: { name: "Bash", executionId, subject: null } } } },
      { eventType: "tool.execution.progressed", payload: { prpEvent: { payload: { name: "Bash", executionId, subject: command } } } },
      { eventType: "tool.execution.completed", payload: { prpEvent: { payload: { name: "Bash", executionId, exitCode, durationMs: 1200 } } } },
    ];
  }

  it("loads classified commands, runs and model mix for the given issues", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue(companyId);
    const retryOf = await seedRun(companyId, agentId, issueId);
    const runId = await seedRun(companyId, agentId, issueId, { retryOfRunId: retryOf, scheduledRetryAttempt: 1 });
    await seedEvents(companyId, agentId, runId, testCommandEvents("exec-a", 1));
    await db.insert(costEvents).values([
      { companyId, agentId, issueId, heartbeatRunId: runId, provider: "anthropic", model: "sonnet", inputTokens: 100, outputTokens: 10, costCents: 5, occurredAt: new Date() },
      { companyId, agentId, issueId, heartbeatRunId: runId, provider: "anthropic", model: "sonnet", inputTokens: 50, outputTokens: 5, costCents: 3, occurredAt: new Date() },
      { companyId, agentId, issueId, heartbeatRunId: runId, provider: "anthropic", model: "haiku", inputTokens: 10, outputTokens: 1, costCents: 1, occurredAt: new Date() },
    ]);

    const inputs = await loadScorecardInputs(db, { companyId, issueIds: [issueId] });

    expect(inputs.truncated).toBe(false);
    expect(inputs.commands).toMatchObject([{ runId, executionId: "exec-a", kind: "test", exitCode: 1, durationMs: 1200 }]);
    expect(inputs.runs.find((run) => run.id === runId)).toEqual({
      id: runId,
      startedAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
      finishedAtMs: Date.parse("2026-01-01T00:01:00.000Z"),
      retryOfRunId: retryOf,
      scheduledRetryAttempt: 1,
      continuationAttempt: 0,
    });
    expect(inputs.runs).toHaveLength(2);
    expect([...inputs.modelMix].sort((left, right) => left.model.localeCompare(right.model))).toEqual([
      { model: "haiku", costCents: 1, inputTokens: 10, outputTokens: 1 },
      { model: "sonnet", costCents: 8, inputTokens: 150, outputTokens: 15 },
    ]);
  });

  it("ignores runs, events and costs of other issues and other companies", async () => {
    const { companyId, agentId } = await seedCompany();
    const other = await seedCompany();
    const issueId = await seedIssue(companyId);
    const unrelatedIssueId = await seedIssue(companyId);
    const foreignIssueId = await seedIssue(other.companyId);
    const unrelatedRun = await seedRun(companyId, agentId, unrelatedIssueId);
    const foreignRun = await seedRun(other.companyId, other.agentId, foreignIssueId);
    await seedEvents(companyId, agentId, unrelatedRun, testCommandEvents("exec-u", 0));
    await seedEvents(other.companyId, other.agentId, foreignRun, testCommandEvents("exec-f", 0));
    await db.insert(costEvents).values({
      companyId: other.companyId, agentId: other.agentId, issueId: foreignIssueId, provider: "anthropic",
      model: "foreign-model", costCents: 9, occurredAt: new Date(),
    });

    const scoped = await loadScorecardInputs(db, { companyId, issueIds: [issueId] });
    const crossCompany = await loadScorecardInputs(db, { companyId, issueIds: [foreignIssueId] });

    expect(scoped).toEqual({ commands: [], runs: [], modelMix: [], truncated: false });
    expect(crossCompany).toEqual({ commands: [], runs: [], modelMix: [], truncated: false });
  });

  it("selects only progressed and completed tool events", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue(companyId);
    const runId = await seedRun(companyId, agentId, issueId);
    await seedEvents(companyId, agentId, runId, [
      ...testCommandEvents("exec-a", 0),
      { eventType: "lifecycle", payload: { message: "noise" } },
      { eventType: "item.completed", payload: { prpEvent: { payload: { kind: "usage" } } } },
    ]);

    const eventLimit = 2;
    const inputs = await loadScorecardInputs(db, { companyId, issueIds: [issueId], maxEvents: eventLimit });

    expect(inputs.truncated).toBe(false);
    expect(inputs.commands).toHaveLength(1);
  });

  it("marks the inputs truncated when the event cap is exceeded", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue(companyId);
    const runId = await seedRun(companyId, agentId, issueId);
    await seedEvents(companyId, agentId, runId, [
      ...testCommandEvents("exec-a", 0),
      ...testCommandEvents("exec-b", 0).map((event, index) => ({ ...event, at: `2026-01-01T00:01:0${index}.000Z` })),
    ]);

    const eventLimit = 3;
    const inputs = await loadScorecardInputs(db, { companyId, issueIds: [issueId], maxEvents: eventLimit });

    expect(inputs.truncated).toBe(true);
  });

  it("returns empty inputs without querying when no issue ids are given", async () => {
    const { companyId } = await seedCompany();

    const inputs = await loadScorecardInputs(db, { companyId, issueIds: [] });

    expect(inputs).toEqual({ commands: [], runs: [], modelMix: [], truncated: false });
  });

  it("expands an issue tree with or without its root", async () => {
    const { companyId } = await seedCompany();
    const rootId = await seedIssue(companyId);
    const childId = await seedIssue(companyId, rootId);
    const grandchildId = await seedIssue(companyId, childId);

    const withRoot = await issueTreeIssueIds(db, companyId, rootId, { excludeRoot: false });
    const withoutRoot = await issueTreeIssueIds(db, companyId, rootId, { excludeRoot: true });

    expect([...withRoot].sort()).toEqual([rootId, childId, grandchildId].sort());
    expect([...withoutRoot].sort()).toEqual([childId, grandchildId].sort());
  });
});
