import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { embedServiceWorkerOfflineStyles } from "./vite-sw-build-id";

const uiRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ORIGIN = "https://app.example.com";

interface FakeWindowClient {
  url: string;
  focused: boolean;
  visibilityState: "visible" | "hidden";
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
}

function fakeWindowClient(
  url: string,
  overrides: {
    navigate?: () => Promise<unknown>;
    focused?: boolean;
    visibilityState?: "visible" | "hidden";
  } = {},
): FakeWindowClient {
  return {
    url,
    focused: overrides.focused ?? false,
    visibilityState: overrides.visibilityState ?? "hidden",
    focus: vi.fn(async () => undefined),
    navigate: vi.fn(overrides.navigate ?? (async () => undefined)),
  };
}

type NotificationClickListener = (event: {
  notification: { close: () => void; data?: { href?: unknown } };
  waitUntil: (work: Promise<unknown>) => void;
}) => void;

function loadNotificationClickListener(windowClients: FakeWindowClient[]) {
  const listeners = new Map<string, (event: unknown) => void>();
  const matchAll = vi.fn(async () => windowClients);
  const openWindow = vi.fn(async () => undefined);
  const showNotification = vi.fn(async () => undefined);
  const swSelf = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), matchAll, openWindow },
    location: { origin: ORIGIN },
    registration: { showNotification },
  };
  const caches = {
    match: vi.fn(async () => undefined),
    open: vi.fn(async () => ({ put: vi.fn() })),
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true),
  };
  const code = embedServiceWorkerOfflineStyles(
    readFileSync(resolve(uiRoot, "public/sw.js"), "utf8"),
    readFileSync(resolve(uiRoot, "src/index.css"), "utf8"),
  ).replace("__PAPERCLIP_BUILD_ID__", "fixture-production");
  new Function("self", "caches", "fetch", "Response", "URL", code)(
    swSelf,
    caches,
    vi.fn(),
    Response,
    URL,
  );
  const listener = listeners.get("notificationclick");
  if (!listener) throw new Error("sw.js registered no notificationclick listener");
  return {
    listener: listener as NotificationClickListener,
    messageListener: listeners.get("message") as MessageListener | undefined,
    matchAll,
    openWindow,
    showNotification,
  };
}

type MessageListener = (event: {
  data: unknown;
  waitUntil: (work: Promise<unknown>) => void;
}) => void;

async function postMessageToWorker(listener: MessageListener | undefined, data: unknown) {
  if (!listener) throw new Error("sw.js registered no message listener");
  let pending: Promise<unknown> | undefined;
  listener({
    data,
    waitUntil: (work) => {
      pending = work;
    },
  });
  await pending;
}

const DESKTOP_NOTIFICATION_MESSAGE = {
  type: "paperclip:desktop-notification",
  title: "Approval requested",
  body: "CEO needs a decision",
  href: "/PAP/approvals/42",
  tag: "approval-42",
};

async function clickNotification(
  listener: NotificationClickListener,
  data: { href?: unknown } | undefined,
) {
  const close = vi.fn();
  let pending: Promise<unknown> | undefined;
  listener({
    notification: { close, data },
    waitUntil: (work) => {
      pending = work;
    },
  });
  await pending;
  return { close };
}

describe("sw.js notificationclick", () => {
  it("closes the notification and focuses an existing same-origin window, navigating it to href", async () => {
    const sameOriginWindow = fakeWindowClient(`${ORIGIN}/PAP/issues/PAP-1`);
    const { listener, matchAll, openWindow } = loadNotificationClickListener([sameOriginWindow]);

    const { close } = await clickNotification(listener, { href: "/inbox/mine" });

    expect(close).toHaveBeenCalledTimes(1);
    expect(matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true });
    expect(sameOriginWindow.focus).toHaveBeenCalledTimes(1);
    expect(sameOriginWindow.navigate).toHaveBeenCalledWith(`${ORIGIN}/inbox/mine`);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("prefers a same-origin window over a window on another origin", async () => {
    const foreignWindow = fakeWindowClient("https://other.example.com/inbox");
    const sameOriginWindow = fakeWindowClient(`${ORIGIN}/dashboard`);
    const { listener } = loadNotificationClickListener([foreignWindow, sameOriginWindow]);

    await clickNotification(listener, { href: "/inbox/mine" });

    expect(foreignWindow.focus).not.toHaveBeenCalled();
    expect(foreignWindow.navigate).not.toHaveBeenCalled();
    expect(sameOriginWindow.navigate).toHaveBeenCalledWith(`${ORIGIN}/inbox/mine`);
  });

  it("opens a new window at href when no window client exists", async () => {
    const { listener, openWindow } = loadNotificationClickListener([]);

    const { close } = await clickNotification(listener, { href: "/PAP/issues/PAP-7" });

    expect(close).toHaveBeenCalledTimes(1);
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/PAP/issues/PAP-7`);
  });

  it("opens a new window when the only window client is on another origin", async () => {
    const foreignWindow = fakeWindowClient("https://other.example.com/inbox");
    const { listener, openWindow } = loadNotificationClickListener([foreignWindow]);

    await clickNotification(listener, { href: "/inbox/mine" });

    expect(foreignWindow.focus).not.toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/inbox/mine`);
  });

  it("falls back to openWindow when client.navigate rejects", async () => {
    const sameOriginWindow = fakeWindowClient(`${ORIGIN}/dashboard`, {
      navigate: () => Promise.reject(new TypeError("navigate unsupported")),
    });
    const { listener, openWindow } = loadNotificationClickListener([sameOriginWindow]);

    await clickNotification(listener, { href: "/inbox/mine" });

    expect(sameOriginWindow.navigate).toHaveBeenCalledWith(`${ORIGIN}/inbox/mine`);
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/inbox/mine`);
  });

  it('opens "/" when the notification carries no href', async () => {
    const { listener, openWindow } = loadNotificationClickListener([]);

    await clickNotification(listener, undefined);

    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });

  it('never navigates to a cross-origin href and opens "/" instead', async () => {
    const { listener, openWindow } = loadNotificationClickListener([]);

    await clickNotification(listener, { href: "https://evil.example.net/phish" });

    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });

  it('never navigates an existing window to a cross-origin href and uses "/" instead', async () => {
    const sameOriginWindow = fakeWindowClient(`${ORIGIN}/dashboard`);
    const { listener } = loadNotificationClickListener([sameOriginWindow]);

    await clickNotification(listener, { href: "//evil.example.net/phish" });

    expect(sameOriginWindow.navigate).toHaveBeenCalledWith(`${ORIGIN}/`);
  });
});

describe("sw.js notificationclick window choice", () => {
  it("prefers a focused same-origin window, then a visible one, then the first", async () => {
    const first = fakeWindowClient(`${ORIGIN}/a`);
    const visible = fakeWindowClient(`${ORIGIN}/b`, { visibilityState: "visible" });
    const focused = fakeWindowClient(`${ORIGIN}/c`, { focused: true, visibilityState: "visible" });
    const { listener } = loadNotificationClickListener([first, visible, focused]);

    await clickNotification(listener, { href: "/inbox/mine" });

    expect(focused.navigate).toHaveBeenCalledWith(`${ORIGIN}/inbox/mine`);
    expect(visible.navigate).not.toHaveBeenCalled();
    expect(first.navigate).not.toHaveBeenCalled();
  });

  it("falls back to a visible same-origin window when none is focused", async () => {
    const first = fakeWindowClient(`${ORIGIN}/a`);
    const visible = fakeWindowClient(`${ORIGIN}/b`, { visibilityState: "visible" });
    const { listener } = loadNotificationClickListener([first, visible]);

    await clickNotification(listener, { href: "/inbox/mine" });

    expect(visible.navigate).toHaveBeenCalledWith(`${ORIGIN}/inbox/mine`);
    expect(first.navigate).not.toHaveBeenCalled();
  });

  it("uses the first same-origin window when none is focused or visible", async () => {
    const foreign = fakeWindowClient("https://other.example.com/x", { focused: true, visibilityState: "visible" });
    const first = fakeWindowClient(`${ORIGIN}/a`);
    const second = fakeWindowClient(`${ORIGIN}/b`);
    const { listener } = loadNotificationClickListener([foreign, first, second]);

    await clickNotification(listener, { href: "/inbox/mine" });

    expect(first.navigate).toHaveBeenCalledWith(`${ORIGIN}/inbox/mine`);
    expect(second.navigate).not.toHaveBeenCalled();
    expect(foreign.navigate).not.toHaveBeenCalled();
  });
});

describe("sw.js desktop notification message", () => {
  it("suppresses the notification when a same-origin window client is focused", async () => {
    const focused = fakeWindowClient(`${ORIGIN}/a`, { focused: true, visibilityState: "visible" });
    const { messageListener, showNotification } = loadNotificationClickListener([focused]);

    await postMessageToWorker(messageListener, DESKTOP_NOTIFICATION_MESSAGE);

    expect(showNotification).not.toHaveBeenCalled();
  });

  it("shows the notification when no window client is focused", async () => {
    const background = fakeWindowClient(`${ORIGIN}/a`);
    const foreignFocused = fakeWindowClient("https://other.example.com/x", { focused: true });
    const { messageListener, showNotification } = loadNotificationClickListener([background, foreignFocused]);

    await postMessageToWorker(messageListener, DESKTOP_NOTIFICATION_MESSAGE);

    expect(showNotification).toHaveBeenCalledExactlyOnceWith("Approval requested", {
      body: "CEO needs a decision",
      tag: "approval-42",
      data: { href: "/PAP/approvals/42" },
    });
  });

  it("shows the notification when there is no window client", async () => {
    const { messageListener, showNotification } = loadNotificationClickListener([]);

    await postMessageToWorker(messageListener, DESKTOP_NOTIFICATION_MESSAGE);

    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no data", undefined],
    ["a string", "paperclip:desktop-notification"],
    ["another type", { ...DESKTOP_NOTIFICATION_MESSAGE, type: "other" }],
    ["a missing title", { ...DESKTOP_NOTIFICATION_MESSAGE, title: undefined }],
    ["an empty title", { ...DESKTOP_NOTIFICATION_MESSAGE, title: "" }],
    ["a non-string href", { ...DESKTOP_NOTIFICATION_MESSAGE, href: 7 }],
    ["a non-string tag", { ...DESKTOP_NOTIFICATION_MESSAGE, tag: null }],
    ["a non-string body", { ...DESKTOP_NOTIFICATION_MESSAGE, body: 5 }],
  ])("ignores a malformed message with %s", async (_label, data) => {
    const { messageListener, showNotification, matchAll } = loadNotificationClickListener([]);

    await postMessageToWorker(messageListener, data);

    expect(showNotification).not.toHaveBeenCalled();
    expect(matchAll).not.toHaveBeenCalled();
  });
});
