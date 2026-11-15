// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopNotificationsSetting } from "./DesktopNotificationsSetting";

type Availability = "available" | "unsupported" | "insecure" | "denied";

const desktopNotifications = vi.hoisted(() => {
  const state = { enabled: false, availability: "available" as Availability };
  const listeners = new Set<() => void>();
  const notifyListeners = () => listeners.forEach((listener) => listener());
  return {
    state,
    notifyListeners,
    desktopNotificationAvailability: vi.fn(() => state.availability),
    isDesktopNotificationsEnabled: vi.fn(() => state.enabled),
    enableDesktopNotifications: vi.fn(),
    disableDesktopNotifications: vi.fn(),
    subscribeDesktopNotificationsEnabled: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
});

vi.mock("@/lib/desktop-notifications", () => ({
  desktopNotificationAvailability: desktopNotifications.desktopNotificationAvailability,
  isDesktopNotificationsEnabled: desktopNotifications.isDesktopNotificationsEnabled,
  enableDesktopNotifications: desktopNotifications.enableDesktopNotifications,
  disableDesktopNotifications: desktopNotifications.disableDesktopNotifications,
  subscribeDesktopNotificationsEnabled: desktopNotifications.subscribeDesktopNotificationsEnabled,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DesktopNotificationsSetting", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    desktopNotifications.state.enabled = false;
    desktopNotifications.state.availability = "available";
    desktopNotifications.enableDesktopNotifications.mockImplementation(async () => {
      desktopNotifications.state.enabled = true;
      desktopNotifications.notifyListeners();
      return "enabled";
    });
    desktopNotifications.disableDesktopNotifications.mockImplementation(() => {
      desktopNotifications.state.enabled = false;
      desktopNotifications.notifyListeners();
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function renderSetting() {
    flushSync(() => root.render(<DesktopNotificationsSetting />));
  }

  function toggle() {
    return container.querySelector<HTMLButtonElement>('[aria-label="Toggle desktop notifications"]')!;
  }

  it("explains that it applies to this browser only and needs Chrome running with a Paperclip tab open", () => {
    renderSetting();

    expect(container.querySelector("h2")?.textContent).toBe("Desktop notifications");
    expect(container.textContent).toContain("this browser only");
    expect(container.textContent).toContain("Chrome running with a Paperclip tab open");
    expect(container.textContent).toContain("lock screen");
    expect(toggle().getAttribute("role")).toBe("switch");
  });

  it("offers a working off toggle when notifications are available", () => {
    renderSetting();

    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().disabled).toBe(false);
  });

  it("reflects notifications that are already enabled", () => {
    desktopNotifications.state.enabled = true;
    renderSetting();

    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it.each([
    ["denied", "Blocked in browser settings"],
    ["insecure", "Requires https or localhost"],
    ["unsupported", "Not supported in this browser"],
  ] as const)("disables the toggle and explains when availability is %s", (availability, message) => {
    desktopNotifications.state.availability = availability;
    renderSetting();

    expect(container.textContent).toContain(message);
    expect(toggle().disabled).toBe(true);
  });

  it("does not show a blocked message when notifications are available", () => {
    renderSetting();

    expect(container.textContent).not.toContain("Blocked in browser settings");
    expect(container.textContent).not.toContain("Requires https or localhost");
    expect(container.textContent).not.toContain("Not supported in this browser");
  });

  it('turning the toggle on calls enableDesktopNotifications and reflects "enabled"', async () => {
    renderSetting();

    flushSync(() => toggle().click());

    await vi.waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    expect(desktopNotifications.enableDesktopNotifications).toHaveBeenCalledOnce();
    expect(desktopNotifications.disableDesktopNotifications).not.toHaveBeenCalled();
  });

  it("a denied result shows the blocked message and leaves the toggle off", async () => {
    desktopNotifications.enableDesktopNotifications.mockImplementation(async () => {
      desktopNotifications.state.availability = "denied";
      return "denied";
    });
    renderSetting();

    flushSync(() => toggle().click());

    await vi.waitFor(() => expect(container.textContent).toContain("Blocked in browser settings"));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().disabled).toBe(true);
  });

  it("a dismissed permission prompt shows no blocked message and lets the user retry", async () => {
    desktopNotifications.enableDesktopNotifications.mockResolvedValue("denied");
    renderSetting();

    flushSync(() => toggle().click());

    await vi.waitFor(() =>
      expect(desktopNotifications.enableDesktopNotifications).toHaveBeenCalledOnce(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).not.toContain("Blocked in browser settings");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().disabled).toBe(false);
  });

  it("a rejected enable leaves the toggle off without an unhandled rejection", async () => {
    desktopNotifications.enableDesktopNotifications.mockRejectedValue(new Error("permission request failed"));
    renderSetting();

    flushSync(() => toggle().click());

    await vi.waitFor(() =>
      expect(desktopNotifications.enableDesktopNotifications).toHaveBeenCalledOnce(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().disabled).toBe(false);
  });

  it("a rejected enable reports the blocked message when permission is denied", async () => {
    desktopNotifications.enableDesktopNotifications.mockImplementation(async () => {
      desktopNotifications.state.availability = "denied";
      throw new Error("permission request failed");
    });
    renderSetting();

    flushSync(() => toggle().click());

    await vi.waitFor(() => expect(container.textContent).toContain("Blocked in browser settings"));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("turning it off calls disableDesktopNotifications", async () => {
    desktopNotifications.state.enabled = true;
    renderSetting();

    flushSync(() => toggle().click());

    await vi.waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
    expect(desktopNotifications.disableDesktopNotifications).toHaveBeenCalledOnce();
    expect(desktopNotifications.enableDesktopNotifications).not.toHaveBeenCalled();
  });

  it("follows the enabled state when it changes elsewhere", () => {
    renderSetting();

    desktopNotifications.state.enabled = true;
    flushSync(() => desktopNotifications.notifyListeners());

    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });
});
