import { describe, expect, it } from "vitest";
import type { IssueTreeDeliverableTask, IssueWorkProduct } from "@paperclipai/shared";
import { sortTasksNeedingReviewFirst, taskNeedsReview } from "./issue-tree-deliverables";

function workProduct(overrides: Partial<IssueWorkProduct>): IssueWorkProduct {
  return {
    id: "wp",
    status: "active",
    reviewState: "none",
    ...overrides,
  } as IssueWorkProduct;
}

function task(issueId: string, workProducts: IssueWorkProduct[]): IssueTreeDeliverableTask {
  return {
    issueId,
    identifier: issueId.toUpperCase(),
    title: `Task ${issueId}`,
    status: "in_progress",
    assigneeAgentId: null,
    depth: 1,
    workProducts,
    documents: [],
  };
}

describe("taskNeedsReview", () => {
  it("is true for needs_board_review", () => {
    expect(taskNeedsReview(task("a", [workProduct({ reviewState: "needs_board_review" })]))).toBe(true);
  });

  it("is true for ready_for_review", () => {
    expect(taskNeedsReview(task("a", [workProduct({ status: "ready_for_review" })]))).toBe(true);
  });

  it("is false for approved and merged", () => {
    const settled = task("a", [
      workProduct({ id: "wp-1", status: "approved", reviewState: "approved" }),
      workProduct({ id: "wp-2", status: "merged" }),
    ]);
    expect(taskNeedsReview(settled)).toBe(false);
  });

  it("is false for a task with only documents", () => {
    expect(taskNeedsReview(task("a", []))).toBe(false);
  });
});

describe("sortTasksNeedingReviewFirst", () => {
  it("keeps server order within each group", () => {
    const review = workProduct({ status: "ready_for_review" });
    const tasks = [
      task("a", []),
      task("b", [review]),
      task("c", []),
      task("d", [review]),
      task("e", []),
    ];
    expect(sortTasksNeedingReviewFirst(tasks).map((entry) => entry.issueId)).toEqual(["b", "d", "a", "c", "e"]);
  });

  it("does not mutate its input", () => {
    const tasks = [task("a", []), task("b", [workProduct({ status: "ready_for_review" })])];
    sortTasksNeedingReviewFirst(tasks);
    expect(tasks.map((entry) => entry.issueId)).toEqual(["a", "b"]);
  });
});
