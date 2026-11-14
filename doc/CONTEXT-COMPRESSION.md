# Context compression

Local Claude agents on the ACP engine can route their model traffic through a
per-company [Caveman](https://github.com/JuliusBrussee/caveman) proxy. The proxy
shrinks large, low-value payloads (tool results, tool schemas) before they reach
the model. A second binary, `caveman-mcp`, is registered as an MCP server so the
agent can fetch the exact originals back.

The setting is **on by default**, but it only takes effect when the Caveman
binaries are installed. Without them, runs go direct and nothing else changes.
Paperclip does not bundle or download the binaries.

Default `on` was a product decision made before any measurement. It is not
measured; see "Observed in one local run" for the one real check so far.

The design and rationale are in
`doc/plans/2026-11-14-context-compression-design.md`. This page describes what
the code does.

## Setting

`contextCompression` lives in the agent's adapter config (claude-local), shown as
"Context compression" in the agent configuration form.

| Value | Behavior |
| --- | --- |
| `on` (default) | Starts the company proxy in compress mode and registers the `caveman` recovery MCP server. |
| `record` | Starts the proxy in record mode: pass-through with usage capture. No recovery MCP server is added. |
| `off` | No proxy, no log line. |

A missing, non-string, or unrecognised value is treated as `on`. Values are
trimmed and lower-cased before matching.

### Effective mode

A company has one proxy, and a running proxy keeps the mode it started with.
If agent A starts the proxy in `on` and agent B (same company) asks for
`record`, B's run uses the already-running `on` proxy. The mode logged on each
run is the proxy's mode, not the agent's requested mode. The recovery MCP server
is added only when the proxy's effective mode is `on`.

The mode changes only after the proxy restarts (server restart, or the proxy
exited and the next run starts a new one).

## Install the Caveman binaries

Two binaries are required: `caveman-proxy` and `caveman-mcp`. If either is
missing, compression is skipped.

Lookup order, per binary:

1. The override env var on the Paperclip server process: `CAVEMAN_PROXY_BIN`
   or `CAVEMAN_MCP_BIN`, used only if it points at an executable file.
2. Each directory on the server's `PATH`, in order.
3. `~/.caveman/bin`.

On Windows the `.exe` suffix is added to the searched names.

To install, follow the upstream README at
https://github.com/JuliusBrussee/caveman. At the time of writing, the upstream
README installs with `npx @caveman-ai/cli@latest`, and the CLI downloads
signed, checksum-verified binaries into `~/.caveman/bin` (its own missing-proxy
message names `caveman setup --install` for the binaries). These steps were
read from the upstream source, not run here. Check the upstream docs for the
current command before relying on it.

Only `caveman-proxy` and `caveman-mcp` are needed. The real-binary check
installed just those two: it downloaded them from the upstream release
`bin-v4.1.0`, verified their SHA-256 against the release `checksums.txt` (the
checksum signature was not verified), and copied them to `~/.caveman/bin`. The
full upstream installer (`npx @caveman-ai/cli`) also installs agent hooks and
skills into the user's own Claude Code setup and turns on usage telemetry
(Verified by reading upstream's CLI source and docs, not by running it), so it
is not required for this integration.

The Paperclip server finds the binaries in its own environment, so set the
override vars or `PATH` for the server process, not only your shell.

## Scope

Compression applies when all of these hold:

- the agent is a local Claude agent (`claude-local`) running on the ACP engine
  (the default);
- the run does not use a remote execution target (a loopback proxy is
  unreachable from there);
- the setting is not `off`.

It does not apply to:

- **Codex and other adapters.** Not wired.
- **Remote execution targets.** Skipped silently (`remote-target`).
- **The CLI engine** (`engine: "cli"`). The run goes direct. Unless the setting
  is `off`, the run log shows one line on stdout:
  `[paperclip] Context compression applies to the ACP engine only; this run goes direct.`

## Per-company isolation

Each company gets its own proxy process, loopback port, and data. Recovery
handles are not authorization tokens, so nothing is shared across companies.

```text
<instanceRoot>/companies/<companyId>/context-compression/
  port.json     persisted loopback port, mode 0600
  proxy.log     the proxy's own log (it writes and rotates this file itself)
  proxy.stderr.log  the proxy's stderr only (startup panics), appended, mode 0600
  caveman.db    proxy spend/usage records (written by caveman-proxy)
  ccr.db        recovery store for originals (written by caveman-proxy)
  caveman.db-wal, caveman.db-shm, ccr.db-wal, ccr.db-shm
                SQLite sidecars (written by caveman-proxy)
  cache-warm-gaps.json
                written by caveman-proxy at shutdown, not while running
  run/<port>.json
                written by caveman-proxy; holds an instance token and a
                shutdown token; removed on stop
  runtime/session.key
                written by caveman-proxy
  run/native.sock
                only when the home path is short enough (see "Observed in one
                local run")
```

Observed in one local run (macOS arm64, `bin-v4.1.0`), not a general guarantee:
every file the proxy writes is mode `0600` in `0700` directories, and all of
them are inside the company directory.

- `<instanceRoot>` is `$PAPERCLIP_HOME/instances/<instance-id>`, by default
  `~/.paperclip/instances/default`.
- The directory is `0700`. A `companyId` that is not a plain identifier
  (`[A-Za-z0-9][A-Za-z0-9._-]*`) is rejected.
- The proxy binds `127.0.0.1` only. `port.json` holds the last port; it is
  reused if still free, otherwise a new free port is chosen and saved.
- The proxy runs with `CAVEMAN_HOME` set to that directory. `caveman.db` and
  `ccr.db` are the proxy's defaults inside `CAVEMAN_HOME` (upstream
  `proxy/cmd/caveman-proxy/main.go`); Paperclip does not create them.
- The proxy is started lazily by the first eligible run, reused by later runs,
  and stopped when the Paperclip server shuts down. There is no health polling.
  Before each run reuses a live proxy, Paperclip makes one loopback connect to
  its port with a 500 ms timeout. If the connect fails, that proxy is killed and
  a fresh one is started (concurrent runs share the one restart). A proxy that
  has exited is replaced on the next eligible run. The probe only proves the port
  accepts connections; a proxy that accepts but never answers is not detected.

### Proxy environment

The proxy child does not inherit the server environment. It receives only:

- an allowlist copied from the server: `PATH`, `HOME`, `USERPROFILE`,
  `SystemRoot`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_ALL`, `HTTP_PROXY`,
  `HTTPS_PROXY`, `NO_PROXY` (and lower-case forms), `SSL_CERT_FILE`,
  `SSL_CERT_DIR`;
- `CAVEMAN_HOME`, `CAVEMAN_LISTEN` (`127.0.0.1:<port>`), `CAVEMAN_MODE`
  (`compress` for `on`, `record` for `record`), `DO_NOT_TRACK=1`;
- `CAVEMAN_CCR_DB=<home>/ccr.db`, so the proxy and the recovery MCP server read
  and write the same store whatever the server environment says;
- `CAVEMAN_CACHE_WARM=off`: the proxy otherwise replays requests with
  `max_tokens: 0` to keep the prompt cache warm, for up to 60 minutes after the
  last request, in every mode. Those calls use the agent's credentials outside
  any run, never reach `cost_events`, continue after a budget hard-stop, and
  spend plan quota on subscription logins (upstream `proxy/cmd/caveman-proxy/main.go`
  and `cache_warm.go`). Paperclip turns it off;
- `CAVEMAN_OFFLINE=1`: upstream's Cloud link ignores routing, event upload and
  Cloud-side warming when this is set (`proxy/internal/cloudlink/link.go`,
  `events.go`, `warm.go`). Without it, a missing `<home>/cloud.json` makes the
  proxy fall back to `$HOME/.caveman-cloud/config.json`, so a server user who
  once signed in with an older Caveman CLI and enabled routing would route every
  company proxy through Cloud;
- `CAVEMAN_RECOVERY=mcp`, in `on` mode only.

Paperclip secrets, adapter env, and provider API keys are not passed to the
proxy.

## What a run gets

When attached, the run's environment gets `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`
and `DO_NOT_TRACK=1`. In `on` mode the MCP server list also gets an entry named
`caveman` (the `caveman-mcp` binary), unless one with that name already exists.
The binary is launched with `CAVEMAN_HOME` set to the company directory,
`CAVEMAN_CCR_DB=<home>/ccr.db` (upstream gives it precedence over
`CAVEMAN_HOME`), and `CAVEMAN_MCP_EPHEMERAL=0` (upstream only treats `1` as
"in-memory store", so this keeps an inherited `1` from pointing recovery at an
empty store).

The server name is load-bearing. Claude Code exposes the tool as
`mcp__<server>__caveman_retrieve`, and the proxy skips compressing a tool result
only for a closed allowlist of names, among them `mcp__caveman__caveman_retrieve`
(upstream `proxy/providers/adapter.go`). Any other server name would make the
recovered original get compressed again.

The `claude-agent-acp` process is relaunched on every host-lane run today, with
or without compression. The ACP session resumes through its session id, but the
process does not carry over: the host-lane reuse candidate always carries the
run-minted API key as a live run-scoped credential, and `decideReuse` discards
any candidate with one (`execute.ts:5794`, `settlement-sequence.ts:119-121`),
and the only `set` into the process cache is for staged runtimes
(`execute.ts:3808`). Compression does not change this. The warm-handle rules in
`execute.ts` (the recovery server does not force a discard, a changed
`ANTHROPIC_BASE_URL` does) apply only if host-lane reuse is enabled later.
Verified by reading those lines; not exercised at runtime.

Flipping a run between proxy and direct (a fallback, switching the setting, a
CLI-engine run, or the recovery tool appearing or disappearing) changes the
request bytes once, so that run re-caches its context. Reasoned from upstream's
byte-stability design, not measured.

### Skip reasons and log lines

Every skip falls back to a direct run. `attachContextCompression` never throws;
an unexpected error is logged and treated as `proxy-unavailable`.

| Reason | Meaning | Log |
| --- | --- | --- |
| `disabled` | Setting is `off`. | none |
| `not-claude` | The ACP agent is not Claude. | none |
| `remote-target` | The run uses a remote execution target. | none |
| `base-url-pinned` | `ANTHROPIC_BASE_URL` is already set in the run env or the server env, so Claude keeps that endpoint. | stdout |
| `bedrock` | `CLAUDE_CODE_USE_BEDROCK` is `1`/`true`, or `ANTHROPIC_BEDROCK_BASE_URL` is set, in the run env or the server env. | stdout |
| `vertex` | `CLAUDE_CODE_USE_VERTEX` is `1`/`true`, or `ANTHROPIC_VERTEX_BASE_URL` is set, in the run env or the server env. The base URL is likely ignored in Vertex mode, so the proxy is not started. | stdout |
| `binaries-missing` | `caveman-proxy` or `caveman-mcp` not found (see lookup order). | stderr |
| `proxy-unavailable` | The proxy could not be started (spawn failed, exited early, not listening within 5s after 2 attempts, shutting down) or attach hit an unexpected error. | stderr |

Log lines, all prefixed `[paperclip] Context compression`:

- success, stdout: `[paperclip] Context compression: on` (or `record`);
- skipped, stdout: `... skipped: ANTHROPIC_BASE_URL is already set, so Claude keeps using that endpoint.` or `... skipped: Claude is configured for Bedrock.` or `... skipped: Claude is configured for Vertex AI.`;
- unavailable, stderr: `... unavailable: caveman-proxy and caveman-mcp were not found on PATH or in ~/.caveman/bin; continuing without it.` or `... unavailable: <reason>; continuing without it.`

Proxy output does not go to the run log. The proxy writes its own `proxy.log` in
the company directory; Paperclip discards its stdout and keeps only stderr, in
`proxy.stderr.log`.

## Fail-open behavior

Handled before the run starts:

- Binaries missing, proxy fails to start, port or home setup fails, or any
  unexpected error: the run proceeds direct with the warning above.
- A failed log write never fails attach.
- A proxy that exited since the last run, or that no longer accepts loopback
  connections, is detected and restarted; the first eligible run after that pays
  the startup cost (up to two attempts).

Not handled:

- **Mid-run proxy crash.** The run's `ANTHROPIC_BASE_URL` points at the proxy
  for the whole run. If the proxy exits while a run is in flight, that run has
  no fallback to a direct endpoint, and its model calls fail the way any
  unreachable endpoint fails. Only later runs recover (they restart the proxy).
- **Upstream behavior on bad payloads.** When the proxy is up but cannot
  transform a request, upstream documents that it forwards the original bytes
  unchanged. That is Caveman's behavior, not something Paperclip enforces.
- **`ANTHROPIC_BASE_URL` reaching `claude-agent-acp`.** Not tested through a
  full Paperclip agent run. The real-binary check set it only for the `claude`
  CLI.
- **Hard kills.** The proxy is stopped on graceful shutdown and on process
  `exit`. A `SIGKILL` of the server skips both, so the proxy can be left
  running. The next start does not reuse a port that is still held and picks a
  new free one. Not tested: this follows from the code, and an orphaned proxy
  was not observed.

## Privacy

- The proxy is started with `DO_NOT_TRACK=1`, and so is every attached run.
  Upstream treats a non-empty, non-zero `DO_NOT_TRACK` as telemetry off, but
  that stops telemetry events only. It does not stop Cloud routing or warming.
- The proxy is also started with `CAVEMAN_OFFLINE=1`, which is what upstream
  checks to disable Cloud routing, event upload and Cloud warming. Paperclip
  never writes `<home>/cloud.json`; this setting is the enforcement, not the
  absence of a config file.
- The proxy listens on loopback only and sees the same provider traffic the
  agent would send directly.
- The loopback listener has no inbound authentication (`inbound_auth=none` in
  its startup log line), so any process on the machine can send requests to it.
  It forwards the caller's own auth headers and does not substitute credentials,
  because Paperclip's env allowlist does not pass `ANTHROPIC_API_KEY`: upstream
  falls back to its own key only when the request has no usable auth and that
  variable is set. Read from upstream source, not exhaustively: `pool.go` and
  the cloud link were not read in full.
- Unconfirmed: the proxy binary can read a macOS keychain item named `caveman`
  through the `security` command (upstream `cloudlink`, `link.go`). It was not
  observed to run, and whether `CAVEMAN_OFFLINE=1` stops it is not confirmed.
- Caveman Cloud and Auto routing send prompts off the machine. Paperclip does
  not configure or use them, and `CAVEMAN_OFFLINE=1` keeps the proxy from
  picking up a Cloud config from the server user's home directory.
- Caveman's own `caveman wrap` and Claude Code hooks are out of scope;
  Paperclip manages its own Claude config.

## Observed in one local run

One check with the real binaries (macOS arm64, `caveman-proxy` and `caveman-mcp`
from upstream release `bin-v4.1.0`, Claude CLI 2.1.325, haiku). Each item is
what happened in that run, not a general guarantee.

- **Subscription (non-API-key) login worked through the proxy.** The existing
  Claude Code login answered through `ANTHROPIC_BASE_URL`; the request returned
  status 200 and the proxy recorded it as subscription auth. This was driven
  through the `claude` CLI, not a full Paperclip agent run, so `claude-agent-acp`
  picking up `ANTHROPIC_BASE_URL` is still untested.
- **Log warning on a long home path.** `proxy.log` shows
  `native runtime unavailable ... Unix socket path too long` when the company
  home path exceeds 87 characters; the real home is about 112. It affects only
  the agent-hook channel, which Paperclip does not use. Compression was
  identical with a short home in the check. To silence it (optional), use a
  shorter instance root.
- **Effect on one task.** With one tool-output task (counting lines in a large
  file), the proxy compressed the tool-output request by about 25% and the
  recovery tool returned the original. That run took more turns and used more
  tokens than the direct control, and failed at a 4-turn cap that the control
  passed. One task is not a measurement of the average.
- **Cache hits.** Four identical call pairs per path were too weak to conclude
  anything, and leaned against the proxy.

### Known behaviour to watch

If a company sees more turns or a lower cached-input share after enabling, set
`contextCompression` to `off` for that agent.

## Reading the token effect

This page does not claim a specific saving. Measure it by comparing before and
after for the same kind of work.

Token use is in `cost_events` (`packages/db/src/schema/cost_events.ts`):
`input_tokens`, `cached_input_tokens`, `output_tokens` (Drizzle fields
`inputTokens`, `cachedInputTokens`, `outputTokens`), with `agent_id`,
`heartbeat_run_id`, `provider`, `model`, `occurred_at` for grouping.

Suggested comparison:

1. Pick an agent and a comparable workload. Run it with `contextCompression: off`
   and note the per-run averages of the three token columns.
2. Switch to `on`, run comparable work, and compare. Confirm the run log shows
   `Context compression: on`; a run that logged a skip went direct.
3. `record` mode gives the proxy's own usage capture (`caveman.db`) without
   changing requests, as a control.

On the local instance measured for the design doc, most volume was cached
input and output was under 1%, which is why the integration targets input
rather than the response style. Your mix may differ. Cache
behavior, prompt differences, and task variance all move these numbers, so one
before/after pair is weak evidence.

## Known limits

- Local ACP Claude agents only. Remote and sandbox targets, the CLI engine, and
  other adapters run direct.
- One proxy mode per company at a time (see Effective mode).
- A proxy crash during a run is not recovered for that run.
- Binary install and upgrade are manual. Paperclip does not check the Caveman
  version.
- A pinned `ANTHROPIC_BASE_URL` or Bedrock configuration disables compression
  for that run.
