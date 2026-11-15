// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  desktopNotificationAvailability,
  disableDesktopNotifications,
  enableDesktopNotifications,
  isDesktopNotificationsEnabled,
  showDesktopNotification,
  subscribeDesktopNotificationsEnabled,
} from "./desktop-notifications";

const OPT_IN_FLAG_KEY = "paperclip.desktopNotifications";

type StubPermission = "default" | "granted" | "denied";

function stubNotification(permission: StubPermission, requestPermission = vi.fn()) {
  vi.stubGlobal("Notification", { permission, requestPermission });
  return requestPermission;
}

function stubSecureContext(isSecureContext: boolean) {
  vi.stubGlobal("isSecureContext", isSecureContext);
}

function stubServiceWorkerRegistration() {
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const getRegistration = vi.fn().mockResolvedValue({ showNotification });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration },
  });
  return { showNotification, getRegistration };
}

function removeServiceWorker() {
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
}

function stubAvailableEnvironment(permission: StubPermission = "granted") {
  stubSecureContext(true);
  const requestPermission = stubNotification(permission);
  const { showNotification, getRegistration } = stubServiceWorkerRegistration();
  return { requestPermission, showNotification, getRegistration };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  removeServiceWorker();
});

describe("desktopNotificationAvailability", () => {
  it('availability is "insecure" when isSecureContext is false', () => {
    stubAvailableEnvironment();
    stubSecureContext(false);
    expect(desktopNotificationAvailability()).toBe("insecure");
  });

  it('availability is "insecure" when isSecureContext is false and serviceWorker is absent', () => {
    stubSecureContext(false);
    stubNotification("default");
    removeServiceWorker();
    expect(desktopNotificationAvailability()).toBe("insecure");
  });

  it('availability is "unsupported" when serviceWorker is missing in a secure context', () => {
    stubSecureContext(true);
    stubNotification("default");
    removeServiceWorker();
    expect(desktopNotificationAvailability()).toBe("unsupported");
  });

  it('availability is "unsupported" when Notification is missing', () => {
    stubAvailableEnvironment();
    vi.stubGlobal("Notification", undefined);
    expect(desktopNotificationAvailability()).toBe("unsupported");
  });

  it('availability is "denied" when permission is "denied"', () => {
    stubAvailableEnvironment("denied");
    expect(desktopNotificationAvailability()).toBe("denied");
  });

  it('availability is "available" when secure, supported and not denied', () => {
    stubAvailableEnvironment("default");
    expect(desktopNotificationAvailability()).toBe("available");
  });
});

describe("enableDesktopNotifications", () => {
  it('enable resolves "enabled", stores the flag, when requestPermission resolves "granted"', async () => {
    const { requestPermission } = stubAvailableEnvironment("default");
    requestPermission.mockResolvedValue("granted");
    vi.stubGlobal("Notification", { permission: "granted", requestPermission });

    await expect(enableDesktopNotifications()).resolves.toBe("enabled");

    expect(window.localStorage.getItem(OPT_IN_FLAG_KEY)).toBe("true");
    expect(isDesktopNotificationsEnabled()).toBe(true);
  });

  it('enable resolves "denied" and leaves the flag off when requestPermission resolves "denied"', async () => {
    const { requestPermission } = stubAvailableEnvironment("default");
    requestPermission.mockResolvedValue("denied");

    await expect(enableDesktopNotifications()).resolves.toBe("denied");

    expect(window.localStorage.getItem(OPT_IN_FLAG_KEY)).toBeNull();
    expect(isDesktopNotificationsEnabled()).toBe(false);
  });

  it("enable resolves the blocking availability without requesting permission", async () => {
    const { requestPermission } = stubAvailableEnvironment("default");
    stubSecureContext(false);

    await expect(enableDesktopNotifications()).resolves.toBe("insecure");

    expect(requestPermission).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(OPT_IN_FLAG_KEY)).toBeNull();
  });
});

describe("disableDesktopNotifications", () => {
  it("clears the flag so notifications are no longer enabled", () => {
    stubAvailableEnvironment("granted");
    window.localStorage.setItem(OPT_IN_FLAG_KEY, "true");
    expect(isDesktopNotificationsEnabled()).toBe(true);

    disableDesktopNotifications();

    expect(window.localStorage.getItem(OPT_IN_FLAG_KEY)).toBeNull();
    expect(isDesktopNotificationsEnabled()).toBe(false);
  });
});

describe("isDesktopNotificationsEnabled", () => {
  it("isDesktopNotificationsEnabled is false when localStorage throws", () => {
    stubAvailableEnvironment("granted");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    expect(isDesktopNotificationsEnabled()).toBe(false);
  });

  it("is false when the flag is on but permission is not granted", () => {
    stubAvailableEnvironment("default");
    window.localStorage.setItem(OPT_IN_FLAG_KEY, "true");
    expect(isDesktopNotificationsEnabled()).toBe(false);
  });

  it("is false when permission is granted but the flag is off", () => {
    stubAvailableEnvironment("granted");
    expect(isDesktopNotificationsEnabled()).toBe(false);
  });
});

describe("showDesktopNotification", () => {
  it("show calls registration.showNotification(title, { body, tag, data: { href } }) and resolves true", async () => {
    const { showNotification } = stubAvailableEnvironment("granted");
    window.localStorage.setItem(OPT_IN_FLAG_KEY, "true");

    const shown = await showDesktopNotification({
      title: "Approval requested",
      body: "CEO needs a decision",
      href: "/PAP/approvals/42",
      tag: "approval-42",
    });

    expect(shown).toBe(true);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledWith("Approval requested", {
      body: "CEO needs a decision",
      tag: "approval-42",
      data: { href: "/PAP/approvals/42" },
    });
  });

  it("show resolves false without calling showNotification when not enabled", async () => {
    const { showNotification } = stubAvailableEnvironment("granted");

    const shown = await showDesktopNotification({
      title: "Approval requested",
      href: "/PAP/approvals/42",
      tag: "approval-42",
    });

    expect(shown).toBe(false);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("show resolves false when there is no service worker registration", async () => {
    const { showNotification, getRegistration } = stubAvailableEnvironment("granted");
    window.localStorage.setItem(OPT_IN_FLAG_KEY, "true");
    getRegistration.mockResolvedValue(undefined);

    const shown = await showDesktopNotification({
      title: "Approval requested",
      href: "/PAP/approvals/42",
      tag: "approval-42",
    });

    expect(shown).toBe(false);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("show resolves false when showNotification rejects", async () => {
    const { showNotification } = stubAvailableEnvironment("granted");
    window.localStorage.setItem(OPT_IN_FLAG_KEY, "true");
    showNotification.mockRejectedValue(new Error("worker gone"));

    const shown = await showDesktopNotification({
      title: "Approval requested",
      href: "/PAP/approvals/42",
      tag: "approval-42",
    });

    expect(shown).toBe(false);
  });

  it("show posts the notification to the active service worker instead of showing it directly", async () => {
    const { showNotification, getRegistration } = stubAvailableEnvironment("granted");
    window.localStorage.setItem(OPT_IN_FLAG_KEY, "true");
    const postMessage = vi.fn();
    getRegistration.mockResolvedValue({ showNotification, active: { postMessage } });

    const shown = await showDesktopNotification({
      title: "Approval requested",
      body: "CEO needs a decision",
      href: "/PAP/approvals/42",
      tag: "approval-42",
    });

    expect(shown).toBe(true);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "paperclip:desktop-notification",
      title: "Approval requested",
      body: "CEO needs a decision",
      href: "/PAP/approvals/42",
      tag: "approval-42",
    });
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("show posts to the controlling worker when the registration has no active worker", async () => {
    const { showNotification, getRegistration } = stubAvailableEnvironment("granted");
    window.localStorage.setItem(OPT_IN_FLAG_KEY, "true");
    const postMessage = vi.fn();
    getRegistration.mockResolvedValue({ showNotification });
    (navigator.serviceWorker as unknown as { controller: unknown }).controller = { postMessage };

    const shown = await showDesktopNotification({
      title: "Approval requested",
      href: "/PAP/approvals/42",
      tag: "approval-42",
    });

    expect(shown).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("show falls back to showing directly when there is no worker to post to", async () => {
    const { showNotification, getRegistration } = stubAvailableEnvironment("granted");
    window.localStorage.setItem(OPT_IN_FLAG_KEY, "true");
    getRegistration.mockResolvedValue({ showNotification, active: null });

    const shown = await showDesktopNotification({
      title: "Approval requested",
      href: "/PAP/approvals/42",
      tag: "approval-42",
    });

    expect(shown).toBe(true);
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it("show resolves false when posting to the worker throws", async () => {
    const { showNotification, getRegistration } = stubAvailableEnvironment("granted");
    window.localStorage.setItem(OPT_IN_FLAG_KEY, "true");
    const postMessage = vi.fn(() => { throw new Error("worker gone"); });
    getRegistration.mockResolvedValue({ showNotification, active: { postMessage } });

    const shown = await showDesktopNotification({
      title: "Approval requested",
      href: "/PAP/approvals/42",
      tag: "approval-42",
    });

    expect(shown).toBe(false);
  });
});

describe("subscribeDesktopNotificationsEnabled", () => {
  it("listener fires on enable", async () => {
    stubAvailableEnvironment("granted");
    const listener = vi.fn();
    const unsubscribe = subscribeDesktopNotificationsEnabled(listener);

    await enableDesktopNotifications();

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("listener does not fire when enable is denied", async () => {
    const { requestPermission } = stubAvailableEnvironment("default");
    requestPermission.mockResolvedValue("denied");
    const listener = vi.fn();
    const unsubscribe = subscribeDesktopNotificationsEnabled(listener);

    await enableDesktopNotifications();

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("listener fires on disable", () => {
    stubAvailableEnvironment("granted");
    const listener = vi.fn();
    const unsubscribe = subscribeDesktopNotificationsEnabled(listener);

    disableDesktopNotifications();

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("listener fires on a storage event for the opt-in key only", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDesktopNotificationsEnabled(listener);

    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    expect(listener).not.toHaveBeenCalled();

    window.dispatchEvent(new StorageEvent("storage", { key: OPT_IN_FLAG_KEY }));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("unsubscribed listener does not fire", async () => {
    stubAvailableEnvironment("granted");
    const listener = vi.fn();
    const unsubscribe = subscribeDesktopNotificationsEnabled(listener);
    unsubscribe();

    await enableDesktopNotifications();
    disableDesktopNotifications();
    window.dispatchEvent(new StorageEvent("storage", { key: OPT_IN_FLAG_KEY }));

    expect(listener).not.toHaveBeenCalled();
  });
});
