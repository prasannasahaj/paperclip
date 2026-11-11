# Playwright browser for QA agents

Status: implemented, not yet verified in a live QA run. Behaviour is documented in `doc/QA-BROWSER.md`.

Changes from the design below, found while implementing:

- Delivery is an ACP stdio MCP server added by the ACPX engine (`packages/adapter-utils/src/acpx-engine/playwright-browser.ts`), not a Paperclip-launched HTTP server. The Claude session owns the process, so there is no new resource to track or reap.
- Each run uses `--isolated` with a saved storage state file instead of copying a golden profile. Nothing is copied or cleaned up, and parallel runs cannot conflict.
- `@playwright/mcp` is a pinned dependency of `@paperclipai/adapter-utils` and runs under the server's Node, so there is no `npx` download at run time.

## Problem

The QA Verifier (`claude_local`, ACP engine) cannot verify work in a browser.
Evidence: runs `f5f80d24` and `c30bfce5` on TAC-101.

- Its `ToolSearch` for chrome/browser found no `mcp__claude-in-chrome__*` tools, although the adapter config has `chrome: true`.
- The fallback Chrome started by `skills/paperclip-qa-browser/scripts/open-session.mjs` stayed on `about:blank`, screenshots hung, and Playwright `connectOverCDP` timed out on Node 22 and 26.
- The agent ran none of the six journeys and blocked on the human.

`paperclip-qa-browser` in the agent's skill list is a text playbook only. It provides no browser.

## Goals

1. Every QA run gets a working, isolated browser with no manual MCP setup.
2. Logins persist: runs start from a pre-signed-in profile.
3. Low token cost per step.
4. The human can set up state and hand off, or watch a run headed.
5. Works for any adapter that already consumes runtime MCP servers.

## Non-goals

- Replacing Browser Use Cloud (hosted; cannot reach `localhost`).
- A regression test suite. QA stays exploratory.
- Sharing the human's live tab. Handoff is saved state plus a URL.
- Any write access to Mongo. UK non-prod Mongo is read-only; seeding goes through the app API or the human.

## Design

### Browser engine

Pinned `@playwright/mcp`, one instance per run, launched by Paperclip.

- Golden profile: one signed-in QA profile directory. The human uses it directly, headed, to sign in and to set up state.
- Per run: Paperclip copies the golden profile to a run-scoped `--user-data-dir`, because a persistent profile allows one browser at a time.
- Headless by default; headed when a run is flagged for the human to watch.
- Token controls (Playwright MCP config): `console.level: error`, `imageResponses: omit` unless a screenshot is requested, `timeouts.idle` set, `outputDir` per run with `outputMaxSize`.
- Evidence: screenshots and trace saved under the per-run output dir and attached to the issue.

### Delivery to the agent

Recommended: a Paperclip-launched, per-run runtime MCP server, added to `runtimeMcpServers` next to "Paperclip projects" in `server/src/services/heartbeat/runtime-execution.ts` (~line 842). Adapters already turn these into HTTP MCP config (`writePaperclipClaudeMcpConfig`, ACP `mcpServers`).

Rejected for now: an approved `local_stdio` connection template. The stdio runtime is a slot model with a 1s default idle TTL (`server/src/services/tool-runtime-supervisor.ts:9`), built for stateless calls. A browser keeps a current page between calls. Assumed: the process is recycled at idle; falsified if slots keep the process alive while a run is active. Verify before final rejection.

### Skill

Rewrite `skills/paperclip-qa-browser/SKILL.md`:

- Drop the Chrome-attach and `open-session.mjs` flow and the "ask the human to add the MCP" step.
- Start from a handoff: URL plus a note on what is already set up.
- Data tiers: reuse an existing campaign; seed through the app API; ask the human with an `ask_user_questions` interaction.
- Hard rule: never write to production; Mongo is read-only for QA.

### Agent config

QA Verifier: remove `chrome: true`, keep the skill, ensure it receives the runtime browser server.

## Open questions

1. Slot lifetime in the stdio supervisor (decides rejected option above).
2. Playwright MCP over HTTP: does it enforce the bearer token? If not, bind loopback on a random port and restrict `allowedHosts`.
3. Where the golden profile lives and who refreshes expired Auth0 sessions.
4. Whether an optional attach mode (`cdpEndpoint`) is worth keeping for unsaved-form handoff.

## Verification

- Unit: profile copy/cleanup, runtime server registration, token-saving config.
- Run a QA Verifier issue end to end against explore-ui on `localhost:3000` with a pre-signed-in profile: pass and fail verdict paths.
- `pnpm verify` for the changed server files.
