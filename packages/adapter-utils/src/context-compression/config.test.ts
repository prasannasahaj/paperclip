import { describe, expect, it } from "vitest";
import { readContextCompressionMode } from "./config.js";

describe("readContextCompressionMode", () => {
  it("defaults to on when unset", () => {
    expect(readContextCompressionMode({})).toBe("on");
  });

  it("accepts on, record, off case-insensitively", () => {
    expect(readContextCompressionMode({ contextCompression: "on" })).toBe("on");
    expect(readContextCompressionMode({ contextCompression: "record" })).toBe("record");
    expect(readContextCompressionMode({ contextCompression: "off" })).toBe("off");
    expect(readContextCompressionMode({ contextCompression: "OFF" })).toBe("off");
    expect(readContextCompressionMode({ contextCompression: " Record " })).toBe("record");
  });

  it.each(["bogus", 42, null, {}])("falls back to on for unknown strings and non-strings (%j)", (value) => {
    expect(readContextCompressionMode({ contextCompression: value })).toBe("on");
  });
});
