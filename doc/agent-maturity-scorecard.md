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

A shell command is a tool execution whose event payload has `name` equal to
`Bash`. Events are joined by `executionId` within a run. The command text is
the `subject` of the `tool.execution.progressed` event. Exit code and
duration come from the `tool.execution.completed` event.

A command is counted only when it has a completed event and a command text and
matches a check kind. Commands that started but never completed (for example a
cancelled run) are excluded from every number.

Each command gets one kind, chosen by the first match in this order:

| Priority | Kind | Matches (case-insensitive, as a whole token) |
| --- | --- | --- |
| 1 | mutation | tokens starting with `pitest`, `stryker`, `mutmut` |
| 2 | test | `test`, `pytest`, `vitest`, `jest` |
| 3 | build | `build` |
| 4 | typecheck | `typecheck`, `tsc`, `mypy`, `pyright` |
| 5 | lint | tokens starting with `lint`, `eslint`, `ruff`, `checkstyle`, `pmd`, `flake8` |
| 6 | compile | tokens starting with `compile`, `javac` |

Commands that match nothing are not checks. The row lists kinds in the order
compile, lint, typecheck, test, mutation, build, and omits kinds with no
commands.

## The numbers

| Number | Definition |
| --- | --- |
| commands | Counted commands of that kind, including those with no reported exit code. |
| failures | Commands of that kind with a non-null, non-zero exit code. |
| first-pass rate | For each run that has a command of that kind with a known exit code, take the earliest one. The rate is the share of those runs where it exited 0. Null when no run qualifies. |
| median, slowest | Over commands with a reported duration. Even counts average the two middle values. Null when none report a duration. |
| agentWaitShare | Sum of the reported durations of all counted commands, divided by the summed runtime (`finishedAt - startedAt`) of runs with a positive runtime. Only commands from those runs count. Null when no run has a positive runtime or no command reported a duration. |
| reworkRuns | Runs that are a retry (`retryOfRunId` set), a scheduled retry (`scheduledRetryAttempt > 0`) or a continuation (`continuationAttempt > 0`). |
| recheckAfterFailure | For each run and kind, the number of commands that started after that run's first failing command of the kind. |
| environmentBlockedCount | Failing commands whose collected output matches `AccessDenied`, `Access Denied`, `Could not resolve` or `403` (case-insensitive). |
| model mix | Per model, cost in cents and input and output tokens summed from `cost_events` for the issue tree. |
| runCount | Runs whose `issueId` is in the issue tree. |
| truncated | True when either read limit was hit (see Known limits). The row then shows "partial: event limit reached". |

A command with no reported exit code is never a pass or a failure. A command
with no reported duration is left out of timing.

## Findings

| Code | Raised when |
| --- | --- |
| no_checks_ran | No counted command at all for the task. The per-kind lines are then not shown. |
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

- Classification matches the command text anywhere in the string, so paths and
  quoted arguments can false-positive. `ls src/test` classifies as test.
- Flags are not interpreted. `gradlew build -x test` classifies as test
  because test outranks build.
- Exit codes depend on the adapter reporting them. A missing exit code
  excludes the command from pass rates and failure counts.
- Only the first 20 000 tool events (`MAX_EVENTS`) and the first 2 000 runs
  (`MAX_RUNS`) for the issue tree are read, oldest first. On very large tasks
  the most recent activity is the part that is missing, and `truncated` is set.
- Runs are matched by `heartbeat_runs.issueId`, so `runCount` can differ from
  the run count in the cost summary.
- The row is hidden when the task has no runs, so a task that was never run
  shows nothing rather than `no_checks_ran`.
- Environment-blocked detection is a text match on command output. A `403`
  anywhere in the output of a failing command counts, and a block whose output
  does not contain one of those strings is missed.
- The command text relies on the `subject` field of progressed events. If an
  adapter omits it, the command is not classified and is not counted.

## Acting on a finding

| Finding | Typical fix |
| --- | --- |
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
