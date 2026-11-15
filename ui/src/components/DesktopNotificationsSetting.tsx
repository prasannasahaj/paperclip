import { useState, useSyncExternalStore } from "react";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  desktopNotificationAvailability,
  disableDesktopNotifications,
  enableDesktopNotifications,
  isDesktopNotificationsEnabled,
  subscribeDesktopNotificationsEnabled,
  type DesktopNotificationAvailability,
} from "@/lib/desktop-notifications";

const UNAVAILABLE_MESSAGES: Record<Exclude<DesktopNotificationAvailability, "available">, string> = {
  denied: "Blocked in browser settings",
  insecure: "Requires https or localhost",
  unsupported: "Not supported in this browser",
};

export function DesktopNotificationsSetting() {
  const enabled = useSyncExternalStore(
    subscribeDesktopNotificationsEnabled,
    isDesktopNotificationsEnabled,
  );
  const [availability, setAvailability] = useState(desktopNotificationAvailability);

  async function turnOn() {
    await enableDesktopNotifications().catch(() => undefined);
    setAvailability(desktopNotificationAvailability());
  }

  function handleCheckedChange(checked: boolean) {
    if (checked) void turnOn();
    else disableDesktopNotifications();
  }

  const unavailableMessage = availability === "available" ? null : UNAVAILABLE_MESSAGES[availability];

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1.5">
        <h2 className="text-sm font-semibold">Desktop notifications</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Get a desktop notification when an agent needs your input or a task you follow is updated. This applies to
          this browser only and needs Chrome running with a Paperclip tab open. Notification titles and snippets can
          appear in your operating system's notification centre and on the lock screen.
        </p>
        {unavailableMessage ? (
          <p className="text-xs text-muted-foreground">{unavailableMessage}</p>
        ) : null}
      </div>
      <ToggleSwitch
        checked={enabled}
        onCheckedChange={handleCheckedChange}
        disabled={availability !== "available"}
        aria-label="Toggle desktop notifications"
      />
    </div>
  );
}
