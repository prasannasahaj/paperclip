const CONVERSATION_REWIND_PATTERN = /^\/rewind ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export interface ConversationRewind {
  targetCommentId: string;
}

export function parseConversationRewind(body: string): ConversationRewind | null {
  const match = CONVERSATION_REWIND_PATTERN.exec(body.trim());
  return match ? { targetCommentId: match[1] } : null;
}

export function buildConversationRewindBody(targetCommentId: string): string {
  return `/rewind ${targetCommentId}`;
}

export function isConversationResetBody(body: string): boolean {
  return body.trim() === "/new" || parseConversationRewind(body) !== null;
}
