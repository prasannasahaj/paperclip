import { useMemo } from "react";
import type { IssueDocumentSummary, IssueTreeDeliverableTask, IssueWorkProduct } from "@paperclipai/shared";
import {
  ArtifactFileRow,
  ArtifactRow,
  fileRowSourceFromWorkProduct,
  subjectFromDocumentSummary,
  subjectFromWorkProduct,
  workProductStateBadge,
} from "@/components/artifacts/v1";
import { StatusIcon } from "@/components/StatusIcon";
import { useIssueTreeDeliverables } from "@/hooks/useIssueTreeDeliverables";
import { artifactUrl } from "@/lib/artifact-card-data";
import { sortTasksNeedingReviewFirst, taskNeedsReview } from "@/lib/issue-tree-deliverables";
import { workProductHref } from "@/lib/issue-artifacts";
import { Link } from "@/lib/router";
import { formatDateTime, issueUrl } from "@/lib/utils";

function WorkProductRow({ workProduct }: { workProduct: IssueWorkProduct }) {
  const subject = subjectFromWorkProduct(workProduct);
  const statusBadge = workProductStateBadge(workProduct);
  const file = fileRowSourceFromWorkProduct(workProduct);
  if (file) {
    return (
      <ArtifactFileRow
        subject={subject}
        source={file}
        statusBadge={statusBadge}
        updatedAtLabel={formatDateTime(workProduct.updatedAt)}
      />
    );
  }
  const href = artifactUrl(workProductHref(workProduct));
  return <ArtifactRow subject={subject} href={href || undefined} external trailing={statusBadge} />;
}

function DocumentRow({ taskPath, document }: { taskPath: string; document: IssueDocumentSummary }) {
  return (
    <ArtifactRow
      subject={subjectFromDocumentSummary(document)}
      to={`${taskPath}#document-${encodeURIComponent(document.key)}`}
    />
  );
}

function TaskGroup({ task }: { task: IssueTreeDeliverableTask }) {
  const taskPath = issueUrl({ id: task.issueId, identifier: task.identifier });
  const headingId = `issue-tree-deliverables-task-${task.issueId}`;
  return (
    <section data-testid="issue-tree-deliverables-task" aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <header className="flex items-center gap-2 px-1">
        <Link id={headingId} to={taskPath} className="flex min-w-0 items-center gap-2 text-xs font-medium text-foreground hover:underline">
          {task.identifier ? <span className="shrink-0 text-muted-foreground">{task.identifier}</span> : null}
          <span className="truncate">{task.title}</span>
        </Link>
        <StatusIcon status={task.status} showLabel />
      </header>
      <ul className="flex flex-col gap-(--artifact-row-gap)">
        {task.workProducts.map((workProduct) => (
          <li key={workProduct.id} className="min-w-0">
            <WorkProductRow workProduct={workProduct} />
          </li>
        ))}
        {task.documents.map((document) => (
          <li key={document.id} className="min-w-0">
            <DocumentRow taskPath={taskPath} document={document} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function IssueTreeDeliverablesSection({ issueId }: { issueId: string }) {
  const { data, isError, refetch } = useIssueTreeDeliverables(issueId);
  const tasks = useMemo(() => sortTasksNeedingReviewFirst(data?.tasks ?? []), [data]);
  const reviewCount = useMemo(() => tasks.filter(taskNeedsReview).length, [tasks]);

  const errorFeedback = isError ? (
    <div role="alert" className="px-1 py-3 text-sm text-muted-foreground">
      Sub-task outputs could not be loaded.
      <button className="ml-2 underline" onClick={() => void refetch()}>
        Retry
      </button>
    </div>
  ) : null;

  const anythingOmitted = data
    ? data.omitted.tasks || data.omitted.workProducts || data.omitted.documents
    : false;

  if (!data || (tasks.length === 0 && !anythingOmitted)) return errorFeedback;

  return (
    <div className="flex flex-col gap-3 py-2">
      {errorFeedback}
      <header className="flex items-baseline justify-between gap-2 px-1">
        <h3 className="text-xs font-medium text-foreground">Sub-task outputs</h3>
        {reviewCount > 0 ? (
          <span className="text-(length:--text-micro) text-muted-foreground">
            {reviewCount} {reviewCount === 1 ? "needs" : "need"} review
          </span>
        ) : null}
      </header>
      {tasks.map((task) => (
        <TaskGroup key={task.issueId} task={task} />
      ))}
      {data.omitted.tasks ? (
        <p className="px-1 text-xs text-muted-foreground">More sub-tasks are not shown.</p>
      ) : null}
      {data.omitted.workProducts || data.omitted.documents ? (
        <p className="px-1 text-xs text-muted-foreground">More outputs are not shown.</p>
      ) : null}
    </div>
  );
}
