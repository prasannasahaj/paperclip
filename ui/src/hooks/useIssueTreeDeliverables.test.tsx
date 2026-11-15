// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueTreeDeliverables } from "@paperclipai/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useIssueTreeDeliverables } from "./useIssueTreeDeliverables";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const deliverables: IssueTreeDeliverables = {
  rootIssueId: "root-issue",
  tasks: [
    {
      issueId: "child-issue",
      identifier: "PAP-2",
      title: "Child task",
      status: "in_progress",
      assigneeAgentId: null,
      depth: 1,
      workProducts: [],
      documents: [],
    },
  ],
  omitted: { tasks: false, workProducts: false, documents: false },
};

let client: QueryClient;
let root: Root;
let host: HTMLDivElement;
let issueId: string | null | undefined;
let observed: ReturnType<typeof useIssueTreeDeliverables>;
let fetchMock: ReturnType<typeof vi.fn>;

function Harness() {
  observed = useIssueTreeDeliverables(issueId);
  return null;
}
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));
}
async function waitFor(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assertion();
  });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  host = document.createElement("div");
  root = createRoot(host);
  fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => deliverables } as Response));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  await act(async () => { root.unmount(); client.clear(); });
  host.remove();
  vi.unstubAllGlobals();
});

it("does not fetch without an issue id", async () => {
  issueId = null;
  await render();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(observed.data).toBeUndefined();
  expect(observed.fetchStatus).toBe("idle");
});

it("fetches tree deliverables for the issue id and exposes tasks", async () => {
  issueId = "root-issue";
  await render();
  await waitFor(() => expect(observed.data?.tasks.map((task) => task.issueId)).toEqual(["child-issue"]));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0][0])).toContain("/issues/root-issue/tree-deliverables");
});
