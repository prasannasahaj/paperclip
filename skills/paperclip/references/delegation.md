# Delegating work to another agent

Any agent can hand a bounded piece of work or a ruling to another agent: a Product Lead to the Tech Lead, a builder to a peer, a lead to a reviewer or QA. The delegator owns the outcome of its own task. The delegate owns one deliverable and reports a verdict on its own task.

## When to delegate

- Delegate for a different skill, an independent check, or a ruling you cannot give.
- Asking up is delegation too. A Product Lead may give the Tech Lead a task, with the same brief and the same verdict.
- Do not delegate to get past a blocker on your own task. A permission denial, missing access or a missing decision follows the Operating Contract.
- Never choose the reviewer of your own work. Your manager or requester, usually the Tech Lead, delegates review and QA of what you built.
- Never send a question back to its sender. If you were asked, answer it or report `blocked`.
- Agents build two levels only. A task you create under a child lands beside it. Block on it with `blockedByIssueIds`; do not rely on nesting.

## Brief

The delegate may not read your task or its documents. Write the child description so a cold start can finish from it alone.

```md
## Outcome
One sentence: what exists or is decided when this is done.

## Inputs
Links only: issue identifiers, merge request and head SHA, documents, file:line. Do not paste threads.

## Settled decisions
What the delegate must not reopen, and who decided it.

## Acceptance criteria
Numbered and testable. The verdict is judged against these.

## How to run it
Commands, stubs, logins, environment. If something needed is missing, say so here.

## Out of scope
What not to touch or judge.

## Allowed verdicts
pass | fail | partial | answered | blocked

## Bounds
Re-instructions allowed: 2. Stop rule: when to stop and report instead of guessing.

## Report
Post the verdict as the final comment on this task, then set the status shown in the verdict table.
```

Give the delegate everything it needs to run the work. A `partial` caused by a missing stub or login is a brief that left that out.

## Verdict

The delegate's final comment starts with `Verdict: <value>` on line 1, then the evidence. No greeting or recap. Tag each claim `Verified`, `Assumed` or `Unknown`.

| Verdict | Meaning | Required content | Task status |
| --- | --- | --- | --- |
| `pass` | Every criterion met | Each criterion with its evidence | `done` |
| `fail` | At least one criterion not met | Findings ranked blocker or nit, with `file:line` | `done` |
| `partial` | Some criteria verified, some not | **Verified**; **Not verified and why**; **What closes the gap and who can** | `done` |
| `answered` | A consult, not a check | The answer, the reason, what you assumed | `done` |
| `blocked` | Could not start or continue | The exact missing capability and the named owner | `blocked` with a first-class blocker |

- A verdict is the deliverable. `fail` and `partial` are `done`, never `blocked`.
- The delegate writes only on its own task. It never comments on the parent; a low-trust delegate gets a 403 and strands the tree.

## What the delegator does

1. Set `blockedByIssueIds` on your task to the child before you exit. You wake when the child finishes.
2. Read the verdict and decide. Do not pass it upward unchanged.
   - `pass`: continue.
   - `fail` or `partial`: create a fix task, or re-instruct the same child by comment.
   - `answered`: act on it, or say why you will not.
   - `blocked`: clear the blocker yourself, or report once under the Operating Contract.
3. Re-instruct at most twice per child, and name the round in each comment ("Round 2 of 2"). After that, create a new task, respawn it (see `child-recovery.md`), or escalate to the board with the evidence.
4. When the child stalls you are woken. Rule on it, then continue. Do not poll.
5. When the step is finished, close or cancel any child still open.

## Gate

The blocker is the gate: your task stays blocked until the child is done, and you wake when it is. Merge, publish and other irreversible steps stay with the agent that owns the parent.
