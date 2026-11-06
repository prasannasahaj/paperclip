---
name: paperclip-qa-browser
description: >
  Verify a finished task or bug fix by understanding the change from the story
  and the code, then exploring it by hand in real Chrome against the local build.
  Use when you are the tester or reviewer on an issue in `in_review` and must
  confirm the behaviour in the browser before approving or sending it back.
---

# Paperclip QA Browser

You are the tester. The implementer has finished and parked the issue in `in_review` with you as `currentParticipant`. This is exploratory verification, not a regression suite: you read the story and the code, decide what should now be true, then look at it in Chrome and judge it. Do not write test scripts or assertion files. Reading the diff alone is not enough, and neither is a screenshot of the happy path.

If you cannot reach a local display or Chrome, say so in a comment and move the issue to `blocked` rather than approving untested work.

## Step 1 — Understand the change from the code

Before opening the browser:

1. Read the issue description, acceptance criteria, implementer's hand-off comment and linked MR.
2. Read the diff and the code around it: the components, routes, API handlers and state the change touches. Find the entry point a user would reach it from.
3. Write down, in the run's notes, what a user should now see or be unable to do, and how it differs from before. Include the cases the code makes you suspicious of: unhandled states, early returns, conditions the diff only half covers, behaviour that moved but whose old callers did not.

If the story and the code disagree, that is already a finding. If neither tells you what "correct" looks like, request changes asking for acceptance criteria; do not invent criteria and then pass them.

## Step 2 — Get a running build

Target URL, in priority order:

1. A URL named in the issue or the implementer's hand-off comment.
2. For the Paperclip UI itself: the Vite dev server, `http://localhost:5173`. It proxies the API, which listens on the `port` in `~/.paperclip/instances/default/config.json` (3100, or 3101 when that is taken). The API port alone serves no UI: `GET /` returns `Cannot GET /`.
3. Ask the human (Step 4).

Check it responds: `curl -s -o /dev/null -w "%{http_code}" <url>`. If it is not running, start it from the implementer's workspace and wait for it:

- `pnpm dev:server` and `pnpm dev:ui` as separate background processes.
- `pnpm dev` also builds the native runner and fails without `cargo`; use it only where Rust is installed.

Note the commit you are testing. If the build will not start, request changes with the error output.

### Atlas explore UI (`atlas-explore-ui`)

Run it from the issue's worktree with `npm run dev` (Vite on `http://localhost:3000`). It needs two gitignored files that a fresh worktree does not have: `.env.local` (copied from `.env.example` by `scripts/setup.sh`, plus the Mapbox token) and `.npmrc` (private registry). Copy both from the main checkout; they are not in git and you must not read their contents or print them:

```bash
cp "$PAPERCLIP_WORKSPACE_BASE_CWD/.env.local" "$PAPERCLIP_WORKSPACE_BASE_CWD/.npmrc" .
```

If the main checkout has no `.env.local`, stop and ask the human; do not recreate it.

To run only the UI against QA backends, `.env.local` must set `VITE_USE_PROXY='true'` (see `docs/local-setup.md` in that repo). Sign-in then uses the QA Auth0 tenant, so a QA account is required.

## Step 3 — Open Chrome and pick your hands

Preferred, when your tools include `mcp__claude-in-chrome__*`: use them. They drive the human's own Chrome with their existing logins.

Otherwise open the QA window:

```bash
node skills/paperclip-qa-browser/scripts/open-session.mjs <url>
```

It opens a visible Chrome on a dedicated profile at `~/.paperclip/qa-chrome-profile` and prints `{"cdpUrl": "http://127.0.0.1:9333", ...}`. Rerunning reuses the open window. The human signs in once; the login persists across runs. (Chrome 136+ refuses remote debugging on the everyday profile, so that profile cannot be attached to.)

The launcher starts Chrome with `--use-mock-keychain --password-store=basic`, so it never touches the macOS Keychain. Without that, a Chrome started from a background or sandboxed process fails with "A keychain cannot be found to store Chrome". The cost is that this profile's cookies are not Keychain-protected, so keep only QA logins in it.

Then use an interactive browser tool attached to that window, one action at a time, looking at the result of each before choosing the next:

- Chrome DevTools MCP attached to the window: `npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9333`. It gives you page snapshots, click, fill, console messages, network requests and screenshots as tools. If your adapter lets you add MCP servers and this one is not already configured, ask the human to add it.
- If you have no interactive browser tool at all, fall back to short one-off commands over the same CDP endpoint (Playwright's `chromium.connectOverCDP`, run from the repo root). This is the fallback, not the method: use it to look and click, not to encode a test.

## Step 4 — When you need the human

Ask instead of guessing when:

- the page shows a login wall and the QA profile is not signed in
- the flow needs seeded data you cannot create yourself, for example campaigns, strategies and tactics in Atlas
- the correct URL is not in the issue and not the default

Create one `ask_user_questions` interaction with `answerMode: "text"`, `resolverPolicy: "human_only"` and `continuationPolicy: "wake_assignee"`. State exactly what to do and what to send back:

> Chrome is open at the QA profile. Sign in there if asked, create a campaign with at least one strategy and two tactics, then reply with the URL of the campaign page.

Then follow the waiting posture in the `paperclip` skill: confirm the interaction is saved and pending, set the issue to `in_review`, and exit. You are woken with the answer; resume at Step 5 with the URL they gave.

Never type the human's credentials, never fetch the e2e service-account secret, and never read cookies or tokens out of the profile. There is no login bypass to reach for: the Atlas e2e suite (`atlas-planner-e2e`) signs in through real Auth0 and reuses the saved session, and its saved session is for the QA origin, not `localhost`. The equivalent here is the QA profile: once the human has signed in at `localhost:3000` in that window, later runs are already signed in.

After the first sign-in the window can run without a display: `QA_CHROME_HEADLESS=1 node skills/paperclip-qa-browser/scripts/open-session.mjs <url>`. Use headless only once the profile is signed in; a login wall in headless needs a headed window for the human.

## Step 5 — Explore and judge

Work from what Step 1 told you to expect:

- Reach the changed behaviour the way a user would, and confirm it matches what the story and the code say.
- Then push on it: the cases that made you suspicious in Step 1, empty and error states, doing it twice, going back and reloading, a second role if permissions are involved.
- Watch the console and network panel during every action. An uncaught error or a 5xx on a path the change touches is a failure even when the page looks right.
- When something looks wrong, go back to the code to see whether it is a bug, an intended trade-off, or your misreading, before you report it.

Keep to the change and its immediate neighbours. Save a screenshot under `qa/` for each thing you rely on in the verdict: the state that proves a pass, and every failure.

## Step 6 — Record the verdict

Post one comment and the status change in the same `PATCH`:

- Pass: `{ "status": "done", "comment": "Approved: <commit tested>, <URL>. Verified: <what you saw, tied to each criterion>. Not tested: <gaps>. Evidence: <screenshot paths>" }`
- Fail: `{ "status": "in_progress", "comment": "Changes requested: <what you did>, expected <x>, got <y>. Console/network: <errors>. Likely cause: <code location if you found it>. Evidence: <screenshot path>" }`

A failure comment must let the implementer reproduce without asking you anything: exact URL, exact actions, observed result.

Say plainly what you did not test. Do not approve a flow you could only partly exercise; request changes or block it with the gap named.
