// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IssueDocumentSummary,
  IssueTreeDeliverableTask,
  IssueTreeDeliverables,
  IssueWorkProduct,
} from "@paperclipai/shared";
import { IssueTreeDeliverablesSection } from "./IssueTreeDeliverablesSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface HookState {
  data: IssueTreeDeliverables | undefined;
  isError: boolean;
  refetch: () => void;
}

const hookState = vi.hoisted(() => ({ current: null as unknown as HookState }));
const useIssueTreeDeliverablesMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useIssueTreeDeliverables", () => ({
  useIssueTreeDeliverables: (...args: unknown[]) => {
    useIssueTreeDeliverablesMock(...args);
    return hookState.current;
  },
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
  useLocation: () => ({ hash: "" }),
}));

function pullRequest(id: string, overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
  return {
    id,
    companyId: "company-1",
    projectId: null,
    issueId: "child-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: id,
    title: `Pull request ${id}`,
    url: `https://github.com/paperclipai/paperclip/pull/${id}`,
    status: "active",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: new Date("2026-09-25T10:00:00Z"),
    updatedAt: new Date("2026-09-25T10:00:00Z"),
    ...overrides,
  } as unknown as IssueWorkProduct;
}

function document(key: string): IssueDocumentSummary {
  return {
    id: `doc-${key}`,
    companyId: "company-1",
    issueId: "child-1",
    key,
    title: `Document ${key}`,
    format: "markdown",
    latestRevisionNumber: 1,
    createdByAgentId: null,
    updatedByAgentId: null,
    createdAt: new Date("2026-09-27T08:36:00Z"),
    updatedAt: new Date("2026-09-27T08:36:00Z"),
  } as unknown as IssueDocumentSummary;
}

function task(overrides: Partial<IssueTreeDeliverableTask> = {}): IssueTreeDeliverableTask {
  return {
    issueId: "child-1",
    identifier: "ACM-7",
    title: "Build the checkout",
    status: "in_progress",
    assigneeAgentId: null,
    depth: 1,
    workProducts: [pullRequest("1")],
    documents: [],
    ...overrides,
  };
}

function deliverables(
  tasks: IssueTreeDeliverableTask[],
  omitted: Partial<IssueTreeDeliverables["omitted"]> = {},
): IssueTreeDeliverables {
  return {
    rootIssueId: "root-1",
    tasks,
    omitted: { tasks: false, workProducts: false, documents: false, ...omitted },
  };
}

function setHook(data: IssueTreeDeliverables | undefined, overrides: Partial<HookState> = {}) {
  hookState.current = { data, isError: false, refetch: vi.fn(), ...overrides };
}

describe("IssueTreeDeliverablesSection", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueTreeDeliverablesSection issueId="root-1" />
        </QueryClientProvider>,
      );
    });
  }

  it("renders nothing when tasks is empty", () => {
    setHook(deliverables([]));
    render();
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing while the first load is pending", () => {
    setHook(undefined);
    render();
    expect(container.innerHTML).toBe("");
  });

  it("renders one group per task with identifier, title and status linking to the issue", () => {
    setHook(deliverables([
      task(),
      task({ issueId: "child-2", identifier: "ACM-8", title: "Write the docs", status: "done", workProducts: [pullRequest("2")] }),
    ]));
    render();
    const groups = container.querySelectorAll('[data-testid="issue-tree-deliverables-task"]');
    expect(groups).toHaveLength(2);
    const link = groups[0].querySelector("a[href='/issues/ACM-7']");
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("ACM-7");
    expect(link?.textContent).toContain("Build the checkout");
    expect(groups[0].querySelector("header")?.textContent).toContain("In Progress");
    expect(groups[1].querySelector("header")?.textContent).toContain("Done");
  });

  it("lists work products and documents under their task", () => {
    setHook(deliverables([
      task({ workProducts: [pullRequest("1")], documents: [document("spec")] }),
      task({ issueId: "child-2", identifier: "ACM-8", title: "Other", workProducts: [], documents: [document("notes")] }),
    ]));
    render();
    const groups = container.querySelectorAll('[data-testid="issue-tree-deliverables-task"]');
    expect(groups[0].querySelectorAll("[data-artifact-row]")).toHaveLength(2);
    expect(groups[0].querySelector('a[href="https://github.com/paperclipai/paperclip/pull/1"]')).not.toBeNull();
    expect(groups[0].querySelector('a[href="/issues/ACM-7#document-spec"]')).not.toBeNull();
    expect(groups[1].querySelectorAll("[data-artifact-row]")).toHaveLength(1);
    expect(groups[1].querySelector('a[href="/issues/ACM-8#document-notes"]')).not.toBeNull();
  });

  it("puts tasks needing review first and counts them in the header", () => {
    setHook(deliverables([
      task({ issueId: "child-1", identifier: "ACM-7" }),
      task({
        issueId: "child-2",
        identifier: "ACM-8",
        workProducts: [pullRequest("2", { status: "ready_for_review" })],
      }),
    ]));
    render();
    const groups = container.querySelectorAll('[data-testid="issue-tree-deliverables-task"]');
    expect(groups[0].textContent).toContain("ACM-8");
    expect(container.querySelector("h3")?.textContent).toBe("Sub-task outputs");
    expect(container.textContent).toContain("1 needs review");
  });

  it("shows no review count when nothing needs review", () => {
    setHook(deliverables([task()]));
    render();
    expect(container.textContent).not.toContain("review");
  });

  it("shows a more outputs not shown notice when omitted.workProducts is true", () => {
    setHook(deliverables([task()], { workProducts: true }));
    render();
    expect(container.textContent).toContain("More outputs are not shown");
  });

  it("shows a more outputs not shown notice when omitted.documents is true", () => {
    setHook(deliverables([task()], { documents: true }));
    render();
    expect(container.textContent).toContain("More outputs are not shown");
  });

  it("shows a notice when omitted.tasks is true", () => {
    setHook(deliverables([task()], { tasks: true }));
    render();
    expect(container.textContent).toContain("More sub-tasks are not shown");
    expect(container.textContent).not.toContain("with outputs");
  });

  it("shows the header and the sub-tasks notice when every task was omitted", () => {
    setHook(deliverables([], { tasks: true }));
    render();
    expect(container.textContent).toContain("Sub-task outputs");
    expect(container.textContent).toContain("More sub-tasks are not shown");
    expect(container.querySelectorAll('[data-testid="issue-tree-deliverables-task"]')).toHaveLength(0);
  });

  it("renders nothing when there are no tasks and nothing was omitted", () => {
    setHook(deliverables([]));
    render();
    expect(container.textContent).toBe("");
  });

  it("names each task group after its task link", () => {
    setHook(deliverables([task()]));
    render();
    const group = container.querySelector('[data-testid="issue-tree-deliverables-task"]');
    const labelId = group?.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(window.document.getElementById(labelId as string)?.textContent).toContain("Build the checkout");
  });

  it("shows no notice when nothing was omitted", () => {
    setHook(deliverables([task()]));
    render();
    expect(container.textContent).not.toContain("not shown");
  });

  it("shows an inline error with a retry when the fetch fails with no data", () => {
    const refetch = vi.fn();
    setHook(undefined, { isError: true, refetch });
    render();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Sub-task outputs could not be loaded");
    act(() => {
      (alert?.querySelector("button") as HTMLButtonElement).click();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("renders a 200-output tree without rendering more rows than outputs", () => {
    const tasks = Array.from({ length: 20 }, (_, taskIndex) =>
      task({
        issueId: `child-${taskIndex}`,
        identifier: `ACM-${taskIndex}`,
        title: `Task ${taskIndex}`,
        workProducts: Array.from({ length: 5 }, (_, index) => pullRequest(`${taskIndex}-${index}`)),
        documents: Array.from({ length: 5 }, (_, index) => document(`doc-${taskIndex}-${index}`)),
      }),
    );
    setHook(deliverables(tasks));
    render();
    expect(container.querySelectorAll("[data-artifact-row]")).toHaveLength(200);
    expect(container.querySelectorAll('[data-testid="issue-tree-deliverables-task"]')).toHaveLength(20);
  });

  it("asks the hook for the given issue", () => {
    setHook(deliverables([]));
    render();
    expect(useIssueTreeDeliverablesMock).toHaveBeenCalledWith("root-1");
  });
});
