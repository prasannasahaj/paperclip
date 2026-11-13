import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function verificationSection(): Promise<string> {
  const body = await fs.readFile(path.resolve("skills/paperclip/SKILL.md"), "utf8");
  const heading = "## Verifying Your Work (Required)";
  const start = body.indexOf(heading);
  if (start === -1) return "";
  const next = body.indexOf("\n## ", start + heading.length);
  return body.slice(start, next === -1 ? undefined : next).replace(/\s+/g, " ");
}

describe("paperclip skill verification guidance", () => {
  it("has a verification section", async () => {
    expect(await verificationSection()).not.toBe("");
  });

  it("asks for the focused test on changed files first, stopping at the first failure", async () => {
    const section = await verificationSection();
    expect(section).toContain("focused test");
    expect(section).toContain("--bail=1");
  });

  it("limits the full suite to once per change", async () => {
    expect(await verificationSection()).toContain("full suite at most once");
  });

  it("stops retrying a check that fails for environmental reasons", async () => {
    const section = await verificationSection();
    expect(section).toContain("environmental");
    expect(section).toContain("stop retrying");
  });

  it("asks agents to say what a long command is doing", async () => {
    expect(await verificationSection()).toContain("takes longer than a minute");
  });
});
