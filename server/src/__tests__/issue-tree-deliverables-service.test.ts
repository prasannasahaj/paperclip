import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueDocuments,
  issues,
  issueWorkProducts,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { documentService } from "../services/documents.js";
import type { AuthorizationActor } from "../services/authorization.js";
import {
  listIssueTreeDeliverables,
  TREE_DELIVERABLES_LIMITS,
} from "../services/issue-tree-deliverables.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue tree deliverables tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("listIssueTreeDeliverables", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  const viewerUserId = "tree-viewer-user";
  const strangerUserId = "tree-stranger-user";
  let clock = Date.parse("2026-01-01T00:00:00.000Z");

  beforeAll(async () => {
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-tree-deliverables-");
    db = createDb(tempDb.connectionString);
    const now = new Date();
    await db.insert(authUsers).values([viewerUserId, strangerUserId].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (previousPrivacyMode === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousPrivacyMode;
    await tempDb?.cleanup();
  });

  function boardActor(companyId: string, userId: string): AuthorizationActor {
    return {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: false,
    };
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: viewerUserId,
      status: "active",
      membershipRole: "operator",
    });
    return companyId;
  }

  async function seedIssue(
    companyId: string,
    title: string,
    overrides: Partial<typeof issues.$inferInsert> = {},
  ) {
    const id = randomUUID();
    clock += 1000;
    await db.insert(issues).values({
      id,
      companyId,
      title,
      status: "todo",
      priority: "medium",
      createdAt: new Date(clock),
      ...overrides,
    });
    return id;
  }

  async function seedPrivateIssue(companyId: string, title: string, parentId: string) {
    return seedIssue(companyId, title, {
      parentId,
      visibility: "private",
      responsibleUserId: strangerUserId,
      createdByUserId: strangerUserId,
    });
  }

  async function seedWorkProduct(companyId: string, issueId: string, title: string) {
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title,
      status: "active",
    });
  }

  async function seedDocument(issueId: string, key: string) {
    await documentService(db).upsertIssueDocument({
      issueId,
      key,
      title: key,
      format: "markdown",
      body: `# ${key}`,
      createdByUserId: viewerUserId,
    });
  }

  function deliverables(companyId: string, rootIssueId: string, limits?: Partial<typeof TREE_DELIVERABLES_LIMITS>) {
    return listIssueTreeDeliverables(db, {
      companyId,
      rootIssueId,
      actor: boardActor(companyId, viewerUserId),
      limits,
    });
  }

  it("returns outputs of children and grandchildren grouped by issue with depth 1 and 2", async () => {
    const companyId = await seedCompany();
    const root = await seedIssue(companyId, "Root");
    const child = await seedIssue(companyId, "Child", { parentId: root });
    const grandchild = await seedIssue(companyId, "Grandchild", { parentId: child });
    await seedWorkProduct(companyId, child, "Child artifact");
    await seedDocument(child, "plan");
    await seedDocument(grandchild, "notes");
    await seedWorkProduct(companyId, grandchild, "Grandchild artifact");

    const result = await deliverables(companyId, root);

    expect(result.rootIssueId).toBe(root);
    expect(result.tasks.map((task) => [task.issueId, task.depth])).toEqual([[child, 1], [grandchild, 2]]);
    expect(result.tasks[0]!.workProducts.map((product) => product.title)).toEqual(["Child artifact"]);
    expect(result.tasks[0]!.documents.map((doc) => doc.key)).toEqual(["plan"]);
    expect(result.tasks[1]!.workProducts.map((product) => product.title)).toEqual(["Grandchild artifact"]);
    expect(result.tasks[1]!.documents.map((doc) => doc.key)).toEqual(["notes"]);
    expect(result.tasks[0]).toMatchObject({ title: "Child", status: "todo", assigneeAgentId: null });
    expect(result.omitted).toEqual({ tasks: false, workProducts: false, documents: false });
  });

  it("excludes the root's own outputs", async () => {
    const companyId = await seedCompany();
    const root = await seedIssue(companyId, "Root");
    const child = await seedIssue(companyId, "Child", { parentId: root });
    await seedWorkProduct(companyId, root, "Root artifact");
    await seedDocument(root, "plan");
    await seedWorkProduct(companyId, child, "Child artifact");

    const result = await deliverables(companyId, root);

    expect(result.tasks.map((task) => task.issueId)).toEqual([child]);
  });

  it("omits descendants with no outputs", async () => {
    const companyId = await seedCompany();
    const root = await seedIssue(companyId, "Root");
    const withOutput = await seedIssue(companyId, "With output", { parentId: root });
    await seedIssue(companyId, "Without output", { parentId: root });
    await seedWorkProduct(companyId, withOutput, "Artifact");

    const result = await deliverables(companyId, root);

    expect(result.tasks.map((task) => task.issueId)).toEqual([withOutput]);
  });

  it("omits an unreadable descendant entirely and does not flag omitted", async () => {
    const companyId = await seedCompany();
    const root = await seedIssue(companyId, "Root");
    const readable = await seedIssue(companyId, "Readable", { parentId: root });
    const unreadable = await seedPrivateIssue(companyId, "Private", root);
    await seedWorkProduct(companyId, readable, "Readable artifact");
    await seedWorkProduct(companyId, unreadable, "Restricted artifact");
    await seedDocument(unreadable, "restricted-notes");

    const result = await deliverables(companyId, root);

    expect(result.tasks.map((task) => task.issueId)).toEqual([readable]);
    expect(JSON.stringify(result)).not.toContain("Restricted artifact");
    expect(result.omitted).toEqual({ tasks: false, workProducts: false, documents: false });
  });

  it("does not count unreadable descendants toward omitted.tasks", async () => {
    const companyId = await seedCompany();
    const root = await seedIssue(companyId, "Root");
    const readable = await seedIssue(companyId, "Readable", { parentId: root });
    await seedWorkProduct(companyId, readable, "Readable artifact");
    for (let index = 0; index < 3; index++) {
      const unreadable = await seedPrivateIssue(companyId, `Private ${index}`, root);
      await seedWorkProduct(companyId, unreadable, `Restricted ${index}`);
    }

    const result = await deliverables(companyId, root, { maxTasks: 2 });

    expect(result.tasks.map((task) => task.issueId)).toEqual([readable]);
    expect(result.omitted.tasks).toBe(false);
  });

  it("excludes hidden and harness-kind descendants", async () => {
    const companyId = await seedCompany();
    const root = await seedIssue(companyId, "Root");
    const visible = await seedIssue(companyId, "Visible", { parentId: root });
    const hidden = await seedIssue(companyId, "Hidden", { parentId: root, hiddenAt: new Date() });
    const harness = await seedIssue(companyId, "Harness", { parentId: root, harnessKind: "native_harness" });
    await seedWorkProduct(companyId, visible, "Visible artifact");
    await seedWorkProduct(companyId, hidden, "Hidden artifact");
    await seedWorkProduct(companyId, harness, "Harness artifact");

    const result = await deliverables(companyId, root);

    expect(result.tasks.map((task) => task.issueId)).toEqual([visible]);
  });

  it("terminates on a parent cycle", async () => {
    const companyId = await seedCompany();
    const root = await seedIssue(companyId, "Root");
    const child = await seedIssue(companyId, "Child", { parentId: root });
    const grandchild = await seedIssue(companyId, "Grandchild", { parentId: child });
    await db.update(issues).set({ parentId: grandchild }).where(eq(issues.id, root));
    await seedWorkProduct(companyId, child, "Child artifact");
    await seedWorkProduct(companyId, grandchild, "Grandchild artifact");
    await seedWorkProduct(companyId, root, "Root artifact");

    const result = await deliverables(companyId, root);

    expect(result.tasks.map((task) => task.issueId)).toEqual([child, grandchild]);
    expect(result.omitted.tasks).toBe(false);
  });

  it("a root that is its own parent does not appear as its own sub-task", async () => {
    const companyId = await seedCompany();
    const root = await seedIssue(companyId, "Root");
    const child = await seedIssue(companyId, "Child", { parentId: root });
    await db.update(issues).set({ parentId: root }).where(eq(issues.id, root));
    await seedWorkProduct(companyId, root, "Root artifact");
    await seedWorkProduct(companyId, child, "Child artifact");

    const result = await deliverables(companyId, root);

    expect(result.tasks.map((task) => task.issueId)).toEqual([child]);
  });

  it("reports omitted.tasks when more descendants exist than the task cap", async () => {
    const companyId = await seedCompany();
    const root = await seedIssue(companyId, "Root");
    const cap = 3;
    const children: string[] = [];
    for (let index = 0; index < cap + 1; index++) {
      const child = await seedIssue(companyId, `Child ${index}`, { parentId: root });
      await seedWorkProduct(companyId, child, `Artifact ${index}`);
      children.push(child);
    }

    const capped = await deliverables(companyId, root, { maxTasks: cap });
    const uncapped = await deliverables(companyId, root);

    expect(capped.tasks.map((task) => task.issueId)).toEqual(children.slice(0, cap));
    expect(capped.omitted.tasks).toBe(true);
    expect(uncapped.tasks).toHaveLength(cap + 1);
    expect(uncapped.omitted.tasks).toBe(false);
    expect(TREE_DELIVERABLES_LIMITS.maxTasks).toBeGreaterThan(cap);
  });

  it("does not descend past the depth cap and reports omitted.tasks", async () => {
    const companyId = await seedCompany();
    const root = await seedIssue(companyId, "Root");
    const chain: string[] = [];
    let parentId = root;
    for (let depth = 1; depth <= TREE_DELIVERABLES_LIMITS.maxDepth + 1; depth++) {
      parentId = await seedIssue(companyId, `Level ${depth}`, { parentId });
      await seedWorkProduct(companyId, parentId, `Artifact ${depth}`);
      chain.push(parentId);
    }

    const result = await deliverables(companyId, root);

    expect(result.tasks.map((task) => task.depth)).toEqual(
      Array.from({ length: TREE_DELIVERABLES_LIMITS.maxDepth }, (_, index) => index + 1),
    );
    expect(result.tasks.map((task) => task.issueId)).toEqual(chain.slice(0, TREE_DELIVERABLES_LIMITS.maxDepth));
    expect(result.omitted.tasks).toBe(true);
  });

  it("does not flag omitted.tasks when the tree ends exactly at the depth cap", async () => {
    const companyId = await seedCompany();
    const root = await seedIssue(companyId, "Root");
    let parentId = root;
    for (let depth = 1; depth <= TREE_DELIVERABLES_LIMITS.maxDepth; depth++) {
      parentId = await seedIssue(companyId, `Level ${depth}`, { parentId });
    }
    await seedWorkProduct(companyId, parentId, "Deepest artifact");

    const result = await deliverables(companyId, root);

    expect(result.tasks.map((task) => task.depth)).toEqual([TREE_DELIVERABLES_LIMITS.maxDepth]);
    expect(result.omitted.tasks).toBe(false);
  });

  it("orders tasks by depth then creation time", async () => {
    const companyId = await seedCompany();
    const root = await seedIssue(companyId, "Root");
    const firstChild = await seedIssue(companyId, "First child", { parentId: root });
    const grandchildOfFirst = await seedIssue(companyId, "Grandchild", { parentId: firstChild });
    const secondChild = await seedIssue(companyId, "Second child", { parentId: root });
    for (const issueId of [secondChild, grandchildOfFirst, firstChild]) {
      await seedWorkProduct(companyId, issueId, "Artifact");
    }

    const result = await deliverables(companyId, root);

    expect(result.tasks.map((task) => task.issueId)).toEqual([firstChild, secondChild, grandchildOfFirst]);
  });

  it("caps work products and documents and flags each independently", async () => {
    const companyId = await seedCompany();
    const root = await seedIssue(companyId, "Root");
    const first = await seedIssue(companyId, "First", { parentId: root });
    const second = await seedIssue(companyId, "Second", { parentId: root });
    await seedWorkProduct(companyId, first, "A");
    await seedWorkProduct(companyId, first, "B");
    await seedWorkProduct(companyId, second, "C");
    await seedDocument(second, "plan");

    const result = await deliverables(companyId, root, { maxWorkProducts: 2 });

    expect(result.tasks.flatMap((task) => task.workProducts)).toHaveLength(2);
    expect(result.omitted).toEqual({ tasks: false, workProducts: true, documents: false });
    expect(result.tasks.map((task) => task.issueId)).toEqual([first, second]);
    expect(result.tasks[1]!.documents.map((doc) => doc.key)).toEqual(["plan"]);
  });

  it("keeps each task's documents together when the batched reader interleaves issues", async () => {
    const companyId = await seedCompany();
    const root = await seedIssue(companyId, "Root");
    const first = await seedIssue(companyId, "First", { parentId: root });
    const second = await seedIssue(companyId, "Second", { parentId: root });
    await seedDocument(first, "alpha");
    await seedDocument(second, "alpha");
    await seedDocument(first, "beta");
    await seedDocument(second, "beta");

    const result = await deliverables(companyId, root);

    expect(result.tasks.map((task) => [task.issueId, task.documents.map((doc) => doc.key)])).toEqual([
      [first, ["alpha", "beta"]],
      [second, ["alpha", "beta"]],
    ]);
    expect(result.omitted.documents).toBe(false);
  });

  it("omits a system document on a child while keeping its normal document", async () => {
    const companyId = await seedCompany();
    const root = await seedIssue(companyId, "Root");
    const child = await seedIssue(companyId, "Child", { parentId: root });
    await seedDocument(child, "plan");
    await seedDocument(child, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY);

    const result = await deliverables(companyId, root);

    expect(result.tasks.map((task) => [task.issueId, task.documents.map((doc) => doc.key)])).toEqual([
      [child, ["plan"]],
    ]);
  });

  it("does not return descendants from another company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const root = await seedIssue(companyId, "Root");
    const foreignChild = await seedIssue(otherCompanyId, "Foreign child", { parentId: root });
    await seedWorkProduct(otherCompanyId, foreignChild, "Foreign artifact");

    const result = await deliverables(companyId, root);

    expect(result.tasks).toEqual([]);
  });
});
