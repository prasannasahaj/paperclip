import { Router } from "express";
import type { Request, Response } from "express";
import type { Db } from "@paperclipai/db";
import { accessService, issueService } from "../services/index.js";
import { listIssueTreeDeliverables } from "../services/issue-tree-deliverables.js";
import { assertBoardOrAgent, getAccessibleResource, issueNotFoundBody } from "./authz.js";

export function issueTreeDeliverablesRoutes(db: Db) {
  const router = Router();
  const issuesSvc = issueService(db);
  const access = accessService(db);

  async function assertRootReadable(
    req: Request,
    res: Response,
    root: {
      id: string;
      companyId: string;
      projectId?: string | null;
      parentId?: string | null;
      assigneeAgentId?: string | null;
      assigneeUserId?: string | null;
      status?: string;
    },
  ) {
    const decision = await access.decide({
      actor: req.actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: root.companyId,
        issueId: root.id,
        projectId: root.projectId ?? null,
        parentIssueId: root.parentId ?? null,
        assigneeAgentId: root.assigneeAgentId ?? null,
        assigneeUserId: root.assigneeUserId ?? null,
        status: root.status ?? "backlog",
      },
      scope: {
        issueId: root.id,
        projectId: root.projectId ?? null,
        parentIssueId: root.parentId ?? null,
        assigneeAgentId: root.assigneeAgentId ?? null,
        assigneeUserId: root.assigneeUserId ?? null,
      },
    });
    if (decision.allowed) return true;
    res.status(404).json(issueNotFoundBody(req));
    return false;
  }

  router.get("/issues/:id/tree-deliverables", async (req, res) => {
    assertBoardOrAgent(req);
    const root = await getAccessibleResource(
      req,
      res,
      issuesSvc.getById(req.params.id as string),
      "Issue not found",
      issueNotFoundBody(req),
    );
    if (!root) return;
    if (!(await assertRootReadable(req, res, root))) return;
    res.json(
      await listIssueTreeDeliverables(db, {
        companyId: root.companyId,
        rootIssueId: root.id,
        actor: req.actor,
      }),
    );
  });

  return router;
}
