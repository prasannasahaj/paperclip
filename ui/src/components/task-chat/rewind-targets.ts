import { isConversationResetBody } from "@paperclipai/shared";
import type { IssueChatComment } from "@/lib/issue-chat-messages";

export interface RewindTarget {
  id: string;
  authorLabel: "You" | "Agent";
  excerpt: string;
}

const EXCERPT_CHARS = 80;
const MAX_TARGETS = 8;

export function isBareRewindCommand(value: string): boolean {
  return value.trim() === "/rewind";
}

function excerptOf(body: string): string {
  const text = body.trim().replace(/\s+/g, " ");
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text;
}

function isRewindable(comment: IssueChatComment): boolean {
  if (comment.deletedAt || comment.presentation || comment.origin === "fast_response") return false;
  if (comment.clientStatus || comment.conversationSessionGeneration != null) return false;
  if (comment.authorType !== "user" && comment.authorType !== "agent") return false;
  return !isConversationResetBody(comment.body);
}

export function rewindTargetsFrom(comments: IssueChatComment[]): RewindTarget[] {
  const lastBoundary = comments.findLastIndex(
    (comment) => !comment.deletedAt && comment.conversationSessionGeneration != null,
  );
  return comments
    .slice(lastBoundary + 1)
    .filter(isRewindable)
    .reverse()
    .slice(0, MAX_TARGETS)
    .map((comment) => ({
      id: comment.id,
      authorLabel: comment.authorType === "agent" ? "Agent" : "You",
      excerpt: excerptOf(comment.body),
    }));
}
