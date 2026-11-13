import type { Db } from "@paperclipai/db";
import type { IssueMaturityScorecard } from "@paperclipai/shared";
import { issueTreeIssueIds } from "../costs.js";
import { buildScorecard } from "./build-scorecard.js";
import { loadScorecardInputs } from "./load-scorecard-inputs.js";

export async function loadIssueMaturityScorecard(
  db: Db,
  companyId: string,
  issueId: string,
  options: { excludeRoot: boolean },
): Promise<IssueMaturityScorecard> {
  const issueIds = await issueTreeIssueIds(db, companyId, issueId, options);
  const inputs = await loadScorecardInputs(db, { companyId, issueIds });
  return buildScorecard({ issueId, includeDescendants: true, ...inputs });
}
