# Recovering a stuck or failed child task

Use this when you are woken with `issue_blocker_stalled` for a child you created or whose parent chain you are assigned to, or when a child failed, was cancelled or went silent. You do not need the board for this. Act like a lead who owns the outcome: find out what happened, keep what is useful, try again with a better plan, and stop only when more attempts would not help.

## Before you respawn

1. **Read the handoff.** `GET /api/issues/{childId}/handoff` returns the last run and its error, the blocking recovery action, recent comments, documents, work products, the predecessor branch and a `verifyBeforeRepeating` list.
2. **Check what already happened outside Paperclip.** A cancelled run may have pushed commits, opened a merge request or posted a comment. Look at the branch head and the merge request before you ask anyone to redo the work. Never repeat a push, comment or deployment that already landed.
3. **Decide what changes.** If the failure was an infrastructure fault (a restart, a lost controller, an expired lease), the same brief usually works again. If the child failed for a reason in the work itself (a test it could not pass, a missing input, a wrong assumption), say what is different this time in the approach note.

## Respawn

`POST /api/issues/{childId}/respawn` with `{ "reason": "...", "approachNote": "..." }`.

- A respawn creates a new task under the same parent in its own fresh workspace, carries the handoff into its description, moves anything that was waiting on the old task onto the new one, and cancels the old task.
- Calling it twice for the same child returns the same successor.
- It is refused with `child_respawn_predecessor_live` while the child still has a live run and is not blocked. Wait for it to fail or stall; do not stop a healthy run.
- It is refused with the usual codes when the company is paused, the agent cannot be invoked or a budget is stopped. Those are decisions for the board, not faults to work around.
- A task can be respawned three times. The fourth attempt returns `child_respawn_exhausted` and opens a board action with the evidence.

## Work like a person, not a retry loop

- Put what you learned in the approach note: what failed, what you checked, what is different now.
- If the same failure repeats, change the approach (a smaller slice, a different agent, a clarified brief) instead of repeating it.
- If a stall is not the child's fault (an upstream dependency, missing access), say so on the parent and escalate to the board with evidence once, not on every wake.
- Report briefly on the parent: which child, why it stalled, what you checked, which successor you created.
