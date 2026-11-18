import { describe, expect, it } from "vitest";
import { buildConversationRewindBody, isConversationResetBody, parseConversationRewind } from "./conversation-rewind.js";

const TARGET_ID = "3f2c1a6e-8b7d-4c1e-9a55-0d6f2b7e1a10";

describe("parseConversationRewind", () => {
  it("parses a canonical rewind body", () => {
    expect(parseConversationRewind(`/rewind ${TARGET_ID}`)).toEqual({ targetCommentId: TARGET_ID });
  });

  it("ignores surrounding whitespace", () => {
    expect(parseConversationRewind(`  /rewind ${TARGET_ID}\n`)).toEqual({ targetCommentId: TARGET_ID });
  });

  it("rejects extra text after the id", () => {
    expect(parseConversationRewind(`/rewind ${TARGET_ID} please`)).toBeNull();
  });

  it("rejects text before the command", () => {
    expect(parseConversationRewind(`do /rewind ${TARGET_ID}`)).toBeNull();
  });

  it("rejects uppercase ids", () => {
    expect(parseConversationRewind(`/rewind ${TARGET_ID.toUpperCase()}`)).toBeNull();
  });

  it("rejects a missing id", () => {
    expect(parseConversationRewind("/rewind")).toBeNull();
    expect(parseConversationRewind("/rewind ")).toBeNull();
  });

  it("rejects an invalid uuid", () => {
    expect(parseConversationRewind("/rewind not-a-uuid")).toBeNull();
  });

  it("rejects /new", () => {
    expect(parseConversationRewind("/new")).toBeNull();
  });
});

describe("buildConversationRewindBody", () => {
  it("round-trips through parseConversationRewind", () => {
    expect(parseConversationRewind(buildConversationRewindBody(TARGET_ID))).toEqual({ targetCommentId: TARGET_ID });
  });

  it("produces the canonical body", () => {
    expect(buildConversationRewindBody(TARGET_ID)).toBe(`/rewind ${TARGET_ID}`);
  });
});

describe("isConversationResetBody", () => {
  it("is true for /new and for a rewind body", () => {
    expect(isConversationResetBody("/new")).toBe(true);
    expect(isConversationResetBody(` /new\n`)).toBe(true);
    expect(isConversationResetBody(`/rewind ${TARGET_ID}`)).toBe(true);
  });

  it("is false for ordinary text and malformed commands", () => {
    expect(isConversationResetBody("hello")).toBe(false);
    expect(isConversationResetBody("/new please")).toBe(false);
    expect(isConversationResetBody(`/rewind ${TARGET_ID} please`)).toBe(false);
  });
});
