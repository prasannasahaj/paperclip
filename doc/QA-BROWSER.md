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
| `cdpEndpoint` | none | Attach to a browser you already run instead of starting an in-memory one. See [Attach to a long-lived QA Chrome](#attach-to-a-long-lived-qa-chrome). |
| `allowedOrigins` | none | Origins the browser may request. Not a security boundary: redirects are not covered. |

Remove the legacy `chrome: true` setting from the agent; the QA Verifier's ACP runs exposed no Chrome tools with it (run `f5f80d24`).

## Save the QA login once

```sh
node skills/paperclip-qa-browser/scripts/save-login.mjs http://localhost:3000
```

Sign in in the window that opens, then press Enter in the terminal. The file is written with mode `0600`. It holds session cookies and local storage for the QA account, so keep only QA logins in it. Run it again when the Auth0 session expires.

## Attach to a long-lived QA Chrome

Use this when you need to sign in during a run, or when the in-memory browser's saved login keeps expiring. Start one Chrome with its own profile and let the agent attach to it:

```sh
open -na "Google Chrome" --args --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1 --user-data-dir=$HOME/.paperclip/qa-chrome
```

```json
{ "browser": { "enabled": true, "cdpEndpoint": "http://127.0.0.1:9333" } }
```

- Sign in once in that window. The profile persists, so you repeat it only when the Auth0 session expires.
- With `cdpEndpoint` set, the run no longer uses `--isolated`, `--headless` or `storageStatePath`. `headed` has no effect: the browser is whatever you started.
- Parallel runs share this one browser and its tabs.
- Use `127.0.0.1` rather than `localhost` in the endpoint, and pick a port nothing else holds. On a host where your everyday Chrome already listens on `127.0.0.1:9222`, a QA Chrome on 9222 binds only IPv6 and `localhost` can resolve to the wrong browser.
- Keep the debugging port bound to localhost and keep only QA logins in the profile. Anything that can reach the port controls the browser.
- If nothing is listening on the endpoint, the browser tools fail at the first call.

## Handoff and test data

The human can set state up first and hand over a URL. Setup must be saved in the backend; unsaved page state does not carry over. The agent reuses an existing campaign, creates data through the application API, or asks the human. The QA database is read-only to the agent and production is out of bounds.

## Limits

- Playwright MCP's `browser_run_code_unsafe` and `browser_evaluate` give the agent full page control. Scope the agent to non-production environments.
- Enabling the browser adds a run-scoped MCP server, so the engine starts a fresh provider process for these runs instead of reusing a warm one.
