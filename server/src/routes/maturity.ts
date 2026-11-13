import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { normalizeIssueIdentifier } from "@paperclipai/shared";
import { accessService, issueService } from "../services/index.js";
import { loadIssueMaturityScorecard } from "../services/maturity/issue-maturity-scorecard.js";
import { getAccessibleResource } from "./authz.js";

export function maturityRoutes(db: Db) {
  const router = Router();
  const issues = issueService(db);
  const access = accessService(db);

  async function resolveIssueByRef(rawId: string) {
    const identifier = normalizeIssueIdentifier(rawId);
    return identifier ? issues.getByIdentifier(identifier) : issues.getById(rawId);
  }

  router.get("/issues/:id/maturity-scorecard", async (req, res) => {
    const issue = await getAccessibleResource(req, res, resolveIssueByRef(req.params.id as string), "Issue not found");
    if (!issue) return;
    const decision = await access.decide({
      actor: req.actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: issue.companyId,
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        status: issue.status,
      },
    });
    if (!decision.allowed) {
      res.status(403).json({ error: "Issue maturity is outside this actor's authorization boundary" });
      return;
    }
    const excludeRoot = req.query.excludeRoot === "true" || req.query.excludeRoot === "1";
    res.json(await loadIssueMaturityScorecard(db, issue.companyId, issue.id, { excludeRoot }));
  });

  return router;
}
