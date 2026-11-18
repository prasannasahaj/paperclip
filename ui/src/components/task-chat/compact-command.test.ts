import { describe, expect, it } from "vitest";
import { parseCompactCommand } from "./compact-command";

describe("parseCompactCommand", () => {
  it("matches a bare /compact", () => {
    expect(parseCompactCommand("/compact")).toEqual({ matched: true });
  });

  it("matches /compact surrounded by whitespace and non-breaking spaces", () => {
    expect(parseCompactCommand("  /compact  ")).toEqual({ matched: true });
  });

  it("rejects arguments after /compact", () => {
    expect(parseCompactCommand("/compact now")).toEqual({
      matched: true,
      error: "/compact does not accept arguments.",
    });
  });

  it.each(["/compacting", "compact", "please /compact", "", "   "])(
    "does not match %j",
    (value) => {
      expect(parseCompactCommand(value)).toEqual({ matched: false });
    },
  );
});
