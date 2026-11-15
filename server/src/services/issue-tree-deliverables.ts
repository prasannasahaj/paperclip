import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type {
  IssueDocumentSummary,
  IssueTreeDeliverables,
  IssueTreeDeliverableTask,
  IssueWorkProduct,
} from "@paperclipai/shared";
import { authorizationService, issueReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { documentService } from "./documents.js";
import { workProductService } from "./work-products.js";

export interface TreeDeliverablesLimits {
  maxDepth: number;
  maxTasks: number;
  maxWorkProducts: number;
  maxDocuments: number;
}

export const TREE_DELIVERABLES_LIMITS: TreeDeliverablesLimits = {
  maxDepth: 8,
  maxTasks: 500,
  maxWorkProducts: 200,
  maxDocuments: 200,
};

type DescendantRow = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  depth: number;
};

async function readDescendantCandidates(
  db: Db,
  input: { companyId: string; rootIssueId: string; actor: AuthorizationActor },
  limits: TreeDeliverablesLimits,
): Promise<DescendantRow[]> {
  const readCondition = await issueReadSqlCondition(db, input.actor);
  const rows = await db.execute(sql`
    WITH RECURSIVE descendants(id, depth, path) AS (
      SELECT child.id, 1, ARRAY[${input.rootIssueId}::uuid, child.id]
      FROM issues child
      WHERE child.company_id = ${input.companyId}
        AND child.parent_id = ${input.rootIssueId}
        AND child.id <> ${input.rootIssueId}
        AND child.hidden_at IS NULL
        AND child.harness_kind IS NULL
      UNION ALL
      SELECT child.id, descendants.depth + 1, descendants.path || child.id
      FROM issues child
      JOIN descendants ON child.parent_id = descendants.id
      WHERE child.company_id = ${input.companyId}
        AND child.hidden_at IS NULL
        AND child.harness_kind IS NULL
        AND NOT child.id = ANY(descendants.path)
        AND descendants.depth <= ${limits.maxDepth}
    )
    SELECT
      issues.id::text AS "id",
      issues.identifier AS "identifier",
      issues.title AS "title",
      issues.status AS "status",
      issues.assignee_agent_id::text AS "assigneeAgentId",
      descendants.depth::int AS "depth"
    FROM descendants
    JOIN issues ON issues.id = descendants.id
    WHERE ${readCondition}
    ORDER BY descendants.depth, issues.created_at, issues.id
    LIMIT ${limits.maxTasks + 1}
  `);
  return Array.from(rows as Iterable<DescendantRow>);
}

async function readableDescendants(
  db: Db,
  input: { companyId: string; rootIssueId: string; actor: AuthorizationActor },
  limits: TreeDeliverablesLimits,
): Promise<{ tasks: DescendantRow[]; omitted: boolean }> {
  const candidates = await readDescendantCandidates(db, input, limits);
  const decisions = await authorizationService(db).decideReads(
    input.actor,
    candidates.map((candidate) => ({ type: "issue" as const, companyId: input.companyId, issueId: candidate.id })),
  );
  const readable = candidates.filter((_, index) => decisions[index]?.allowed);
  const withinDepth = readable.filter((candidate) => candidate.depth <= limits.maxDepth);
  const omitted = readable.length > withinDepth.length || withinDepth.length > limits.maxTasks;
  return { tasks: withinDepth.slice(0, limits.maxTasks), omitted };
}

function groupByIssue<T extends { issueId: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const group = grouped.get(row.issueId);
    if (group) group.push(row);
    else grouped.set(row.issueId, [row]);
  }
  return grouped;
}

function takeWithinBudget<T>(
  tasks: DescendantRow[],
  grouped: Map<string, T[]>,
  budget: number,
): { byIssue: Map<string, T[]>; omitted: boolean } {
  const byIssue = new Map<string, T[]>();
  let remaining = budget;
  let omitted = false;
  for (const task of tasks) {
    const items = grouped.get(task.id) ?? [];
    const taken = items.slice(0, Math.max(0, remaining));
    remaining -= taken.length;
    if (taken.length < items.length) omitted = true;
    byIssue.set(task.id, taken);
  }
  return { byIssue, omitted };
}

export async function listIssueTreeDeliverables(
  db: Db,
  input: {
    companyId: string;
    rootIssueId: string;
    actor: AuthorizationActor;
    limits?: Partial<TreeDeliverablesLimits>;
  },
): Promise<IssueTreeDeliverables> {
  const limits: TreeDeliverablesLimits = { ...TREE_DELIVERABLES_LIMITS, ...input.limits };
  const { tasks, omitted: omittedTasks } = await readableDescendants(db, input, limits);
  if (tasks.length === 0) {
    return {
      rootIssueId: input.rootIssueId,
      tasks: [],
      omitted: { tasks: omittedTasks, workProducts: false, documents: false },
    };
  }

  const taskIds = tasks.map((task) => task.id);
  const [workProductRows, documentRows] = await Promise.all([
    workProductService(db).listForIssues(input.companyId, taskIds),
    documentService(db).listIssueDocumentSummariesForIssues(input.companyId, taskIds) as Promise<IssueDocumentSummary[]>,
  ]);
  const workProducts = takeWithinBudget<IssueWorkProduct>(tasks, groupByIssue(workProductRows), limits.maxWorkProducts);
  const documents = takeWithinBudget<IssueDocumentSummary>(tasks, groupByIssue(documentRows), limits.maxDocuments);

  const deliverableTasks: IssueTreeDeliverableTask[] = tasks
    .map((task) => ({
      issueId: task.id,
      identifier: task.identifier,
      title: task.title,
      status: task.status,
      assigneeAgentId: task.assigneeAgentId,
      depth: task.depth,
      workProducts: workProducts.byIssue.get(task.id) ?? [],
      documents: documents.byIssue.get(task.id) ?? [],
    }))
    .filter((task) => task.workProducts.length > 0 || task.documents.length > 0);

  return {
    rootIssueId: input.rootIssueId,
    tasks: deliverableTasks,
    omitted: {
      tasks: omittedTasks,
      workProducts: workProducts.omitted,
      documents: documents.omitted,
    },
  };
}
