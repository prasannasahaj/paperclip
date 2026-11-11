---
name: paperclip-qa-browser
description: >
  Verify a finished task or bug fix by reading the story and the code, then
  exploring the change by hand in a Playwright browser. Use when you are the
  tester on an `in_review` issue and must confirm behaviour before approving.
---

# Paperclip QA Browser

You are the tester. The implementer has finished and parked the issue in `in_review` with you as `currentParticipant`. This is exploratory verification, not a regression suite: you read the story and the code, decide what should now be true, then look at it in the browser and judge it. Do not write test scripts or assertion files. Reading the diff alone is not enough, and neither is a screenshot of the happy path.

If you have no browser tools, say so in a comment and move the issue to `blocked` rather than approving untested work.

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

## Step 3 — Use the Playwright browser

Your tools include the `browser_*` tools of the `Playwright browser` MCP server (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_console_messages`, `browser_network_requests`, `browser_take_screenshot` and others). Paperclip starts that browser with your run: a fresh, isolated, headless Chrome that has the saved QA login restored. Nothing is left running after the run ends, and no other agent shares it.

Work one action at a time and read each result before choosing the next:

- `browser_snapshot` is how you read the page. It returns the page as text and costs far fewer tokens than a screenshot. Prefer it for every check.
- `browser_take_screenshot` saves an image file as evidence. Images are not shown to you unless the agent has `browser.images` enabled, so judge from the snapshot and keep the file as proof.
- Watch `browser_console_messages` and `browser_network_requests` after each action that touches the change.

If your tools include no `browser_*` tools, the agent has not been given the browser. Post a comment saying so, set the issue to `blocked`, and stop. The fix is the agent's `browser.enabled` setting, not a workaround: do not start your own Chrome, do not attach to a CDP port, and do not write Playwright scripts.

## Step 4 — Starting state, and when you need the human

The human may have set things up before handing over. The issue or the hand-off comment can say "start at URL X, this is already done". Take that as your starting point: open the URL, confirm the state is really there, and continue from it. Setup is saved state, not a live tab, so anything the human left unsaved is not visible to you; say so and ask for it to be saved.

Get the data you need in this order:

1. **Reuse an existing campaign** that fits. Ask for one, or find it from the read-only database tools if you have them.
2. **Create it through the application's API** when the data is cheap to create and the API is available to you.
3. **Ask the human** to create it or perform the action, as below.

Never write to the database directly and never touch production: the QA database is read-only to you, and the backends are UK non-prod.

Ask instead of guessing when:

- the page shows a login wall: the saved login is missing or expired
- the flow needs data you cannot create or reuse, for example campaigns, strategies and tactics in Atlas
- the correct URL is not in the issue and not the default

Create one `ask_user_questions` interaction with `answerMode: "text"`, `resolverPolicy: "human_only"` and `continuationPolicy: "wake_assignee"`. State exactly what to do and what to send back:

> Sign in once so I can reuse the login: run `node skills/paperclip-qa-browser/scripts/save-login.mjs http://localhost:3000` from the repo root, sign in in the window it opens, press Enter in the terminal, then reply "signed in".

> Create a campaign with at least one strategy and two tactics, then reply with the URL of the campaign page.

Then follow the waiting posture in the `paperclip` skill: confirm the interaction is saved and pending, set the issue to `in_review`, and exit. You are woken with the answer; resume at Step 5 with the URL they gave.

Never type the human's credentials, never fetch the e2e service-account secret, and never read cookies, tokens or the saved login file. There is no login bypass to reach for: the Atlas e2e suite (`atlas-planner-e2e`) signs in through real Auth0, and its saved session is for the QA origin, not `localhost`. The saved login here is the equivalent: once the human has signed in at `localhost:3000` with `save-login.mjs`, every later run starts signed in.

## Step 5 — Explore and judge

Work from what Step 1 told you to expect:

- Reach the changed behaviour the way a user would, and confirm it matches what the story and the code say.
- Then push on it: the cases that made you suspicious in Step 1, empty and error states, doing it twice, going back and reloading, a second role if permissions are involved.
- Watch the console and network panel during every action. An uncaught error or a 5xx on a path the change touches is a failure even when the page looks right.
- When something looks wrong, go back to the code to see whether it is a bug, an intended trade-off, or your misreading, before you report it.

Keep to the change and its immediate neighbours. Save a screenshot with `browser_take_screenshot` for each thing you rely on in the verdict: the state that proves a pass, and every failure.

## Step 6 — Record the verdict

Post one comment and the status change in the same `PATCH`:

- Pass: `{ "status": "done", "comment": "Approved: <commit tested>, <URL>. Verified: <what you saw, tied to each criterion>. Not tested: <gaps>. Evidence: <screenshot paths>" }`
- Fail: `{ "status": "in_progress", "comment": "Changes requested: <what you did>, expected <x>, got <y>. Console/network: <errors>. Likely cause: <code location if you found it>. Evidence: <screenshot path>" }`

A failure comment must let the implementer reproduce without asking you anything: exact URL, exact actions, observed result.

Say plainly what you did not test. Do not approve a flow you could only partly exercise; request changes or block it with the gap named.
