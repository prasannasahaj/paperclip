# Spike notes: what Claude streams for long commands

Source: stored runs on the local instance, read through `GET /api/heartbeat-runs/:id/events` and `data/run-logs`.

## Findings

- Foreground Bash (native path, runs `1bf7462a`, `6e2006c6`): `tool.execution.started`, then 2-3 `tool.execution.progressed`, then `completed`. On `progressed`, `progress` is the command text and `output` is the 4-character string `"null"`. Output text arrives only on `completed`. **No incremental output exists for Claude foreground commands.**
- `completed` output is cut at about 4,000 characters with a `…[truncated]` marker while `outputTruncated` is false and `outputBytes` is 4110. The cut happens upstream of the 64 KB runner cap.
- Legacy path (run `c0d3b9f2`): a long Terminal call produces a `tool_call_update` with status `in_progress` about every 30 seconds and only the text `tool call (in_progress)`. No output.
- Background Bash (`run_in_background`): the start result says `running in background with ID: <id>. Output is being written to: /private/tmp/claude-501/<cwd-slug>/<session>/tasks/<id>.output`. The path is in the tool result text.

## Decision

- Task 2 branch A (ACP streams output): **not available** for foreground commands.
- Task 2 branch B: applies to foreground commands. Show elapsed time and "Waiting for output".
- Task 2 branch C: **available** for background commands, by tailing the named output file.
- Extra defect for Task 1: `output: "null"` must be treated as empty.
