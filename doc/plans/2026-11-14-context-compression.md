# Context Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route local Claude (ACP engine) agent traffic through a per-company `caveman-proxy`, on by default, so large tool output and tool schemas are compressed with exact originals recoverable.

**Architecture:** A new `context-compression` module in `packages/adapter-utils` owns settings parsing, binary discovery, per-company proxy supervision, and an `attachContextCompression` seam that mirrors `attachPlaywrightBrowserServer`. The ACP engine calls that seam once, after env assembly. Every failure falls back to the direct path.

**Tech Stack:** TypeScript (ESM), Node `child_process`/`net`, Vitest. External runtime: `caveman-proxy` and `caveman-mcp` (Apache-2.0), discovered not bundled.

**Spec:** `doc/plans/2026-11-14-context-compression-design.md`

## Global Constraints

- Setting: `contextCompression: "on" | "record" | "off"`, default `"on"`.
- One `caveman-proxy` per company; `CAVEMAN_HOME=<instanceRoot>/companies/<companyId>/context-compression`, which holds `caveman.db`, `ccr.db`, `port.json`, and `proxy.log`.
- Proxy env: `CAVEMAN_HOME`, `CAVEMAN_LISTEN=127.0.0.1:<port>`, `CAVEMAN_MODE=compress` (setting `on`) or `record` (setting `record`), `CAVEMAN_RECOVERY=mcp` for `on`, `DO_NOT_TRACK=1`. Never sign in to or use Caveman Cloud.
- Agent env injected: `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, `DO_NOT_TRACK=1`. MCP server name: `Caveman recovery`; launch env: `CAVEMAN_HOME` (same company home).
- Binary lookup order: `CAVEMAN_PROXY_BIN` / `CAVEMAN_MCP_BIN`, then `PATH`, then `~/.caveman/bin`.
- Eligible only when: setting is not `off`, `acpxAgent === "claude"`, execution target is local, binaries found, `ANTHROPIC_BASE_URL` not already set by adapter config or host env, no Bedrock flags.
- Scope: ACP engine only. The Claude CLI engine stays direct and logs one line saying so.
- No idle polling (`rules/sleep-aware-background-work.mdc`). The only wait is a bounded startup connect handshake.
- No source comments (user rule); names carry the meaning.
- Injected env must not enter `resolvedAdapterEnv`, so session fingerprints do not change with the port.
- Port is persisted so warm ACP handles keep a valid `ANTHROPIC_BASE_URL` across runs.

## Review Focus

- Config says `contextCompression: "bogus"` or a non-string: parse falls back to `on` without throwing.
- Binaries missing: run proceeds direct, exactly one warning line, no throw.
- Port in `port.json` is held by a foreign process: allocate and persist a new port, never reuse the foreign one.
- Two runs for one company start concurrently: exactly one proxy process is spawned.
- Proxy child exits between runs: the next `ensureRunning` respawns on the same persisted port.
- Adapter env already pins `ANTHROPIC_BASE_URL` (OpenRouter, custom gateway): no injection, reason logged.
- Different companies never share a home, port, or recovery store.

---

### Task 1: Setting parser and schema field

**Files:**
- Create: `packages/adapter-utils/src/context-compression/config.ts`
- Create: `packages/adapter-utils/src/context-compression/config.test.ts`
- Modify: `packages/adapters/claude-local/src/server/config-schema.ts` (add field after `engine`)

**Interfaces:**
- Produces: `type ContextCompressionMode = "on" | "record" | "off"`; `readContextCompressionMode(config: Record<string, unknown>): ContextCompressionMode`.

- [ ] **Step 1: Write the failing tests** in `config.test.ts`: `defaults to on when unset`; `accepts on, record, off case-insensitively`; `falls back to on for unknown strings and non-strings` (inputs `"bogus"`, `42`, `null`, `{}`).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/adapter-utils/src/context-compression/config.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `readContextCompressionMode` and the exported `CONTEXT_COMPRESSION_MODES` tuple in `config.ts`.
- [ ] **Step 4: Add the schema field** to `getConfigSchema()`: key `contextCompression`, label `Context compression`, type `select`, default `on`, options On / Record only (measure, no changes) / Off, hint stating it routes local Claude (ACP) traffic through a per-company Caveman proxy and that missing binaries run direct. Add a test case in the existing claude-local schema test (or create `config-schema.test.ts` if none) asserting the field's default and option values.
- [ ] **Step 5: Run** both test files. Expected: PASS.
- [ ] **Step 6: Commit** `feat(context-compression): add contextCompression setting`.

### Task 2: Binary discovery

**Files:**
- Create: `packages/adapter-utils/src/context-compression/binaries.ts`
- Create: `packages/adapter-utils/src/context-compression/binaries.test.ts`

**Interfaces:**
- Produces: `interface CavemanBinaries { proxy: string; mcp: string }`; `resolveCavemanBinaries(input: { env: NodeJS.ProcessEnv; homeDir: string }): Promise<CavemanBinaries | null>`.

- [ ] **Step 1: Write failing tests** using temp dirs with executable stub files: `prefers CAVEMAN_PROXY_BIN and CAVEMAN_MCP_BIN overrides`; `finds both on PATH`; `falls back to ~/.caveman/bin`; `returns null when either binary is missing`; `ignores non-executable files`.
- [ ] **Step 2: Run** the test file. Expected: FAIL.
- [ ] **Step 3: Implement** `resolveCavemanBinaries` (check executability with `fs.access(X_OK)`; binary names `caveman-proxy`, `caveman-mcp`; add `.exe` on win32).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(context-compression): discover caveman binaries`.

### Task 3: Company home and persisted port

**Files:**
- Create: `packages/adapter-utils/src/context-compression/company-home.ts`
- Create: `packages/adapter-utils/src/context-compression/company-home.test.ts`

**Interfaces:**
- Produces: `resolveCompressionHome(instanceRoot: string, companyId: string): string`; `acquireCompressionPort(home: string, options?: { isPortFree?: (port: number) => Promise<boolean> }): Promise<number>`.

- [ ] **Step 1: Write failing tests**: `home is under companies/<companyId>/context-compression`; `two companies get different homes`; `rejects a companyId containing path separators`; `first call allocates a loopback port and persists port.json`; `second call returns the same port when it is free`; `allocates and persists a new port when the stored one is not free`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `isPortFree` default tries `net.createServer().listen(port, "127.0.0.1")`; allocation listens on port 0, reads the assigned port, closes, persists `{ "port": n }` with mode 0600 in a `0700` home.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(context-compression): per-company home and stable port`.

### Task 4: Proxy supervisor

**Files:**
- Create: `packages/adapter-utils/src/context-compression/supervisor.ts`
- Create: `packages/adapter-utils/src/context-compression/supervisor.test.ts`

**Interfaces:**
- Consumes: `CavemanBinaries` (Task 2), `resolveCompressionHome`, `acquireCompressionPort` (Task 3), `ContextCompressionMode` (Task 1).
- Produces:
  - `type ProxyAvailability = { available: true; baseUrl: string; home: string } | { available: false; reason: string }`
  - `interface CompressionSupervisor { ensureRunning(input: { companyId: string; instanceRoot: string; mode: Exclude<ContextCompressionMode, "off">; binaries: CavemanBinaries }): Promise<ProxyAvailability>; stopAll(): Promise<void> }`
  - `createCompressionSupervisor(deps?: { spawn?: typeof import("node:child_process").spawn; waitForListen?: (port: number, timeoutMs: number) => Promise<boolean> }): CompressionSupervisor`
  - `getCompressionSupervisor(): CompressionSupervisor` (process-wide singleton).

- [ ] **Step 1: Write failing tests** with a fake `spawn` and fake `waitForListen`: `spawns one proxy with the documented env for mode on` (assert `CAVEMAN_HOME`, `CAVEMAN_LISTEN`, `CAVEMAN_MODE=compress`, `CAVEMAN_RECOVERY=mcp`, `DO_NOT_TRACK=1`); `mode record sets CAVEMAN_MODE=record and no CAVEMAN_RECOVERY`; `concurrent ensureRunning calls spawn exactly once`; `reuses a live child on later calls`; `respawns on the same port after the child exited`; `returns unavailable with a reason when the listener never opens` (and kills the child); `different companies get separate children`; `stopAll terminates every child`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Track `{ child, port, exited }` per company; keep an in-flight promise map per company; mark `exited` from the child's `exit` event; stdout/stderr go to `<home>/proxy.log`; the default `waitForListen` is a bounded connect retry (max 5s) that runs only during startup; register one `process.once("exit")` that kills remaining children.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(context-compression): supervise per-company caveman proxy`.

### Task 5: Eligibility and attach seam

**Files:**
- Create: `packages/adapter-utils/src/context-compression/attach.ts`
- Create: `packages/adapter-utils/src/context-compression/attach.test.ts`
- Create: `packages/adapter-utils/src/context-compression/index.ts` (re-exports `attachContextCompression`, `getCompressionSupervisor`, `readContextCompressionMode`)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `type CompressionSkipReason = "disabled" | "not-claude" | "remote-target" | "binaries-missing" | "base-url-pinned" | "bedrock" | "proxy-unavailable"`
  - `attachContextCompression(input: { config: Record<string, unknown>; companyId: string; instanceRoot: string; acpxAgent: string; executionTargetIsRemote: boolean; env: Record<string, string>; hostEnv: NodeJS.ProcessEnv; mcpServers: Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }>; onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void; supervisor?: CompressionSupervisor; resolveBinaries?: typeof resolveCavemanBinaries }): Promise<{ attached: true; baseUrl: string } | { attached: false; reason: CompressionSkipReason }>`

- [ ] **Step 1: Write failing tests** (fake supervisor and binaries): `attaches env and MCP server when eligible` (asserts `env.ANTHROPIC_BASE_URL`, `env.DO_NOT_TRACK`, one `Caveman recovery` server with `CAVEMAN_HOME`, and one `[paperclip] Context compression: on` log line); `skips with reason disabled when mode is off` (no log noise); `skips for non-claude agents`; `skips for remote targets`; `skips when env.ANTHROPIC_BASE_URL is already set`; `skips when host ANTHROPIC_BASE_URL is set`; `skips on Bedrock flags in env`; `logs exactly one warning and skips when binaries are missing`; `logs one warning and skips when the proxy is unavailable`; `record mode attaches env but no MCP server`; `never throws when the supervisor rejects`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `attachContextCompression`. Wrap supervisor and binary calls in try/catch that converts any throw into `proxy-unavailable`. MCP server `command` is `binaries.mcp`, `args` empty.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(context-compression): attach compression to local claude runs`.

### Task 6: Wire into the ACP engine

**Files:**
- Modify: `packages/adapter-utils/src/acpx-engine/execute.ts` (immediately after the `attachPlaywrightBrowserServer({...})` call, near the env assembly around line 2150)
- Modify: `packages/adapter-utils/src/acpx-engine/execute.test.ts` (extend the existing harness; add a `describe("Context compression")` beside `describe("Playwright browser server")`)

**Interfaces:**
- Consumes: `attachContextCompression` (Task 5).

- [ ] **Step 1: Write failing tests** in the existing harness with a stubbed compression module: `passes ANTHROPIC_BASE_URL to the agent env when attached`; `adds the Caveman recovery server to ACP mcpServers`; `does not change the session fingerprint when only the port changes`; `runs direct and still succeeds when attach reports binaries-missing`; `does not attach for codex runs`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/adapter-utils/src/acpx-engine/execute.test.ts -t "Context compression"`. Expected: FAIL.
- [ ] **Step 3: Implement** the call: pass `config`, `companyId: agent.companyId`, `instanceRoot: defaultPaperclipInstanceDir()`, `acpxAgent`, `executionTargetIsRemote`, `env`, `hostEnv: process.env`, `mcpServers`, `onLog`. Do not copy injected keys into `resolvedAdapterEnv`. Place the call before the `MCP_TOOL_TIMEOUT` block so it applies to the new server too.
- [ ] **Step 4: Run** the full `execute.test.ts`. Expected: PASS with no regressions.
- [ ] **Step 5: Commit** `feat(acpx-engine): route local claude runs through context compression`.

### Task 7: CLI-engine notice and shutdown hook

**Files:**
- Modify: `packages/adapters/claude-local/src/server/execute.ts` (CLI path, after `runtimeConfig` is built)
- Modify: `packages/adapters/claude-local/src/server/execute.acp-fallback.test.ts` or the nearest CLI-path test file
- Modify: `server/src/index.ts` (ordered shutdown path, near `shutdown` ~line 1298) and `server/src/shutdown.ts` if the step list lives there

**Interfaces:**
- Consumes: `readContextCompressionMode`, `getCompressionSupervisor` from `@paperclipai/adapter-utils/context-compression`.

- [ ] **Step 1: Write failing tests**: CLI engine with mode `on` logs `[paperclip] Context compression applies to the ACP engine only; this run goes direct.` exactly once and does not set `ANTHROPIC_BASE_URL`; with mode `off` logs nothing. Server: the shutdown sequence calls `getCompressionSupervisor().stopAll()` (extend the existing shutdown test).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** both changes.
- [ ] **Step 4: Run** the touched test files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(claude-local): note CLI engine is direct and stop proxies on shutdown`.

### Task 8: Docs and package exports

**Files:**
- Create: `doc/CONTEXT-COMPRESSION.md`
- Modify: `packages/adapter-utils/package.json` only if the `exports` glob does not already expose `./context-compression` (it exports `./*` as `./src/*.ts`; use `context-compression/index` if the directory import does not resolve)

- [ ] **Step 1: Write the doc**: what it does, default on, settings, binary install and lookup order, per-company isolation, fail-open behavior, ACP-only scope, privacy (`DO_NOT_TRACK`, no Cloud), how to read tokens in `cost_events`, known limits (remote targets, CLI engine, mid-run proxy crash).
- [ ] **Step 2: Verify the import path** `@paperclipai/adapter-utils/context-compression/index` resolves from `packages/adapters/claude-local` and `server` via `pnpm --filter @paperclipai/adapter-utils typecheck` and a `tsc --noEmit` on the consumers.
- [ ] **Step 3: Commit** `docs(context-compression): document the proxy integration`.

### Task 9: Verification and real-binary check

- [ ] **Step 1: Run** `pnpm verify`. Expected exit 0; if exit 2, run the focused suites for `packages/adapter-utils` and `packages/adapters/claude-local` and report what was not run.
- [ ] **Step 2: Typecheck** the touched packages: `pnpm --filter @paperclipai/adapter-utils typecheck` and the same for `@paperclipai/adapter-claude-local` and `server`.
- [ ] **Step 3: Install the real binaries** (`npx @caveman-ai/cli@latest`, or release artifacts into `~/.caveman/bin`). Start a local agent run on the ACP engine and confirm: the run log shows `Context compression: on`; `<company home>/proxy.log` shows traffic; a second run reuses the same port; with subscription auth the run still completes. **If subscription auth fails through the proxy, stop and report** (spec's first unverified item): restrict `on` to API-key agents in `attachContextCompression` and add a `subscription-auth` skip reason.
- [ ] **Step 4: Compare token usage** for the same agent before/after in `cost_events` (informational; the user chose not to gate on an A/B).
- [ ] **Step 5: Open the PR** with every section of `.github/PULL_REQUEST_TEMPLATE.md` filled, including Model Used and the unrun items from Step 1.
