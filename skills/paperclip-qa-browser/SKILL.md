---
name: paperclip-qa-browser
description: >
  Verify a finished task or bug fix by reading the story and the code, then
  exploring the change by hand in a Playwright browser against the app running
  locally. Use for any QA, local E2E or verification task assigned to you, on
  an `in_review` issue or not. A missing QA login, credentials file or seed
  data is not a reason to skip the browser run: this skill covers writing the
  network stubs that replace them.
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

### Signing in to the Atlas explore UI without a login

The app signs in through Auth0 (`loginWithRedirect` in `src/routes/_protected.tsx`). A trial run (TAC-160) got past it with no saved login by answering the Auth0 round trip itself. `browser_route` cannot do this, because the response must echo values from the request. Use `browser_run_code_unsafe` and register `context.route` handlers:

1. Read the Auth0 `domain`, `clientId` and `audience` from `public/config/config.js`.
2. Answer `GET https://<domain>/authorize` with a `302` to `http://localhost:3000/?code=fakecode&state=<state from the request>`. Keep the `nonce` from the request.
3. Answer `POST https://<domain>/oauth/token` with JSON `access_token`, `id_token`, `token_type: "Bearer"` and `expires_in`. Build `id_token` as a JWT with header `alg: RS256` and a dummy signature, and claims `iss` (`https://<domain>/`), `aud` (the `clientId`), the captured `nonce`, `sub`, `name`, `email`, `iat`, `exp`, and the roles claim `<authClaimsNamespace>/roles` holding the role the screen needs (see `src/common/constants/roles.ts` and `src/common/hooks/usePermissions`).
4. Register the catch-all and the API stubs from "Writing the stubs", then open `http://localhost:3000`.

Things the trial found:

- The Auth0 SDK did not verify the token signature, so no key endpoint needed stubbing. Assumed to hold only for the SDK version in the repo; if sign-in fails after an upgrade, check whether the SDK now verifies the signature.
- The return path keeps only the pathname, so a `?tab=` query is dropped. Click the tab.
- State set on `globalThis` does not survive between `browser_run_code_unsafe` calls. To change a stub, register a later override route for the same URL.
- The token is fake and works only against `localhost`. Never use real credentials for this.

## Step 3 — Use the Playwright browser

Your tools include the `browser_*` tools of the `Playwright browser` MCP server (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_console_messages`, `browser_network_requests`, `browser_take_screenshot` and others). Paperclip connects that browser to your run in one of two ways, set on the agent:

- **Isolated (default):** a fresh, headless Chrome with the saved QA login restored. Nothing is left running after the run ends, and no other agent shares it.

Work one action at a time and read each result before choosing the next:

- `browser_snapshot` is how you read the page. It returns the page as text and costs far fewer tokens than a screenshot. Prefer it for every check.
- `browser_take_screenshot` saves an image file as evidence. Images are not shown to you unless the agent has `browser.images` enabled, so judge from the snapshot and keep the file as proof.
- Watch `browser_console_messages` and `browser_network_requests` after each action that touches the change.

You also have `browser_route`: it answers requests matching a URL pattern with a status and body you choose. This is how you stub the application so you can reach the screen under test without signing in or seeding data. Step 4 says how to write the stubs. If `browser_route` is missing, the agent has `browser.mockNetwork` switched off; use the other routes in Step 4.

If your tools include no `browser_*` tools, the agent has not been given the browser. Post a comment saying so, set the issue to `blocked`, and stop. The fix is the agent's `browser.enabled` setting, not a workaround: do not start your own Chrome, do not attach to a CDP port yourself (Paperclip does that when the agent has `browser.cdpEndpoint`), and do not write Playwright scripts.

## Step 4 — Starting state, and when you need the human

The human may have set things up before handing over. The issue or the hand-off comment can say "start at URL X, this is already done". Take that as your starting point: open the URL, confirm the state is really there, and continue from it. Setup is saved state, not a live tab, so anything the human left unsaved is not visible to you; say so and ask for it to be saved.

Get the state you need in this order:

1. **Write the stubs yourself** when the check is about how the page renders what the backend gives it. You already know from Step 1 which screen changed and which API calls it makes. No login and no seeded data are needed. See "Writing the stubs" below.
2. **Reuse an existing campaign** that fits. Ask for one, or find it from the read-only database tools if you have them.
3. **Create it through the application's API** when the data is cheap to create and the API is available to you.
4. **Ask the human** to create it or perform the action, as below.

A stubbed check never replaces an unstubbed one for the same change: stubs prove the page renders what it is given, not that the backend returns it. Do the backend half separately: call the real API, read the result back through a second API call, and use the read-only database tools for what the API does not show.

Never write to the database directly and never touch production: the QA database is read-only to you, and the backends are UK non-prod.

Ask instead of guessing when:

- the page shows a login wall and stubbing the session is not available or does not get past it: the saved login is missing or expired, or the QA Chrome has been signed out
- the flow needs data you cannot create or reuse, for example campaigns, strategies and tactics in Atlas
- the correct URL is not in the issue and not the default

Create one `ask_user_questions` interaction with `answerMode: "text"`, `resolverPolicy: "human_only"` and `continuationPolicy: "wake_assignee"`. State exactly what to do and what to send back:

> Sign in once so I can reuse the login: run `node skills/paperclip-qa-browser/scripts/save-login.mjs http://localhost:3000` from the repo root, sign in in the window it opens, press Enter in the terminal, then reply "signed in".


> Create a campaign with at least one strategy and two tactics, then reply with the URL of the campaign page.

Then follow the waiting posture in the `paperclip` skill: confirm the interaction is saved and pending, set the issue to `in_review`, and exit. You are woken with the answer; resume at Step 5 with the URL they gave.

Never type the human's credentials, never fetch the e2e service-account secret, and never read cookies, tokens or the saved login file. There is no login bypass to reach for: the Atlas e2e suite (`atlas-planner-e2e`) signs in through real Auth0, and its saved session is for the QA origin, not `localhost`. The saved login here is the equivalent: once the human has signed in at `localhost:3000` with `save-login.mjs`, every later isolated run starts signed in. An attached run keeps the login in the QA Chrome profile instead.

### Writing the stubs

Derive them from what Step 1 found; do not ask for stub files.

1. **List the calls.** From the code around the change, list every request the screen makes on load and on each action you will take: method, URL pattern, and what the page does with the response.
2. **Build each response from a real source**, in this order: an existing test fixture or mock for the same endpoint, the shared type or schema, the handler's return value. Fill every field the page reads, with values that make the case you are testing visible, such as a long name, an empty list, or the status the change handles. Never invent a field the real response does not have.
3. **Register a catch-all first, then the specifics.** `browser_route` pattern `**/api/**` with status `599` and body `unstubbed`, then one call per stub. A later route wins over an earlier one, so the specifics override the catch-all. An unstubbed call that fails is a gap in your stubs, not a finding.
4. **Fake the signed-in state.** Stub the endpoint the app calls to learn who the user is. If the app instead reads a token from storage, set it with `browser_evaluate` and reload. If the app validates tokens against an identity provider, stub that provider's discovery and key endpoints too; if that is not enough to get past sign-in, fall back to the saved login or ask the human.
5. **Deep-link to the page** and work the cases the stubs make cheap: change a stub with `browser_route` between actions to show an empty list, an error status, or a slow response.
6. **Re-register after a restart.** Routes last as long as the browser. If a tool result shows the page behaving as if unstubbed, the browser was restarted; register them again.

Limits you must report:

- Server-rendered pages fetch on the server, so `browser_route` never sees those calls. If the page does not change when you change a stub, say so and fall back to real data.
- A stub you could not tie to a real source in step 2 proves nothing. Mark it as a guess in the verdict.
- Stubs prove how the page renders what it is given, not that the backend returns that data. The verdict says "UI against stubs", lists the stubbed URLs, and never calls a stubbed pass end-to-end. Do the backend half separately, as above.

## Step 5 — Explore and judge

Work from what Step 1 told you to expect:

- Reach the changed behaviour the way a user would, and confirm it matches what the story and the code say.
- Then push on it: the cases that made you suspicious in Step 1, empty and error states, doing it twice, going back and reloading, a second role if permissions are involved.
- Watch the console and network panel during every action. An uncaught error or a 5xx on a path the change touches is a failure even when the page looks right.
- When something looks wrong, go back to the code to see whether it is a bug, an intended trade-off, or your misreading, before you report it.

Keep to the change and its immediate neighbours. Save a screenshot with `browser_take_screenshot` for each thing you rely on in the verdict: the state that proves a pass, and every failure.

## Step 6 — Record the verdict

Post one comment and the status change in the same `PATCH`:

Mark a criterion pass only when the criterion as written holds. If you measure a deviation, such as a table that moves when the story says it must not, report it as a fail with the numbers, even if the rest of the item passes.

Attach each screenshot to the issue as a work product, following the `paperclip` skill, so the evidence outlives the run's temporary directory. A local path alone is not enough.

- Pass: `{ "status": "done", "comment": "Approved: <commit tested>, <URL>. Verified: <what you saw, tied to each criterion>. Not tested: <gaps>. Evidence: <screenshot paths>" }`
- Fail: `{ "status": "in_progress", "comment": "Changes requested: <what you did>, expected <x>, got <y>. Console/network: <errors>. Likely cause: <code location if you found it>. Evidence: <screenshot path>" }`

A failure comment must let the implementer reproduce without asking you anything: exact URL, exact actions, observed result.

Say plainly what you did not test, including every URL you stubbed. Do not approve a flow you could only partly exercise; request changes or block it with the gap named.
