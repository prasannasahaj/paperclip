# Context compression for claude-local agents

## Intent

Agent runs are dominated by cached-input re-reads, not output. Across the local instance's `cost_events` (all rows), input is ~25M tokens, cached input ~393M, and output ~2.7M, so output is ~0.6% of tokens. Compressing tool results and tool schemas before they reach the model, while keeping the exact originals recoverable, targets the dominant cost.

The compression engine is [Caveman](https://github.com/JuliusBrussee/caveman) (Apache-2.0 since 3.0.0): a local `caveman-proxy` that sits between the agent and the provider and rewrites large, low-value payloads, plus `caveman-mcp`, which lets the agent fetch exact originals back.

## Goals

- Reduce input and cached-input tokens per run for claude-local agents without changing agent behavior.
- On by default for local execution.
- Never block or fail a run because compression is unavailable.

## Non-goals

- The Caveman response-style skill (`/caveman`). It only affects output tokens, which are ~0.6% of volume.
- Caveman Cloud, Auto model routing, `caveman wrap`, or its Claude Code hooks. Paperclip manages its own `CLAUDE_CONFIG_DIR` and strips `settings.hooks`.
- Bundling or downloading Caveman binaries from Paperclip.
- Sandbox and remote execution targets (a loopback proxy is unreachable from them).
- The Claude CLI engine (`engine: "cli"`). Recovery needs a stdio MCP entry that the CLI path's generated strict MCP config does not yet carry; the ACP engine is the default and already supports stdio MCP servers. The CLI path logs that it runs direct.
- Other adapters (codex-local, etc.). Revisit after claude-local.

## Anti-goals

- Cross-company access to recovery data.
- Any outbound telemetry or prompt content leaving the machine beyond the model provider the agent already uses.
- A run that fails or hangs because the proxy is missing, unhealthy, or slow.

## Constraints

- AGENTS.md rule 1: company-scoped data. Recovery handles are content-addressed, not authorization tokens, so each company gets its own proxy and its own recovery store.
- `rules/sleep-aware-background-work.mdc`: no idle polling. Lifecycle is event-driven (lazy start on first run, stop on server shutdown, health inferred from connection errors).
- `rules/module-boundaries.mdc`: proxy lifecycle lives in its own module; claude-local only consumes a narrow contract.
- `rules/runtime-dependency-boundaries.mdc`: no new bundled dependency on the shared runtime path.
- Config env passes through `execute.ts` (`shapedEnvConfig` loop), so `ANTHROPIC_BASE_URL` can be injected without new plumbing, but runtime-assigned keys win over config.

## Approaches considered

1. **Proxy + recovery MCP, per-company supervised process (chosen).** Base-URL swap, no change to agent semantics, compresses everything the agent sends. Cost: a managed child process and an external binary.
2. **Run Caveman only as an MCP tool the agent opts into.** No proxy, but the agent must choose to call it, so most tool output is never compressed. Does not address the cost.
3. **Reimplement the compressors in Paperclip.** Full control, but a large surface (16 compressors, recovery store, safety gates) to own and keep correct.

User direction: integrate Caveman, on by default, no A/B spike.

## Design

- **Setting.** `contextCompression: "on" | "record" | "off"`, default `on`, in the claude-local config schema. `record` is pass-through with usage capture; `off` skips the proxy entirely.
- **Module.** `packages/adapter-utils/src/context-compression/` owns binary discovery, per-company proxy process lifecycle, port allocation, and the env/MCP fragments to inject. claude-local calls one function returning `{ env, mcpServers, warnings }` or `null`.
- **Binary discovery.** `CAVEMAN_PROXY_BIN` / `CAVEMAN_MCP_BIN`, then `PATH`, then `~/.caveman/bin`. Missing binaries mean no compression and one warning in the run log.
- **Per-company isolation.** One `caveman-proxy` per company on a loopback port, with `CAVEMAN_CCR_DB` and its local database under that company's Paperclip directory.
- **Lifecycle.** Started lazily by the first eligible run, reused by later runs, stopped on server shutdown. A connection failure marks it unhealthy for the next start attempt; no polling loop.
- **Injection.** For eligible runs, set `ANTHROPIC_BASE_URL` to the company proxy and add a `caveman-mcp` entry to the generated MCP config (the `--mcp-config` path in `execute.ts`). Set `DO_NOT_TRACK=1`.
- **Eligibility.** Local execution target only; setting not `off`; binaries found; proxy healthy. Anything else runs direct and logs why.
- **Fail open.** Any failure before the run starts falls back to the direct path. Failures mid-run are the proxy's own pass-through behavior (it forwards the original body on transform failure).
- **Measurement.** Existing `cost_events` token columns, no new tables.

## Unverified, to settle first in the plan

- claude-local defaults to the ACP engine (`engine: "auto"`). Confirm `ANTHROPIC_BASE_URL` reaches `claude-agent-acp` and that subscription (non-API-key) auth works through the proxy. If subscription auth does not work, `on` must apply only to API-key agents and say so.
- Whether the `caveman-proxy` CLI flags and `caveman.yaml` options support per-instance DB paths and a chosen port as the docs imply.

## Left to the builder

- Port allocation strategy, process spawning helper reuse, run-log wording, UI placement of the setting, and test layout.
