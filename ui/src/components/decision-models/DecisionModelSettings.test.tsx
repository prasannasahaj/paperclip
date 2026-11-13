// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/api/client";
import { decisionModelsApi } from "@/api/decision-models";
import { aiConnectionsApi } from "@/api/ai-connections";
import { agentsApi } from "@/api/agents";
import type { DecisionConnectionChoice, DecisionResult } from "@paperclipai/shared";
import { DecisionModelSettingsSection, DecisionModelSettingsView } from "./DecisionModelSettings";
import { choices, configured, result } from "../../../storybook/support/decision-models/fixtures";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-storybook" }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("consumes an added connection once and preserves a later choice across refetches", async () => {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container), onSave = vi.fn();
  const settings = { ...configured, allowBackground: false };
  const render = (refreshed = false) => <MemoryRouter><DecisionModelSettingsView settings={{ ...settings }}
    choices={choices.map(row => ({ ...row, name: refreshed ? `${row.name} refreshed` : row.name }))}
    newlyConnectedId={choices[0]!.id} onSave={onSave} onTest={vi.fn()} onAdd={vi.fn()} /></MemoryRouter>;
  try {
    await act(async () => root.render(render()));
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Company OpenRouter"))!.click());
    await act(async () => root.render(render(true)));
    expect(container.querySelector('[aria-pressed="true"]')?.textContent).toContain("Company OpenRouter refreshed");
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Save decision model")!.click());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ connectionId: choices[1]!.id, grantId: choices[1]!.grantId, allowBackground: false }));
  } finally { act(() => root.unmount()); container.remove(); }
});

it("clears test feedback when another manager changes the saved configuration", async () => {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const key = ["decision-model", configured.companyId];
  client.setQueryData(key, { canManage: true, settings: configured, choices });
  const test = vi.spyOn(decisionModelsApi, "test").mockResolvedValue(result);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter>
      <DecisionModelSettingsSection companyId={configured.companyId} />
    </MemoryRouter></QueryClientProvider>));
    await act(async () => {
      [...container.querySelectorAll("button")].find(button => button.textContent === "Run test")!.click();
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(container.textContent).toContain("Decision model is working");
    await act(async () => {
      client.setQueryData(key, { canManage: true, settings: { ...configured, enabled: false }, choices });
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(container.textContent).not.toContain("Decision model is working");
    await act(async () => {
      client.setQueryData(key, { canManage: true, settings: configured, choices });
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(container.textContent).not.toContain("Decision model is working");
  } finally { act(() => root.unmount()); client.clear(); test.mockRestore(); container.remove(); }
});

it("keeps loaded decision settings on screen when a refetch fails transiently", async () => {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = ["decision-model", configured.companyId];
  client.setQueryData(key, { canManage: true, settings: configured, choices });
  const settings = vi.spyOn(decisionModelsApi, "settings").mockRejectedValue(
    new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" }),
  );
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter>
      <DecisionModelSettingsSection companyId={configured.companyId} />
    </MemoryRouter></QueryClientProvider>));
    expect(container.textContent).toContain("Enable decisions");
    await act(async () => {
      await client.invalidateQueries({ queryKey: key });
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(settings).toHaveBeenCalled();
    expect(container.textContent).toContain("Enable decisions");
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
    expect(container.textContent).not.toContain("Paperclip is restarting.");
    expect(container.textContent).not.toContain("tenant_app_unavailable");
  } finally { act(() => root.unmount()); client.clear(); settings.mockRestore(); container.remove(); }
});

it("shows readable copy and Retry when decision settings fail to load", async () => {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const settings = vi.spyOn(decisionModelsApi, "settings")
    .mockRejectedValueOnce(new ApiError("Boom", 500, { error: "Boom" }))
    .mockResolvedValue({ canManage: true, settings: configured, choices });
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter>
      <DecisionModelSettingsSection companyId={configured.companyId} />
    </MemoryRouter></QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector('[data-query-view="error"]')).not.toBeNull();
    expect(container.textContent).toContain("Couldn't load decision settings");
    expect(container.textContent).not.toContain("Enable decisions");
    const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "Retry");
    expect(retry, "Retry button").toBeTruthy();
    await act(async () => {
      retry!.click();
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(container.textContent).toContain("Enable decisions");
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
  } finally { act(() => root.unmount()); client.clear(); settings.mockRestore(); container.remove(); }
});

const localChoice: DecisionConnectionChoice = {
  ...choices[0]!,
  id: "10000000-0000-4000-8000-000000000003", grantId: "20000000-0000-4000-8000-000000000003",
  name: "Company D3", decisionModel: "d3:9b",
  routing: { kind: "local", protocol: "chat", baseUrl: "http://localhost:11434/v1", auth: "none", models: [] },
};

async function renderView(root: ReturnType<typeof createRoot>, props: Partial<Parameters<typeof DecisionModelSettingsView>[0]>) {
  await act(async () => root.render(<MemoryRouter><DecisionModelSettingsView settings={configured} choices={[...choices, localChoice]}
    onSave={vi.fn()} onTest={vi.fn()} onAdd={vi.fn()} {...props} /></MemoryRouter>));
}

it("labels a local endpoint choice as running locally instead of OpenAI", async () => {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await renderView(root, {});
    const row = container.querySelector('button[aria-label="Company D3"]')!;
    expect(row.textContent).toContain("d3:9b · Connected · runs locally");
    expect(container.querySelector('button[aria-label="Company OpenAI"]')!.textContent).not.toContain("runs locally");
    await renderView(root, { choices: [{ ...localChoice, status: "needs_attention" }] });
    expect(container.querySelector('button[aria-label="Company D3"]')!.textContent).toContain("d3:9b · Needs attention · runs locally");
  } finally { act(() => root.unmount()); container.remove(); }
});

it("mentions a local Ollama connection in the empty state and the incompatible connection message", async () => {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const incompatible: DecisionResult = { status: "unavailable", reason: "incompatible_connection" };
  try {
    await renderView(root, { choices: [] });
    expect(container.textContent).toContain("local Ollama endpoint");
    await renderView(root, { result: incompatible });
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("local Ollama endpoint");
  } finally { act(() => root.unmount()); container.remove(); }
});

it("offers Ollama in the Add dialog and sets it up as a local endpoint", async () => {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["decision-model", configured.companyId], { canManage: true, settings: configured, choices });
  const connections = vi.spyOn(aiConnectionsApi, "list").mockResolvedValue({ currentUserId: "user-board", canManageConnections: true, connections: [] });
  const agents = vi.spyOn(agentsApi, "list").mockResolvedValue([]);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter>
      <DecisionModelSettingsSection companyId={configured.companyId} />
    </MemoryRouter></QueryClientProvider>));
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Add connection")!.click());
    const ollama = document.body.querySelector('button[aria-label="Ollama (local)"]')!;
    expect(ollama.textContent).toContain("D3 9B");
    await act(async () => { (ollama as HTMLButtonElement).click(); await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(document.body.querySelector('input[aria-label="Provider URL"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Connect Local endpoint");
  } finally { act(() => root.unmount()); client.clear(); connections.mockRestore(); agents.mockRestore(); container.remove(); }
});

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("tells the user when a saved local endpoint cannot be used for decisions", async () => {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["decision-model", configured.companyId], { canManage: true, settings: configured, choices });
  const connections = vi.spyOn(aiConnectionsApi, "list").mockResolvedValue({ currentUserId: "user-board", canManageConnections: true, connections: [] });
  const agents = vi.spyOn(agentsApi, "list").mockResolvedValue([]);
  const create = vi.spyOn(aiConnectionsApi, "create").mockResolvedValue({ connectionId: "10000000-0000-4000-8000-0000000000ff", grantId: "20000000-0000-4000-8000-0000000000ff" });
  const settings = vi.spyOn(decisionModelsApi, "settings").mockResolvedValue({ canManage: true, settings: configured, choices });
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter>
      <DecisionModelSettingsSection companyId={configured.companyId} />
    </MemoryRouter></QueryClientProvider>));
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Add connection")!.click());
    await act(async () => { (document.body.querySelector('button[aria-label="Ollama (local)"]') as HTMLButtonElement).click(); await new Promise(resolve => setTimeout(resolve, 10)); });
    await act(async () => {
      typeInto(document.body.querySelector('input[aria-label="Provider URL"]') as HTMLInputElement, "http://localhost:11434/v1");
      typeInto(document.body.querySelector('input[aria-label="API key"]') as HTMLInputElement, "secret");
    });
    await act(async () => { (document.body.querySelector('button[type="submit"]') as HTMLButtonElement).click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(create).toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("cannot be used for decisions");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("No authentication");
  } finally { act(() => root.unmount()); client.clear(); connections.mockRestore(); agents.mockRestore(); create.mockRestore(); settings.mockRestore(); container.remove(); }
});
