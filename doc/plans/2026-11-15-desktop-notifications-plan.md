# Desktop Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a macOS desktop notification (Chrome Notification API) when something needs the board user's input or a task they follow changes, while the Paperclip tab is hidden or unfocused.

**Architecture:** A small browser-only module owns permission, the per-browser opt-in flag and `showNotification`. A new desktop path in `LiveUpdatesProvider` runs before the hidden-tab early return, turns toast-eligible task and run events into notifications through the existing toast builders, and uses live events only as triggers to re-read the viewer-filtered attention feed for needs-input items and reuses the `ToastGate` cooldown. The service worker handles click-through. A settings toggle enables it.

**Tech Stack:** React, Vitest (jsdom), service worker `showNotification`, existing live-event websocket.

**Spec:** `doc/plans/2026-11-15-desktop-notifications.md`

## Global Constraints

- UI only: no change to `packages/db`, `packages/shared`, or `server/`.
- Never author code comments (user rule). Names carry the explanation.
- Notification API needs a secure context; `localhost` qualifies. Unavailable states must not throw.
- Opt-in per browser, stored in `localStorage` under `paperclip.desktopNotifications` (read and write inside try/catch).
- Notify only when the page is not foregrounded: `document.visibilityState !== "visible"` or `!document.hasFocus()` (same as `isPageForegrounded` at `ui/src/context/LiveUpdatesProvider.tsx:401`).
- Never notify for comments from the viewer, run progress, tool progress, or events for another company.
- Needs-input notifications link to the attention item's own `subject.href` when it starts with `/`, else `/inbox/mine`.
- UI follows `DESIGN.md` (token-only).
- Single commit at the end unless told otherwise.

## Review Focus

- Permission `denied` or insecure host: toggle shows an unavailable state; enabling never throws.
- Visible-but-unfocused page: toast and desktop notification both fire once; the desktop path must not consume the run-outcome dedupe that suppresses the toast.
- Burst of 50 `approval.created` events: one debounced feed fetch; the cooldown caps notifications and `tag` collapses repeats.
- Reconnect replay and reload: events inside `suppressUntil` or with stale run outcomes do not notify.
- Items already in the feed at startup, dismissed or low-severity items, items for other people (excluded by the `mine` view), and other-company events: no notification. Authenticated mode, where the socket strips `details`, must behave the same as local mode.

## File Structure

- Create `ui/src/lib/desktop-notifications.ts`: availability, opt-in flag, `showDesktopNotification`.
- Create `ui/src/lib/desktop-notification-attention.ts`: trigger predicate and attention-feed notification tracker.
- Modify `ui/src/context/LiveUpdatesProvider.tsx`: desktop path, `isRunOutcomeStale` extraction, socket handler hook-up.
- Modify `ui/public/sw.js`: `notificationclick` handler.
- Create `ui/src/components/DesktopNotificationsSetting.tsx`; mount in `ui/src/pages/InstanceGeneralSettings.tsx`.
- Tests beside each.

---

### Task 1: Notification module

**Files:**
- Create: `ui/src/lib/desktop-notifications.ts`
- Test: `ui/src/lib/desktop-notifications.test.ts` (`// @vitest-environment jsdom`)

**Interfaces:**
- Produces:
  - `interface DesktopNotificationInput { title: string; body?: string; href: string; tag: string }`
  - `type DesktopNotificationAvailability = "available" | "unsupported" | "insecure" | "denied"`
  - `desktopNotificationAvailability(): DesktopNotificationAvailability`
  - `isDesktopNotificationsEnabled(): boolean` (flag on AND availability `"available"` AND `Notification.permission === "granted"`)
  - `enableDesktopNotifications(): Promise<"enabled" | "denied" | "unsupported" | "insecure">`
  - `disableDesktopNotifications(): void`
  - `showDesktopNotification(input: DesktopNotificationInput): Promise<boolean>`

- [ ] **Step 1: Write failing tests.** Cases, each stubbing `window.Notification`, `window.isSecureContext`, `navigator.serviceWorker.ready`:
  - `availability is "insecure" when isSecureContext is false`
  - `availability is "unsupported" when Notification is missing`
  - `availability is "denied" when permission is "denied"`
  - `enable resolves "enabled", stores the flag, when requestPermission resolves "granted"`
  - `enable resolves "denied" and leaves the flag off when requestPermission resolves "denied"`
  - `isDesktopNotificationsEnabled is false when localStorage throws`
  - `show calls registration.showNotification(title, { body, tag, data: { href } }) and resolves true`
  - `show resolves false without calling showNotification when not enabled`
- [ ] **Step 2:** Run `pnpm vitest run ui/src/lib/desktop-notifications.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement the module** with the signatures above. Use `navigator.serviceWorker.ready` for the registration; return `false` on any rejection.
- [ ] **Step 4:** Re-run the test file. Expected: PASS.

---

### Task 2: Attention-feed notification tracker

**Files:**
- Create: `ui/src/lib/desktop-notification-attention.ts` (replaces `desktop-notification-events.ts` from the first attempt; delete that file and its test in the same commit)
- Test: `ui/src/lib/desktop-notification-attention.test.ts`

**Why this shape:** over the live websocket, authenticated clients receive `activity.logged` with only `action`, `entityType` and `entityId` (`server/src/realtime/live-events-ws.ts:356-368`): no `details`, and no `actorType`/`actorId` outside issue activity. Needs-input content cannot be read from the event. The viewer-filtered attention feed (`attentionApi.list(companyId, { all: true, view: "mine" })`) already holds exactly the items that need this person, with `whyNow`, subject title and href. Events only trigger a check; the feed supplies the content.

**Interfaces:**
- Consumes: `DesktopNotificationInput` (Task 1), `LiveEvent`, `AttentionFeed`, `AttentionItem` from `@paperclipai/shared`.
- Produces:
  - `isAttentionTrigger(event: LiveEvent): boolean`: true for `activity.logged` whose `payload.action` is one of `approval.created`, `issue.thread_interaction_created`, `decision.created`, `join.requested`, `join.request_replayed`, or starts with `attention.`; false otherwise.
  - `createAttentionNotificationTracker(): { observe(feed: AttentionFeed): DesktopNotificationInput[] }`

Tracker behaviour:
- The first `observe` records the ids in the feed and returns `[]` (baseline).
- Later `observe` calls return one notification per item whose `id` was not in the previous observed feed, excluding items with `sourceKind === "failed_run"` (the run-status path covers those), `severity === "low"`, or `dismissal?.isActive === true`. Then the seen set is replaced by the current feed's ids, so an item that leaves and later returns notifies again.
- Notification fields: `title: item.whyNow`; `body: [subject.identifier, subject.title].filter(Boolean).join(" ")` or `undefined` when empty; `href: item.subject.href` when it is a string starting with `/`, else `/inbox/mine`; `tag: "attention:" + item.dedupKey`.

- [ ] **Step 1: Write failing tests:**
  - `isAttentionTrigger is true for each needs-input action and for attention.claimed`
  - `isAttentionTrigger is false for issue.updated, a non-activity.logged event, and a missing action`
  - `first observe returns no notifications and sets the baseline`
  - `a new item after the baseline returns the exact notification fields`
  - `an item already seen returns nothing`
  - `failed_run, low-severity and actively dismissed items are excluded`
  - `an item that leaves the feed and returns notifies again`
  - `href falls back to /inbox/mine for a null or non-slash subject.href`
  - `body is undefined when the subject has no identifier and no title`
- [ ] **Step 2:** Run `pnpm vitest run ui/src/lib/desktop-notification-attention.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the two exports above; remove `ui/src/lib/desktop-notification-events.ts` and `.test.ts`.
- [ ] **Step 4:** Re-run. Expected: PASS.

---

### Task 3: Desktop path in LiveUpdatesProvider

**Files:**
- Modify: `ui/src/context/LiveUpdatesProvider.tsx` (`observeRunOutcome` ~2093, `onmessage` ~2604, `__liveUpdatesTestUtils` ~2358)
- Test: `ui/src/context/LiveUpdatesProvider.test.ts` (extend; existing `handleLiveEvent` tests near line 456 show the harness) and `ui/src/context/LiveUpdatesProvider.hook.test.tsx` for the hidden-tab wiring.

**Interfaces:**
- Consumes: `isAttentionTrigger`, `createAttentionNotificationTracker` (Task 2), `showDesktopNotification` and `isDesktopNotificationsEnabled` (Task 1), `attentionApi.list` (`ui/src/api/attention.ts`), `coordinatorAttentionQueryKey(companyId, userId, view)` (as used in `ui/src/hooks/useAttentionViews.ts`), `buildActivityToast`, `buildRunStatusToast`, `shouldSuppressToast`, `recordToastHit`, `isPageForegrounded`.
- Produces:
  - `isRunOutcomeStale(event: LiveEvent): boolean`, the age check extracted from `observeRunOutcome` (`deliveredAt - finishedAt > RUN_TOAST_MAX_AGE_MS`); `observeRunOutcome` calls it and keeps its set mutation.
  - `desktopNotificationForEvent(queryClient: QueryClient, expectedCompanyId: string, event: LiveEvent, currentActor: { userId: string | null; agentId: string | null }): DesktopNotificationInput | null`: for `activity.logged` with `event.toastEligible === true` converts `buildActivityToast(...)` to `{ title, body, href: toast.action?.href ?? "/inbox/mine", tag: toast.dedupeKey ?? "activity:<entityId>:<action>" }`; for `heartbeat.run.status` with `event.toastEligible === true` and `!isRunOutcomeStale(event)` converts `buildRunStatusToast(payload, nameOf)` the same way with tag `run:<runId>:<status>`; `null` otherwise or when `event.companyId !== expectedCompanyId`.
  - `notifyDesktopForEvent(queryClient, expectedCompanyId, event, gate: ToastGate, currentActor, show = showDesktopNotification): void`: returns immediately unless `isDesktopNotificationsEnabled()` and `!isPageForegrounded()` and `Date.now() >= gate.suppressUntil`; computes the notification; applies `shouldSuppressToast(gate, "desktop:" + tag-prefix)`; calls `show` and `recordToastHit`.
  - `createDesktopAttentionWatcher(options: { queryClient: QueryClient; companyId: string; getUserId: () => string | null; gate: ToastGate; show?: typeof showDesktopNotification; fetchFeed?: () => Promise<AttentionFeed>; debounceMs?: number }): { onEvent(event: LiveEvent): void; seed(): Promise<void>; dispose(): void }`
    - `seed()` fetches the `mine` feed once and runs `tracker.observe` for the baseline; skipped (resolves) when `getUserId()` is null. A trigger that arrives before seeding finishes waits for it.
    - `onEvent(event)`: acts only when `event.companyId === companyId`, `isAttentionTrigger(event)`, `isDesktopNotificationsEnabled()` and `!isPageForegrounded()`. It debounces (default 1000 ms) so a burst yields one fetch, then fetches via `queryClient.fetchQuery({ queryKey: coordinatorAttentionQueryKey(companyId, userId, "mine"), queryFn: () => attentionApi.list(companyId, { all: true, view: "mine" }), staleTime: 0 })` (the same key the sidebar badge reads), runs `tracker.observe`, and for each result applies the gate (`Date.now() >= gate.suppressUntil`, `shouldSuppressToast(gate, "desktop:attention")`, then `recordToastHit`) before `show`. A rejected fetch notifies nothing and leaves the baseline unchanged; the next trigger retries. It runs no other cache invalidation.
    - `dispose()` cancels a pending debounce.
  - `isRunOutcomeStale`, `desktopNotificationForEvent`, `notifyDesktopForEvent`, `createDesktopAttentionWatcher` are exported on `__liveUpdatesTestUtils`.

- [ ] **Step 1: Write failing tests** with injected `show`, `fetchFeed`, fake timers and a stubbed foreground state:
  - Watcher: `seed sets the baseline and notifies nothing`
  - Watcher: `an approval.created trigger while hidden fetches the mine feed and notifies the new item`
  - Watcher: `a burst of 50 triggers produces one fetch`
  - Watcher: `does not fetch while the page is foregrounded, when disabled, for a non-trigger action, or for another company`
  - Watcher: `does not notify inside gate.suppressUntil`
  - Watcher: `a failed fetch notifies nothing and a later trigger still notifies`
  - Task/run: `notifies for a toast-eligible issue.comment_added while hidden`
  - Task/run: `does not notify while foregrounded or when disabled`
  - Task/run: `does not notify for a stale run outcome or for another company`
  - Task/run: `caps a burst at TOAST_COOLDOWN_MAX`
  - Task/run: `visible-but-unfocused: calling notifyDesktopForEvent then handleLiveEvent for the same failed-run event still pushes the run toast once` (guards the dedupe collision)
  - Hook test: `a hidden page delivers approval.created to the watcher and runs no cache invalidation`.
- [ ] **Step 2:** Run `pnpm vitest run ui/src/context/LiveUpdatesProvider.test.ts ui/src/context/LiveUpdatesProvider.hook.test.tsx`. Expected: new tests FAIL.
- [ ] **Step 3: Extract `isRunOutcomeStale`** and leave `observeRunOutcome` behaviour unchanged (existing tests must still pass).
- [ ] **Step 4: Implement `desktopNotificationForEvent`, `notifyDesktopForEvent` and `createDesktopAttentionWatcher`** next to the toast builders.
- [ ] **Step 5: Hook up the provider with a dedicated background socket.** The main socket effect closes its socket whenever the page is hidden (`if (!visible)` early return in the effect) and a test asserts that, so it never sees events for a hidden tab. Leave that effect untouched. Add a separate effect in `LiveUpdatesProvider` that is active only when `isDesktopNotificationsEnabled()` (read reactively via `useSyncExternalStore(subscribeDesktopNotificationsEnabled, isDesktopNotificationsEnabled)`), the page is backgrounded (`!visible || !focused` from `usePageVisibility()`), `canConnectSocket` and `liveCompanyId` are set. While active it creates one `createDesktopAttentionWatcher`, seeds it, opens its own websocket to `/api/companies/<liveCompanyId>/events/ws` (same `buildSameOriginWebSocketUrl`/`tryCreateWebSocket` helpers, reconnect with capped exponential backoff), and for each parsed `LiveEvent` calls `notifyDesktopForEvent(...)` and `watcher.onEvent(...)`. It runs no cache invalidation. Cleanup closes the socket quietly, clears timers and disposes the watcher; returning to the foreground triggers that cleanup, and every new backgrounding re-seeds the baseline.
- [ ] **Step 5b: Task 1 amendment.** Add `subscribeDesktopNotificationsEnabled(listener: () => void): () => void` to `ui/src/lib/desktop-notifications.ts`: listeners fire after `enableDesktopNotifications` resolves `"enabled"` and after `disableDesktopNotifications`, and on the window `storage` event for the opt-in key; the returned function unsubscribes. Tests: `listener fires on enable`, `listener fires on disable`, `unsubscribed listener does not fire`.
- [ ] **Step 5c: Hook tests:** `a backgrounded page with desktop notifications enabled opens a dedicated socket and delivers approval.created to the watcher`, `no dedicated socket while the page is focused`, `no dedicated socket when desktop notifications are disabled`, `returning to the foreground closes the dedicated socket`, and the existing `main socket closes when hidden` test still passes. Drive visibility through real `visibilitychange`/`focus`/`blur` events or by mocking `usePageVisibility`, never by flipping `document.visibilityState` without an event.
- [ ] **Step 6:** Re-run both files. Expected: PASS, including every pre-existing test.

---

### Task 4: Service worker click-through

**Files:**
- Modify: `ui/public/sw.js`
- Test: `ui/src/lib/sw-notification-click.test.ts`, loaded the same way as `sw-offline-fallback.test.ts` (reads `public/sw.js`, evaluates with a fake `self`).

**Interfaces:** consumes the `data: { href }` set in Task 1.

- [ ] **Step 1: Write failing tests:**
  - `closes the notification and focuses an existing same-origin window, navigating it to href`
  - `opens a new window at href when no window client exists`
  - `falls back to openWindow when client.navigate rejects`
  - `opens "/" when the notification carries no href`
- [ ] **Step 2:** Run `pnpm vitest run ui/src/lib/sw-notification-click.test.ts`. Expected: FAIL.
- [ ] **Step 3: Add a `notificationclick` listener** to `sw.js`: close the notification, `clients.matchAll({ type: "window", includeUncontrolled: true })`, prefer a client whose URL origin equals `self.location.origin`, `focus()` then `navigate(url)`, else `clients.openWindow(url)`; wrap in `event.waitUntil`.
- [ ] **Step 4:** Re-run that file plus `pnpm vitest run ui/src/lib/sw-offline-fallback.test.ts ui/src/lib/service-worker-cache-policy.test.ts`. Expected: PASS.

---

### Task 5: Settings toggle

**Files:**
- Create: `ui/src/components/DesktopNotificationsSetting.tsx`
- Modify: `ui/src/pages/InstanceGeneralSettings.tsx` (new `<section>` after "Censor username in logs", same layout and `ToggleSwitch`)
- Test: `ui/src/components/DesktopNotificationsSetting.test.tsx`; extend `ui/src/pages/InstanceGeneralSettings.test.tsx` to assert the section renders.

**Interfaces:**
- Consumes: Task 1 functions.
- Produces: `DesktopNotificationsSetting(): JSX.Element`, with heading `Desktop notifications`, helper text stating it applies to this browser only and needs Chrome running with a Paperclip tab open, a `ToggleSwitch` with `aria-label="Toggle desktop notifications"`.

States: `available` toggle works; `denied` shows `Blocked in browser settings` and disables the toggle; `insecure` shows `Requires https or localhost` and disables it; `unsupported` shows `Not supported in this browser` and disables it.

- [ ] **Step 1: Write failing tests:** one per state, plus `turning the toggle on calls enableDesktopNotifications and reflects "enabled"`, `a denied result shows the blocked message and leaves the toggle off`, `turning it off calls disableDesktopNotifications`.
- [ ] **Step 2:** Run `pnpm vitest run ui/src/components/DesktopNotificationsSetting.test.tsx ui/src/pages/InstanceGeneralSettings.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement the component** with local state initialised from `isDesktopNotificationsEnabled()` and `desktopNotificationAvailability()`; use only existing design tokens and classes from neighbouring sections.
- [ ] **Step 4:** Re-run. Expected: PASS.

---

### Task 6: Verify and hand off

- [ ] **Step 1:** Run `pnpm verify`. Expected: exit 0. If exit 2, run the focused files from Tasks 1 to 5 and let CI supply the rest (AGENTS.md section 7).
- [ ] **Step 2:** Run `pnpm --filter @paperclipai/ui typecheck` (or the `ui` package name from `ui/package.json`). Expected: no errors.
- [ ] **Step 3: Manual check in Chrome on macOS:** enable the toggle and grant permission; switch to another app; trigger an approval request (agent `request_board_approval` or the approvals route); confirm the notification appears and clicking it focuses Paperclip at `/inbox/mine`. Repeat with the tab hidden behind another Chrome tab. Report anything not run.
- [ ] **Step 4:** `git status`, stage only the files above, single commit `feat(ui): desktop notifications for needs-input and task updates`, ending with the Co-Authored-By line from the session attribution.
