import type { AttentionFeed, AttentionItem, LiveEvent } from "@paperclipai/shared";
import type { DesktopNotificationInput } from "./desktop-notifications";

const FALLBACK_HREF = "/inbox/mine";
const ATTENTION_ACTION_PREFIX = "attention.";
const TRIGGER_ACTIONS = new Set([
  "approval.created",
  "issue.thread_interaction_created",
  "decision.created",
  "join.requested",
  "join.request_replayed",
]);

export interface AttentionNotificationTracker {
  observe(feed: AttentionFeed): DesktopNotificationInput[];
}

export function isAttentionTrigger(event: LiveEvent): boolean {
  if (event.type !== "activity.logged") return false;
  const action = event.payload.action;
  if (typeof action !== "string") return false;
  return TRIGGER_ACTIONS.has(action) || action.startsWith(ATTENTION_ACTION_PREFIX);
}

function isNotifiable(item: AttentionItem): boolean {
  if (item.sourceKind === "failed_run") return false;
  if (item.severity === "low") return false;
  return item.dismissal?.isActive !== true;
}

function resolveHref(item: AttentionItem): string {
  const href = item.subject.href;
  return typeof href === "string" && href.startsWith("/") ? href : FALLBACK_HREF;
}

function resolveBody(item: AttentionItem): string | undefined {
  const body = [item.subject.identifier, item.subject.title].filter(Boolean).join(" ");
  return body.length > 0 ? body : undefined;
}

function toNotification(item: AttentionItem): DesktopNotificationInput {
  return {
    title: item.whyNow,
    body: resolveBody(item),
    href: resolveHref(item),
    tag: `attention:${item.dedupKey}`,
  };
}

export function createAttentionNotificationTracker(): AttentionNotificationTracker {
  let seenIds: Set<string> | null = null;

  return {
    observe(feed) {
      const previousIds = seenIds;
      seenIds = new Set(feed.items.map((item) => item.id));
      if (previousIds === null) return [];
      return feed.items
        .filter((item) => !previousIds.has(item.id) && isNotifiable(item))
        .map(toNotification);
    },
  };
}
