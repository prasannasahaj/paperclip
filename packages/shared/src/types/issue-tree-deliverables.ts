import type { IssueDocumentSummary } from "./issue.js";
import type { IssueWorkProduct } from "./work-product.js";

export interface IssueTreeDeliverableTask {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  depth: number;
  workProducts: IssueWorkProduct[];
  documents: IssueDocumentSummary[];
}

export interface IssueTreeDeliverables {
  rootIssueId: string;
  tasks: IssueTreeDeliverableTask[];
  omitted: { tasks: boolean; workProducts: boolean; documents: boolean };
}
