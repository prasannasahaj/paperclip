// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { defaultCreateValues } from "@/components/agent-config-defaults";
import { ClaudeLocalAdvancedFields } from "./config-fields";

beforeAll(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });

function contextCompressionField(container: HTMLElement): HTMLElement | null {
  const label = Array.from(container.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim() === "Context compression",
  );
  return label?.parentElement?.parentElement ?? null;
}

function contextCompressionSelect(container: HTMLElement): HTMLSelectElement | null {
  return contextCompressionField(container)?.querySelector("select") ?? null;
}

function changeSelect(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Claude local context compression field", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  async function renderEdit(config: Record<string, unknown>, managedSandboxOnly = false) {
    const mark = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(
      <TooltipProvider>
        <ClaudeLocalAdvancedFields
          mode="edit"
          isCreate={false}
          adapterType="claude_local"
          values={null}
          set={null}
          config={config}
          eff={(_group, _field, original) => original}
          mark={mark}
          models={[]}
          managedSandboxOnly={managedSandboxOnly}
        />
      </TooltipProvider>,
    ));
    return { container, mark, unmount: () => act(async () => root.unmount()) };
  }

  it("shows On for an agent whose config has no contextCompression key", async () => {
    const { container, unmount } = await renderEdit({});
    expect(contextCompressionSelect(container)?.value).toBe("on");
    await unmount();
  });

  it.each(["record", "off"])("shows the stored %s value", async (stored) => {
    const { container, unmount } = await renderEdit({ contextCompression: stored });
    expect(contextCompressionSelect(container)?.value).toBe(stored);
    await unmount();
  });

  it("treats an unrecognised stored value as On", async () => {
    const { container, unmount } = await renderEdit({ contextCompression: "turbo" });
    expect(contextCompressionSelect(container)?.value).toBe("on");
    await unmount();
  });

  it("offers On, Record only and Off", async () => {
    const { container, unmount } = await renderEdit({});
    const labels = Array.from(contextCompressionSelect(container)!.options).map((option) => option.textContent);
    expect(labels).toEqual(["On", "Record only", "Off"]);
    await unmount();
  });

  it("stores the default as an absent key and other choices verbatim", async () => {
    const { container, mark, unmount } = await renderEdit({ contextCompression: "off" });
    const select = contextCompressionSelect(container)!;
    await act(async () => changeSelect(select, "on"));
    expect(mark).toHaveBeenLastCalledWith("adapterConfig", "contextCompression", undefined);
    await act(async () => changeSelect(select, "record"));
    expect(mark).toHaveBeenLastCalledWith("adapterConfig", "contextCompression", "record");
    await act(async () => changeSelect(select, "off"));
    expect(mark).toHaveBeenLastCalledWith("adapterConfig", "contextCompression", "off");
    await unmount();
  });

  it("states that it applies to the ACP engine only", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const { container, unmount } = await renderEdit({});
    const hintButton = contextCompressionField(container)!.querySelector("button")!;
    await act(async () => {
      hintButton.focus();
    });
    expect(document.body.textContent).toContain("Applies to the ACP engine only");
    await unmount();
  });

  it("is hidden under the managed-sandbox-only policy", async () => {
    const { container, unmount } = await renderEdit({}, true);
    expect(contextCompressionSelect(container)).toBeNull();
    await unmount();
  });

  it("writes the choice into the create form values", async () => {
    let latest: CreateConfigValues = { ...defaultCreateValues, adapterType: "claude_local" };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    function Fixture() {
      const [values, setValues] = useState(latest);
      latest = values;
      return (
        <ClaudeLocalAdvancedFields
          mode="create"
          isCreate
          adapterType="claude_local"
          values={values}
          set={(patch) => setValues((previous) => ({ ...previous, ...patch }))}
          config={{}}
          eff={(_group, _field, original) => original}
          mark={() => undefined}
          models={[]}
        />
      );
    }
    await act(async () => root.render(<TooltipProvider><Fixture /></TooltipProvider>));
    expect(contextCompressionSelect(container)?.value).toBe("on");
    await act(async () => changeSelect(contextCompressionSelect(container)!, "record"));
    expect(latest.claudeContextCompression).toBe("record");
    expect(contextCompressionSelect(container)?.value).toBe("record");
    await act(async () => root.unmount());
  });
});
