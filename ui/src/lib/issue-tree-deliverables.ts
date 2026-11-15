import type { IssueTreeDeliverableTask, IssueWorkProduct } from "@paperclipai/shared";

function workProductNeedsReview(workProduct: Pick<IssueWorkProduct, "status" | "reviewState">): boolean {
  return workProduct.reviewState === "needs_board_review" || workProduct.status === "ready_for_review";
}

export function taskNeedsReview(task: IssueTreeDeliverableTask): boolean {
  return task.workProducts.some(workProductNeedsReview);
}

export function sortTasksNeedingReviewFirst(tasks: IssueTreeDeliverableTask[]): IssueTreeDeliverableTask[] {
  const needingReview: IssueTreeDeliverableTask[] = [];
  const others: IssueTreeDeliverableTask[] = [];
  for (const task of tasks) {
    (taskNeedsReview(task) ? needingReview : others).push(task);
  }
  return [...needingReview, ...others];
}
