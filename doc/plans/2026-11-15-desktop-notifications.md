# Desktop notifications for "needs you" and task updates

Status: short design, awaiting approval. Size: small change (UI only).

## Intent

A board user who is away from the Paperclip tab misses work that needs their input (approvals, decisions, agent questions, reviews) and finishes or failures they care about. Show a macOS desktop notification through Chrome's Notification API so they find out without watching the tab.

## Goals

- Notify when Chrome is running and a Paperclip tab is open but not foregrounded.
- Reuse the existing live-event pipeline and its notion of "worth interrupting you".
- Clicking a notification focuses or opens Paperclip at the relevant page.
- Opt-in per browser, with a visible on/off control.

## Non-goals

- Notifications with no Chrome tab open (web-push/VAPID), phone, or chat delivery.
- A server-side notifier or any new table, route, or shared type.
- Per-event-type preference matrix.

## Anti-goals

- Noise. Comment chatter, run progress and tool progress never notify.
- Notifying while the user is looking at the tab: the in-app toast already covers that.

## Approaches considered

1. **Mirror the toast path into `Notification` (chosen).** Smallest change, reuses `toastEligible` (computed server-side per board user in `server/src/realtime/live-events-ws.ts:383`) and the `ToastGate` dedupe/cooldown in `ui/src/context/LiveUpdatesProvider.tsx`.
2. Real web-push with VAPID: works with the tab closed but needs keys, subscription storage and a schema change. Overkill for a local instance.
3. Server-side `osascript`/`terminal-notifier`: works with Chrome closed but is macOS-only code in the server and breaks non-local deployments.

## Design

- `ui/src/lib/desktop-notifications.ts`: small module. `desktopNotificationsEnabled()` reads a per-browser flag (localStorage, try/catch) and `Notification.permission`. `notifyDesktop({ title, body, href, tag })` calls `ServiceWorkerRegistration.showNotification` with `tag` so repeats collapse.
- `LiveUpdatesProvider.tsx`: the socket handler returns before `handleLiveEvent` while the tab is hidden (`LiveUpdatesProvider.tsx:2604`), so hooking `gatedPushToast` alone would never fire for a backgrounded tab. Add a separate desktop path ahead of that return, run when the page is not foregrounded (hidden, or visible but unfocused). It reuses the existing toast builders and the `ToastGate` cooldown, and does not run any cache invalidation.
- Needs-input events are not toast-eligible today (`task-toast-eligibility.ts` covers only issue created/updated/comment and failed runs), and authenticated clients receive `activity.logged` without `details`, `actorType` or `actorId` (`server/src/realtime/live-events-ws.ts:356-368`), so the event cannot carry the content. Instead, `activity.logged` actions `approval.created`, `issue.thread_interaction_created`, `decision.created`, join requests and `attention.*` act as triggers: the desktop path re-reads the viewer-filtered attention feed (`view: "mine"`, same cache key as the sidebar badge) and notifies items that were not there before, using the item's `whyNow`, subject and `href`. This is viewer-filtered and self-authorship-safe by construction, and works the same in local and authenticated mode. Failed runs are excluded from the feed path (the run-status path covers them), as are low-severity and dismissed items.
- `ui/public/sw.js`: add a `notificationclick` handler that focuses an existing Paperclip window and navigates to `href`, or opens one.
- Settings control: an on/off toggle that requests permission on enable, with a "blocked in browser" state shown when permission is `denied`. Placed in `InstanceGeneralSettings`.
- Default event set = whatever is already toast-eligible, plus attention items that "need input" if they are not toast-eligible today: approvals, decisions, `ask_user_questions` / `request_confirmation` interactions, reviews, failed runs. Task completion is included only if already toast-eligible. Comments and progress are excluded.

## Constraints

- Notification API needs a secure context. `localhost` qualifies; a plain-http remote host does not, so the toggle must show the unavailable state there.
- Company scoping and per-user visibility are inherited because only events already delivered to this socket and marked `toastEligible` are used.
- UI changes follow `DESIGN.md` (token-only).

## Left to the builder

- Whether attention items need an extra eligibility branch (check what `buildActivityToast` and `task-toast-eligibility.ts` cover today).
- Exact copy for titles and bodies, taken from the existing toast builders.
- Test shape: unit tests for the module and for the foreground gate; a service-worker click test alongside `sw-offline-fallback.test.ts`.

## Verification

`pnpm verify` for affected Vitest files, plus a manual check in Chrome on macOS: grant permission, background the tab, trigger an approval, confirm the notification and click-through. macOS Focus modes and Chrome's system notification permission can silence it; that is outside the app.
