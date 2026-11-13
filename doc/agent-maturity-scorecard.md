# Task maturity scorecard

The task page shows a "Maturity" row under the usage row. It summarises how
the agent verified its own work on that task: which compile, lint, typecheck,
test, mutation and build commands ran, how often they passed first time, how
long they took, how much rework the task needed and which models paid for it.
It lists concrete findings, not a maturity level.

The scorecard is computed on every read from `heartbeat_run_events`,
`heartbeat_runs` and `cost_events`. There is no table and no background job.
The route is `GET /issues/:id/maturity-scorecard`, with the same company
access check as other issue reads. The UI always asks for the issue and its
descendants; `?excludeRoot=true` (or `1`) drops the issue itself and keeps only
the descendants. The row refetches every 8 seconds while the task has an
active run and once more when the run ends. It is hidden when the task has no
runs or nothing to show, and shows an inline error with a retry action when
the request fails.

## What counts as a check

A shell command is a tool execution recognised in one of two shapes:

- Claude (ACP) shell tool: the event payload has `name` equal to `Bash`. The
  command text is the last non-empty `subject` on any tool event for the
  execution.
- Codex command execution: the payload has `transport` equal to `process` and
  `operation` equal to `execute`. The command text is the payload `name`.

OpenCode's shell tool (`bash`) is not supported: its events carry no command
text, so it is not recognised. Agents on the legacy runner write no tool
execution events at all.

Fields are read from `payload.prpEvent.payload`, or from the payload root when
that is absent. Events are joined by `executionId` within a run. Exit code,
duration and output come from the `tool.execution.completed` event; output on
progressed events is ignored. Only the last 4 000 characters of the completed
output are read (`OUTPUT_TAIL_CHARS`), and only shell tool events are read at
all, so other tools' events do not count towards the event limit.

A command is counted only when it has a completed event and a command text and
classifies as a check kind. Commands that started but never completed (for
example a cancelled run) are excluded from every number.

Classification reads the program, not substrings. The command is split into
segments on `&&`, `||`, `;`, `|` and newlines. In each segment, leading
environment assignments (`FOO=bar`) and the prefixes `env`, `time` and
`timeout <duration>` are skipped, and the next token is the program, compared
by its basename (`./gradlew` is `gradlew`). A segment such as `cd build`
produces nothing. Check names are then matched only in that program's own
arguments, ignoring flags and anything after `--`:

| Program | Kinds from |
| --- | --- |
| `pytest`, `tox`, `vitest`, `jest` | always test |
| `tsc`, `mypy`, `pyright` | always typecheck |
| `eslint`, `ruff`, `flake8` | always lint |
| `stryker`, `mutmut` | always mutation |
| `javac` | always compile |
| `gradlew`, `gradle` | tasks, optionally project-qualified (`:svc:test`): `pitest*` mutation; `test`, `integrationTest` test; `build`, `check` build; `checkstyle*`, `pmd*`, `spotbugs*`, `ktlint*`, `detekt*`, `lint*` lint; `compile*` compile |
| `mvn`, `mvnw` | goals: any containing `pitest` mutation; `test`, `integration-test` test; `verify`, `package`, `install` build; `checkstyle:`, `pmd:`, `spotbugs:`, `spotless:` goals lint; `compile`, `test-compile` compile |
| `pnpm`, `npm`, `yarn`, `bun`, `make` | script or target names, alone or with a `:`, `-` or `_` suffix (`test:unit`): `stryker` mutation; `test`, `vitest`, `jest` test; `build`, `check` build; `typecheck`, `tsc` typecheck; `lint`, `eslint` lint |
| `npx`, `pnpx`, `bunx`, `uv run`, `poetry run`, `python -m` | the program they launch, classified as above |

Any other program, such as `ls`, `cat`, `rg`, `git`, `docker` or `rm`, is not
a check, whatever its arguments say: `ls src/test`, `rm -rf build` and
`git commit -m 'fix test'` are not checks. When a command or its segments
match several kinds, the strongest wins in the order mutation, test, build,
typecheck, lint, compile. `check` counts as build.

The row lists kinds in the order compile, lint, typecheck, test, mutation,
build, and omits kinds with no commands.

## The numbers

| Number | Definition |
| --- | --- |
| commands | Counted commands of that kind, including those with no reported exit code. |
| failures | Commands of that kind with a non-null, non-zero exit code. |
| first-pass rate | For each run that has a command of that kind with a known exit code, take the earliest one. The rate is the share of those runs where it exited 0. Null when no run qualifies. |
| median, slowest | Over commands with a reported duration. Even counts average the two middle values. Null when none report a duration. |
| agentWaitShare | Sum of the reported durations of all counted commands, divided by the summed runtime (`finishedAt - startedAt`) of runs with a positive runtime. Only commands from those runs count. Capped at 1 (100%), because checks that run in parallel can add up to more than the runtime. Null when there are no runs with a positive runtime, or when no command from those runs reported a duration. |
| reworkRuns | Runs that are a retry (`retryOfRunId` set), a scheduled retry (`scheduledRetryAttempt > 0`) or a continuation (`continuationAttempt > 0`). |
| recheckAfterFailure | For each run and kind, the number of commands that started after that run's first failing command of the kind. |
| environmentBlockedCount | Failing commands whose completed output tail shows a credential or network block: `AccessDenied`; `Access Denied` on a line with `Status Code: 403` or `Service: Amazon S3`; `403 Forbidden`; `status code 403` (with or without a colon); `Could not resolve all files` or `Could not resolve all dependencies`; `Unable to locate credentials`; `ExpiredToken`. An assertion such as `expected status 403`, a line number such as `Foo.java:403`, or a bundler's `Could not resolve "./x"` does not count. |
| model mix | Per model, the same cost and input tokens the usage row shows: billed cost plus the API-equivalent cost of subscription usage, and input tokens excluding cache reads. Output tokens are summed from `cost_events` for the issue tree. |
| runCount | Runs that started (`startedAt` set) and whose `issueId` is in the issue tree. Queued runs and scheduled retries that never started are left out of `runCount` and `reworkRuns`. |
| truncated | True when either read limit was hit (see Known limits). The row then shows "partial: event limit reached". |

A command with no reported exit code is never a pass or a failure. A command
with no reported duration is left out of timing.

## Findings

| Code | Raised when |
| --- | --- |
| no_shell_events | The task has runs but no completed shell command was recorded, for example because the agent's adapter does not report shell commands. Check timing cannot be measured, so `no_checks_ran` is not raised. The per-kind lines are then not shown. |
| no_checks_ran | Shell commands were recorded for the task but none of them was a check. The per-kind lines are then not shown. |
| slow_check | Any counted command has a duration above 60 000 ms. |
| environment_blocked | `environmentBlockedCount` is above zero. |
| low_first_pass | A kind has a first-pass sample of at least 3 runs and a first-pass rate below 0.5. One finding per kind. |

The 60 000 ms budget is `FAST_CHECK_BUDGET_MS` in
`packages/shared/src/types/maturity.ts`. It comes from the E4 bar, "checks in
seconds to a minute", in Karun Japhet's
[AI Maturity Is a Lagging Indicator of Engineering Maturity](https://karun.me/blog/2026/11/08/ai-maturity-is-a-lagging-indicator-of-engineering-maturity/)
and [Optimising Feedback Time for Agent Teams](https://karun.me/blog/2026/11/09/optimising-feedback-time-for-agent-teams/).
It is a heuristic taken from those posts, not a threshold measured for this
repository family. The 0.5 rate and the 3-run minimum are likewise judgment
calls. It is a constant, not a setting.

## Known limits

- Flags are not interpreted, and their values are read as arguments.
  `gradlew build -x test` classifies as test because test outranks build.
- Quoting is not parsed. A check inside `bash -c "..."` or a script file is not
  seen, and a `|` or `;` inside quotes splits the command.
- Exit codes depend on the adapter reporting them. A missing exit code
  excludes the command from pass rates and failure counts.
- Only the first 20 000 tool events (`MAX_EVENTS`) and the first 2 000 runs
  (`MAX_RUNS`) for the issue tree are read, oldest first. On very large tasks
  the most recent activity is the part that is missing, and `truncated` is set.
- Runs are matched by `heartbeat_runs.issueId`, so `runCount` can differ from
  the run count in the cost summary.
- The row is hidden when the task has no runs, so a task that was never run
  shows nothing rather than a finding.
- Environment-blocked detection is a text match on the last 4 000 characters of
  a failing command's output. A block whose message is not in that tail, or
  does not use one of the listed phrases, is missed.
- Claude shell commands rely on the `subject` field. If an adapter omits it,
  the execution is still an observed shell command, so `no_shell_events` is not
  raised, but it is not classified and is not counted as a check.

## Acting on a finding

| Finding | Typical fix |
| --- | --- |
| no_shell_events | Run the agent on an adapter that reports shell commands (Claude through `paperclip_runner`, or Codex) if check timing matters for the task. |
| no_checks_ran | Make the check part of the agent's required verification, for example a Stop hook or a pre-commit gate that runs it, so finishing without it is not possible. |
| slow_check | Scope the check to the change, run cheap checks before expensive ones, run independent checks in parallel, and warm new workspaces (dependency and build caches) before the agent starts. |
| environment_blocked | Give the agent the credentials and environment the check needs through per-agent environment configuration. For Gradle repositories that resolve from a private artifact repository, that means the AWS profile and region variables. The `paperclip_runner` adapter reserves `PATH`, `HOME`, `SHELL`, `BASH_ENV` and `ZDOTDIR` (among others), so those cannot be set per agent. See `packages/paperclip-runner/src/configured-environment.ts`. |
| low_first_pass | Move the failing rule into a commit-time check so the failure is caught before the agent reports done, and write conventions as code (lint or test rules) rather than prose in instructions. |

## Where the code lives

- Types and budget: `packages/shared/src/types/maturity.ts`
- Command classification: `server/src/services/maturity/classify-command.ts`
- Event and run loading: `server/src/services/maturity/load-scorecard-inputs.ts`
- Aggregation and findings: `server/src/services/maturity/build-scorecard.ts`
- Route: `server/src/routes/maturity.ts`
- Row formatting and component: `ui/src/lib/maturity-scorecard-lines.ts`,
  `ui/src/components/issue-properties/maturity-row.tsx`
