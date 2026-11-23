# QA browser

QA agents verify finished work in a real browser through a Playwright MCP server that Paperclip starts with the agent's run.

## How it works

- The ACPX engine adds a stdio MCP server named `Playwright browser` to a **local Claude** run when the agent's adapter config sets `browser.enabled: true` (`packages/adapter-utils/src/acpx-engine/playwright-browser.ts`).
- The server is the pinned `@playwright/mcp` dependency of `@paperclipai/adapter-utils`, launched with the server's own Node. There is no `npx` download at run time.
- Each run gets an in-memory browser (`--isolated`). Nothing is copied or left on disk except per-run output (`<agent state dir>/runs/<runId>/browser/`), so parallel runs cannot lock each other. The Claude session owns the process and ends it with the run.
- Logins come from a saved Playwright storage state file, restored at start. If the file is missing the browser starts signed out and the run log says so.
- Remote and sandbox execution targets and non-Claude agents are skipped with a log line.

## Agent config

```json
{ "browser": { "enabled": true } }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Attach the browser to the run. |
| `headed` | `false` | Show the browser window. Use it to watch a run on your own machine. |
| `images` | `false` | Send screenshots to the model. Off keeps tokens low; the page is read as a text snapshot. |
| `storageStatePath` | `<instance root>/qa-browser/storage-state.json` | Saved login to restore. |
| `allowedOrigins` | none | Origins the browser may request. Not a security boundary: redirects are not covered. |
| `mockNetwork` | `true` | Give the agent the `browser_route` tool (Playwright MCP `--caps network`) so it can write stubs for the screen it is verifying. Set `false` to withhold it. |

Remove the legacy `chrome: true` setting from the agent; the QA Verifier's ACP runs exposed no Chrome tools with it (run `f5f80d24`).

## Save the QA login once

```sh
node skills/paperclip-qa-browser/scripts/save-login.mjs http://localhost:3000
```

Sign in in the window that opens, then press Enter in the terminal. The file is written with mode `0600`. It holds session cookies and local storage for the QA account, so keep only QA logins in it. Run it again when the Auth0 session expires.

## Stub the network instead of signing in

Large applications need many setup steps before the screen under test: sign-in, seeded records, feature flags. The QA agent skips them by serving the page against stubbed API responses that it writes itself.

- With `browser.enabled` the agent has `browser_route` and no further setup. It reads the issue and the diff, finds the API calls the changed screen makes, builds each response from the real type, schema, handler or an existing test fixture, registers it with `browser_route`, deep-links to the page, and judges what renders.
- The agent registers a catch-all that answers `599 unstubbed` first and its specific stubs after it, because Playwright tries the most recently registered matching route first. An unstubbed call then fails visibly instead of reaching a backend that needs a login.
- For the signed-in state, the agent stubs the endpoint the app calls to learn who the user is. For an app that reads a token from storage it sets that with `browser_evaluate` and reloads. An app that validates tokens against an identity provider also needs that provider's discovery and key endpoints stubbed.
- Stubs run in the browser. A server-rendered app fetches its data on the server, so browser stubs never see those calls; stub that app's backend instead.
- Routes live as long as the browser. After the idle timeout closes it, the next tool call starts a fresh browser without them, so the agent re-registers its stubs.
- A pass against stubs proves how the UI renders the data it is given. It does not prove the real endpoints return that shape. The verdict says "UI against stubs" and lists the stubbed URLs, and one unstubbed journey per feature is still needed for acceptance.

## Handoff and test data

The human can set state up first and hand over a URL. Setup must be saved in the backend; unsaved page state does not carry over. The agent reuses an existing campaign, creates data through the application API, or asks the human. The QA database is read-only to the agent and production is out of bounds.

## Limits

- Playwright MCP's `browser_run_code_unsafe` and `browser_evaluate` give the agent full page control. Scope the agent to non-production environments.
- Enabling the browser adds a run-scoped MCP server, so the engine starts a fresh provider process for these runs instead of reusing a warm one.
