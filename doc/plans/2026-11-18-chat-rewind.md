# /rewind: drop a derailed stretch from a conversation's context

Status: implemented. Project 2 of 3 (Project 1: /compact and the /fork skill, done. Project 3: `!` shell, not designed).

## Intent and why

Prasanna drives long analysis and debugging conversations with Claude agents (all chat agents run Claude through ACPX). A lot of context accumulates. When a side question or a failed trial derails the conversation, he wants to return to an earlier message and continue as if the derailed stretch never happened, without losing the valuable context built before it, and without the agent carrying the derailed turns.

## Goals

- `/rewind` lets the user pick an earlier message in the current session. Everything after it up to the rewind stays visible but is greyed as rewound, and is excluded from the agent's context from then on.
- The agent continues from a state it rebuilds from the thread up to the chosen message, saved as a note document.
- The same action is available as "Rewind to here" on a message.

## Non-goals and anti-goals

- No file or workspace undo. Rewind is for analysis and debugging conversations; the derailed stretch is assumed not to have changed files that matter. The user said file undo is complex and out of scope for now.
- No native session rollback or fork: the runner has none (`packages/paperclip-runner/src`) and ACPX Claude sessions cannot be trimmed.
- No deletion of messages. Anti-goal: rewound content silently still reaching the agent.
- Not available on task chat (non-conversation) in this project, because the reset machinery is conversation-only (`isConversation` gate).

## Facts the design rests on (verified in code)

- `/new` is a user comment with body exactly `/new`. On its run the server sets `conversationBoundaryCommentId`, bumps `conversationSessionGeneration`, deletes the agent's task session so the next run starts fresh, and expires pending questions (`server/src/services/agent-conversations.ts:90`, `:231-262`). Every replay and handoff reads only comments after the boundary (`conversationReplay` `:513`, `buildNativeSessionHandoff`), and about ten other places honour the boundary (confirmation resolution, decision receipts, blockers, explicit continuation, queue admission at `heartbeat/queue.ts:4117`).
- That handoff is capped: last 10 comments, 24 KB, 4 000 chars per entry (`native-session-handoff.ts:8-10`). Too lossy to serve as the state after a long session.
- The comments API supports `after`, `order` and `limit` (`routes/issues.ts` ~17866), so an agent can page a thread in order.
- The UI recognises a session boundary by `comment.conversationSessionGeneration != null` (`ui/src/components/task-chat/task-chat-adapter.ts:75`).
- The composer holds `/new` and `/compact` as action commands. Only `/new` is a command comment parsed on the server by exact match; `/compact` posts no comment and calls its own endpoint (`POST /issues/:id/context/compact`). `/rewind` therefore follows `/new`, not `/compact`.

## Approaches considered

1. **Replay-only.** Exclude the stretch and reuse the `/new` handoff. Cheapest, but the 24 KB cap loses most of a long session, which is the case this exists for. Rejected.
2. **Rewind as a reset with an agent-written state note (recommended).** Reuse the `/new` reset path so every boundary consumer already behaves correctly, and add a one-time instruction for the fresh session: rebuild the state up to the chosen message from the thread and documents, write it down, continue.
3. **Hide rewound comments with a new column and filter every context query.** Precise, but a schema change plus about ten query sites to filter; missing one leaks derailed context to the agent. Rejected for blast radius.
4. **Harness rollback.** Not possible here.

Prasanna asked for conversation-only rewind and did not object to approach 2 after seeing it; treat the choice of approach 2 as my call, to confirm on this doc.

## Design

### Command and picker
- Composer action `rewind` in conversation mode. Selecting it opens a picker of recent messages after the current boundary, user messages and the agent's replies, labelled by author; choosing one posts a user comment with body `/rewind <commentId>`. A "Rewind to here" action on any user or agent message posts the same body.
- Server accepts only the exact shape `/rewind <uuid>` from a user author, as `/new` does. The target must be an undeleted plain comment (a user message or the conversation agent's reply, not a system notice, receipt, question card or marker) in the same conversation, after the current boundary and before the rewind comment; otherwise the comment is posted as-is and nothing resets, and the composer shows why.

### Server
1. `isConversationRewind(body): { targetCommentId: string } | null` beside `isConversationReset`. Generalise the `/new` reset branch so both commands share boundary write, generation bump, session deletion, interaction expiry and the `issue.conversation_session_started` activity. The activity details gain `rewoundToCommentId`.
2. The rewind is an instant reset with no agent turn, exactly like `/new` (`heartbeat.ts` finishes a reset run immediately). The rebuild happens on the next message: when the session boundary is a `/rewind` comment, the fresh-session handoff (`buildNativeSessionHandoff`) leads with a "Rewound conversation" block naming the target comment id and the previous session boundary. It tells the agent to read the previous session up to and including the target with `get_task_history`, ignore every comment, interaction and document created after the target, save the rebuilt state as an issue document under `rewind-state-<generation>` (dense enough for the replay's 4 000-character document excerpt), then answer the latest message.
3. `/rewind` is allowed while the conversation is paused only if `/new` is, matching its pause exemption (`routes/issues.ts:20036`).

### UI
- Comments between the target and the rewind comment render greyed with a "Rewound" label; the rewind comment renders as a "Rewound" boundary marker quoting the message it returned to. The range is derived from the rewind comment's body plus comment order, so nothing is stored beyond the comment.
- Rewound comments stay in exports and search; they are excluded from agent context only.

## Constraints

- Company-scoped, activity-logged, owner-only like `/new` and compaction.
- Idempotent on retry: the boundary lives on the command comment, reusing the `/new` guard (`conversationSessionGeneration == null`).
- Rewind to a message after a prior boundary only; it cannot reach back across a `/new` or an earlier rewind.
- The agent's state note is built from comments and documents. What only lived in the old session (tool output, files read) is lost; the note says so rather than inventing it.

## Decisions I made, for you to check

- Approach 2, reset-based, over hiding comments by column.
- Rewind target is any comment after the boundary, not only the user's own messages.
- The state note is a document, so it survives beyond the live session.
- Greying is derived client-side; no schema change.

## Left to the builder

- The exact directive wording and where it joins the fresh-session prompt (`heartbeat/task-markdown.ts`, `getFreshSessionHandoff`).
- Whether to add a `before` filter to the comments API or have the directive tell the agent to page with `after` and stop at the target.
- Picker design inside the existing composer and the greyed-comment styling per `DESIGN.md`.
- Tests: server reset-path tests extended for the rewind body (valid, wrong conversation, before boundary, retry), composer tests beside the `/compact` ones.

## Calls made after the builder check

The fresh-reader check raised six questions. None needed you; these are my calls:

1. **What the rewind run does.** Nothing: it is an instant reset like `/new`, and the thread marker is the acknowledgement. This replaces the earlier plan of a short note-writing turn, which would have rewired the run lifecycle that every reset path assumes has no agent turn. The cost is that the rebuild happens at the start of your next turn, so that first reply is slower and the note exists only after it.
2. **Note durability.** The live session keeps the full note by resuming. For a recovery from a lost session, the replay only excerpts documents to about 4 000 characters, so the note is instructed to be dense and fit that excerpt, with a new document key per rewind. The 24 KB handoff cap is the reason approach 1 was weak for a whole session; here the cap applies only to the rare fresh-session recovery.
3. **Artefacts from the derailed stretch.** The directive tells the agent to use only documents and interactions created before the target message and to ignore later ones. The replay excludes the derailed comments because they predate the new boundary, but documents saved during the derailed stretch are only excluded by the directive, which is an instruction rather than a filter.
4. **Picker scope.** User messages and agent replies are valid targets, so you can return to just after an answer as well as just before a question. Validation is as written under Command and picker.
5. **Failure.** The boundary is written when the rewind comment is processed, as `/new` does. If the next turn fails, Paperclip's normal failed-run notice and retry apply, and the retry carries the same handoff block. The directive bounds the work by limiting the agent to the thread before the target.
6. **Pause.** `/rewind` mirrors `/new` exactly, including releasing pause holds through the shared reset path (`resumeConversationForReset`, `routes/issues.ts:20036`).

Limit worth knowing: the note is only as good as the written thread. Output the agent only saw in tool results is not in it.
