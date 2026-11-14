import { describe, expect, it } from "vitest";
import { getConfigSchema } from "./config-schema.js";

describe("claude-local config schema", () => {
  it("offers contextCompression as a select that defaults to on", () => {
    const field = getConfigSchema().fields.find((candidate) => candidate.key === "contextCompression");

    expect(field).toMatchObject({ type: "select", default: "on" });
    expect(field?.options?.map((option) => option.value)).toEqual(["on", "record", "off"]);
  });
});
