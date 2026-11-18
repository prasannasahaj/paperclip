# Chat session commands: /compact, /handover, /fork

Status: draft for approval. Scope: Project 1 of 2. Project 2 (`!` shell) is separate and not designed here.

## Intent and why

Prasanna uses Paperclip's own chat (ACPX engine, not `claude-local`) and wants to carry context forward without leaving Paperclip: compact a heavy session and keep going, hand the work to a new task, or fork a new task out of the current conversation while the original continues. Personal use first.

## Goals

- `/compact` in a conversation or task chat asks the harness to compact the current session's context, using the existing "Compact now" mechanism.
- `/handover [instruction]` creates a new task whose brief is a self-contained summary of the conversation, linked back to it.
- `/fork [instruction]` does the same, but the original conversation is explicitly continuing and the new task records the fork source.

## Non-goals and anti-goals

- No forwarding of Claude Code built-in commands to a CLI. Commands are Paperclip's.
- Not a general slash-command framework or per-adapter command discovery.
- Anti-goal: a second compaction mechanism beside the native one.
- `!` shell execution is out of scope.

## Facts the design rests on (verified in code)

- `/new` is a user comment whose body is exactly `/new`; the server detects it (`isConversationReset`, `server/src/services/agent-conversations.ts:90`) and, on the run, writes `conversationBoundaryCommentId` and bumps `conversationSessionGeneration` (`:231-245`). Replay and the fresh-session handoff only read comments after the boundary (`conversationReplay` `:513`, `buildNativeSessionHandoff` in `server/src/services/native-runtime/native-session-handoff.ts`).
- That handoff is mechanical: bounded recent comments, resolved interactions, saved documents and run summaries. No agent-written summary exists today.
- Native compaction already exists: `POST /issues/:id/context/compact` (`server/src/routes/issues.ts:9750`, `server/src/services/context-compaction.ts`) queues a short run that asks the harness to compact (Codex app-server, Claude through ACP), and the Properties panel exposes it as "Compact now" (`ui/src/components/issue-properties/context-usage-row.tsx`). It needs a `paperclip_runner` agent on Codex or ACPX Claude.
- Slash menu options come from `MarkdownEditor` as `[...actionCommands, ...skills/routines]`. Company skills already appear in the menu in conversation mode. The composer registers only `/new` as an action there (`TaskChatComposer.tsx:1440`).
- Conversations can already create tasks with `create_task` and `initialPlan` (`AGENT_CHAT_DIRECTIVE`, `agent-conversations.ts:120`).
- `isConversation` gates the reset machinery, so non-conversation task chat has no session boundary.

## Approaches considered

1. **Hybrid (recommended).** `/compact` is a composer action over the existing compaction endpoint. `/handover` and `/fork` are company skills: editable prompt text that uses the existing `create_task` path, zero server code.
2. All three native, with `/compact` as new server code that writes a session boundary. More control over linking and UI, but three server code paths and a hard-coded summary prompt for what is a prose instruction. Rejected: it duplicates `create_task` and makes the prompt un-editable.
3. All three skills, with `/compact` also a skill. Rejected: a skill cannot compact the harness session, so the old context would still be resent.

Prasanna approved the hybrid shape in conversation ("I like your proposal"). Details below are my calls.

## Design

### /compact
A composer action next to `/new` and `/goal`. It calls the existing compaction endpoint through `useCompactContext` (`ui/src/hooks/useCompactContext.ts`), shared with the Properties row. It works in conversations and task chat. It compacts inside the same session, so there is no new session boundary and no focus text. When compaction is unavailable (agent busy, unsupported harness, no assignee), the command shows the server's reason and keeps the draft.

### /handover and /fork
Two company skills, created in the user's instance (not shipped in the repo catalog for now).
- `/handover`: summarise the conversation into a task brief (outcome, context, acceptance criteria, source links), `create_task` assigned to the conversation agent unless the instruction names another owner, with `initialPlan` and an idempotency key; reply with the task link. Conversation unchanged.
- `/fork`: same, and the brief states it is a fork of this conversation and that the source continues. The conversation is left running and not blocked by the new task.
- Both inherit the existing rules: top-level task unless nesting is asked for, one nesting level at most, do not claim the task exists before it is created and verified.

## Constraints

- Company-scoped and activity-logged by the existing endpoint (`issue.context_compaction_requested`); the endpoint is board-only and, for a chat, owner-only.
- `/compact` is intercepted only where the composer is given a compaction handler. Other surfaces send it as plain text.
- A failed compaction request changes nothing and shows its error.

## Decisions I made, for you to check

- Surface: conversations and task chat, because the native endpoint serves both.
- Handover and fork live as skills in your instance (company Atlas), not in the repo. Their sources are in `claude-workspace/outputs/paperclip-session-skills/`.
- No focus text for `/compact`: the endpoint takes none.
- With no context reading yet, `/compact` says compaction is unavailable until the agent has reported its context.

## Left to the builder

- None outstanding for Project 1.

## Open for later

- Project 2: `!` shell. Sketch only: board-user only, runs in the execution workspace, output saved as a comment the agent sees next turn, behind the same approval and activity logging as other governed actions. Needs its own design and a security pass.
