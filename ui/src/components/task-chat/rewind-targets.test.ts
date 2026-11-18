import { describe, expect, it } from "vitest";
import type { IssueChatComment } from "@/lib/issue-chat-messages";
import { isBareRewindCommand, rewindTargetsFrom } from "./rewind-targets";

const comment = (id: string, body: string, extra: Record<string, unknown> = {}) => ({
  id, body, authorType: "user", authorUserId: "owner", createdAt: "2026-11-18T10:00:00Z", ...extra,
} as unknown as IssueChatComment);
const agentReply = (id: string, body: string, extra: Record<string, unknown> = {}) =>
  comment(id, body, { authorType: "agent", authorAgentId: "agent-1", authorUserId: null, ...extra });

describe("rewindTargetsFrom", () => {
  it("lists user messages and agent replies newest first", () => {
    const targets = rewindTargetsFrom([comment("q1", "First question"), agentReply("a1", "First answer"), comment("q2", "Second question")]);
    expect(targets.map((target) => [target.id, target.authorLabel])).toEqual([["q2", "You"], ["a1", "Agent"], ["q1", "You"]]);
  });

  it("only lists messages after the latest session boundary", () => {
    const targets = rewindTargetsFrom([
      comment("old", "Old session"),
      comment("boundary", "/new", { conversationSessionGeneration: 1 }),
      comment("new", "Current session"),
    ]);
    expect(targets.map((target) => target.id)).toEqual(["new"]);
  });

  it("skips deleted comments, system notices, platform acknowledgements, unsent echoes and reset commands", () => {
    const targets = rewindTargetsFrom([
      comment("deleted", "Gone", { deletedAt: "2026-11-18T10:01:00Z" }),
      comment("notice", "Run failed", { authorType: "system", presentation: { kind: "system_notice" } }),
      agentReply("ack", "On it", { origin: "fast_response" }),
      comment("sending", "Typing", { clientStatus: "pending" }),
      comment("queued", "Waiting", { clientStatus: "queued" }),
      comment("reset", "/new"),
      comment("kept", "Keep me"),
    ]);
    expect(targets.map((target) => target.id)).toEqual(["kept"]);
  });

  it("shortens long messages to a one-line excerpt", () => {
    const [target] = rewindTargetsFrom([comment("long", `${"word ".repeat(60)}\nsecond line`)]);
    expect(target.excerpt.length).toBeLessThanOrEqual(81);
    expect(target.excerpt).not.toContain("\n");
  });

  it("returns an empty list for an empty session", () => {
    expect(rewindTargetsFrom([comment("b", "/new", { conversationSessionGeneration: 1 })])).toEqual([]);
  });
});

describe("isBareRewindCommand", () => {
  it("matches only /rewind with nothing after it", () => {
    expect(isBareRewindCommand("/rewind")).toBe(true);
    expect(isBareRewindCommand("  /rewind\n")).toBe(true);
    expect(isBareRewindCommand("/rewind now")).toBe(false);
    expect(isBareRewindCommand("/rewind 3f2c1a6e-8b7d-4c1e-9a55-0d6f2b7e1a10")).toBe(false);
    expect(isBareRewindCommand("rewind")).toBe(false);
  });
});
