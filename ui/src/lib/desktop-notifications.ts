const OPT_IN_FLAG_KEY = "paperclip.desktopNotifications";
const OPT_IN_FLAG_ON = "true";
const DESKTOP_NOTIFICATION_MESSAGE_TYPE = "paperclip:desktop-notification";

export interface DesktopNotificationInput {
  title: string;
  body?: string;
  href: string;
  tag: string;
}

export type DesktopNotificationAvailability = "available" | "unsupported" | "insecure" | "denied";

export type EnableDesktopNotificationsResult = "enabled" | "denied" | "unsupported" | "insecure";

const enabledListeners = new Set<() => void>();

function notifyEnabledListeners(): void {
  for (const listener of [...enabledListeners]) listener();
}

function handleOptInStorageEvent(event: StorageEvent): void {
  if (event.key === null || event.key === OPT_IN_FLAG_KEY) notifyEnabledListeners();
}

export function subscribeDesktopNotificationsEnabled(listener: () => void): () => void {
  enabledListeners.add(listener);
  if (enabledListeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", handleOptInStorageEvent);
  }
  return () => {
    enabledListeners.delete(listener);
    if (enabledListeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", handleOptInStorageEvent);
    }
  };
}

function hasNotificationApi(): boolean {
  return typeof window !== "undefined" && typeof window.Notification !== "undefined";
}

function hasServiceWorkerApi(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

export function desktopNotificationAvailability(): DesktopNotificationAvailability {
  if (!hasNotificationApi()) return "unsupported";
  if (!window.isSecureContext) return "insecure";
  if (!hasServiceWorkerApi()) return "unsupported";
  if (window.Notification.permission === "denied") return "denied";
  return "available";
}

function readOptInFlag(): boolean {
  try {
    return window.localStorage.getItem(OPT_IN_FLAG_KEY) === OPT_IN_FLAG_ON;
  } catch {
    return false;
  }
}

function writeOptInFlag(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(OPT_IN_FLAG_KEY, OPT_IN_FLAG_ON);
    else window.localStorage.removeItem(OPT_IN_FLAG_KEY);
  } catch {
    return;
  }
}

export function isDesktopNotificationsEnabled(): boolean {
  return (
    desktopNotificationAvailability() === "available" &&
    window.Notification.permission === "granted" &&
    readOptInFlag()
  );
}

export async function enableDesktopNotifications(): Promise<EnableDesktopNotificationsResult> {
  const availability = desktopNotificationAvailability();
  if (availability !== "available") return availability;

  const permission =
    window.Notification.permission === "granted"
      ? "granted"
      : await window.Notification.requestPermission();
  if (permission !== "granted") return "denied";

  writeOptInFlag(true);
  notifyEnabledListeners();
  return "enabled";
}

export function disableDesktopNotifications(): void {
  writeOptInFlag(false);
  notifyEnabledListeners();
}

export async function showDesktopNotification(input: DesktopNotificationInput): Promise<boolean> {
  if (!isDesktopNotificationsEnabled()) return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return false;
    const worker = registration.active ?? navigator.serviceWorker.controller;
    if (worker) {
      worker.postMessage({
        type: DESKTOP_NOTIFICATION_MESSAGE_TYPE,
        title: input.title,
        body: input.body,
        href: input.href,
        tag: input.tag,
      });
      return true;
    }
    await registration.showNotification(input.title, {
      body: input.body,
      tag: input.tag,
      data: { href: input.href },
    });
    return true;
  } catch {
    return false;
  }
}
