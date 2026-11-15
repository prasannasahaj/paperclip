import type {
  AttentionFeed,
  AttentionItem,
  AttentionItemDismissal,
  AttentionSubject,
  LiveEvent,
} from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  createAttentionNotificationTracker,
  isAttentionTrigger,
} from "./desktop-notification-attention";

function liveEvent(type: LiveEvent["type"], payload: Record<string, unknown>): LiveEvent {
  return { id: 1, companyId: "company-1", type, createdAt: "2026-11-15T10:00:00.000Z", payload };
}

function activityLogged(action?: string): LiveEvent {
  return liveEvent("activity.logged", action === undefined ? {} : { action });
}

type ItemOverrides = Partial<Omit<AttentionItem, "subject">> & {
  subject?: Partial<AttentionSubject>;
};

function attentionItem(id: string, overrides: ItemOverrides = {}): AttentionItem {
  const { subject, ...rest } = overrides;
  return {
    id,
    sourceKind: "approval",
    severity: "high",
    whyNow: `Why now ${id}`,
    dedupKey: `dedup-${id}`,
    dismissal: null,
    ...rest,
    subject: {
      identifier: `PAP-${id}`,
      title: `Title ${id}`,
      href: `/approvals/${id}`,
      ...subject,
    },
  } as AttentionItem;
}

function feedOf(...items: AttentionItem[]): AttentionFeed {
  return { items } as AttentionFeed;
}

describe("isAttentionTrigger", () => {
  it.each([
    "approval.created",
    "issue.thread_interaction_created",
    "decision.created",
    "join.requested",
    "join.request_replayed",
    "attention.claimed",
  ])("is true for %s", (action) => {
    expect(isAttentionTrigger(activityLogged(action))).toBe(true);
  });

  it("is false for issue.updated", () => {
    expect(isAttentionTrigger(activityLogged("issue.updated"))).toBe(false);
  });

  it("is false for a non-activity.logged event", () => {
    expect(isAttentionTrigger(liveEvent("heartbeat.run.progress", { action: "approval.created" }))).toBe(false);
  });

  it("is false for a missing action", () => {
    expect(isAttentionTrigger(activityLogged())).toBe(false);
  });
});

describe("createAttentionNotificationTracker", () => {
  it("returns no notifications on the first observe and sets the baseline", () => {
    const tracker = createAttentionNotificationTracker();

    expect(tracker.observe(feedOf(attentionItem("a"), attentionItem("b")))).toEqual([]);
    expect(tracker.observe(feedOf(attentionItem("a"), attentionItem("b")))).toEqual([]);
  });

  it("returns the exact notification fields for a new item after the baseline", () => {
    const tracker = createAttentionNotificationTracker();
    tracker.observe(feedOf(attentionItem("a")));

    const notifications = tracker.observe(
      feedOf(attentionItem("a"), attentionItem("b", { whyNow: "Approve the hire", dedupKey: "approval:b" })),
    );

    expect(notifications).toEqual([
      {
        title: "Approve the hire",
        body: "PAP-b Title b",
        href: "/approvals/b",
        tag: "attention:approval:b",
      },
    ]);
  });

  it("returns nothing for an item already seen", () => {
    const tracker = createAttentionNotificationTracker();
    tracker.observe(feedOf(attentionItem("a")));
    tracker.observe(feedOf(attentionItem("a"), attentionItem("b")));

    expect(tracker.observe(feedOf(attentionItem("a"), attentionItem("b")))).toEqual([]);
  });

  it("excludes failed_run, low-severity and actively dismissed items", () => {
    const tracker = createAttentionNotificationTracker();
    tracker.observe(feedOf());
    const activeDismissal: AttentionItemDismissal = {
      kind: "dismiss",
      dismissedAt: "2026-11-15T10:00:00.000Z",
      snoozedUntil: null,
      isActive: true,
    };

    const notifications = tracker.observe(
      feedOf(
        attentionItem("failed", { sourceKind: "failed_run" }),
        attentionItem("low", { severity: "low" }),
        attentionItem("dismissed", { dismissal: activeDismissal }),
        attentionItem("kept"),
      ),
    );

    expect(notifications.map((notification) => notification.tag)).toEqual(["attention:dedup-kept"]);
  });

  it("notifies for an item whose dismissal is no longer active", () => {
    const tracker = createAttentionNotificationTracker();
    tracker.observe(feedOf());
    const expiredSnooze: AttentionItemDismissal = {
      kind: "snooze",
      dismissedAt: "2026-11-14T10:00:00.000Z",
      snoozedUntil: "2026-11-15T09:00:00.000Z",
      isActive: false,
    };

    const notifications = tracker.observe(feedOf(attentionItem("a", { dismissal: expiredSnooze })));

    expect(notifications).toHaveLength(1);
  });

  it("notifies again for an item that leaves the feed and returns", () => {
    const tracker = createAttentionNotificationTracker();
    tracker.observe(feedOf(attentionItem("a")));
    tracker.observe(feedOf());

    const notifications = tracker.observe(feedOf(attentionItem("a")));

    expect(notifications.map((notification) => notification.tag)).toEqual(["attention:dedup-a"]);
  });

  it.each([null, "https://example.com/elsewhere", "approvals/a"])(
    "falls back to /inbox/mine when subject.href is %s",
    (href) => {
      const tracker = createAttentionNotificationTracker();
      tracker.observe(feedOf());

      const [notification] = tracker.observe(feedOf(attentionItem("a", { subject: { href } })));

      expect(notification?.href).toBe("/inbox/mine");
    },
  );

  it("leaves body undefined when the subject has no identifier and no title", () => {
    const tracker = createAttentionNotificationTracker();
    tracker.observe(feedOf());

    const [notification] = tracker.observe(
      feedOf(attentionItem("a", { subject: { identifier: null, title: null } })),
    );

    expect(notification?.body).toBeUndefined();
  });

  it("uses only the title as body when the subject has no identifier", () => {
    const tracker = createAttentionNotificationTracker();
    tracker.observe(feedOf());

    const [notification] = tracker.observe(feedOf(attentionItem("a", { subject: { identifier: null } })));

    expect(notification?.body).toBe("Title a");
  });
});
