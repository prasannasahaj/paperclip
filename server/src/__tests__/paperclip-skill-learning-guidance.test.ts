import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function skillBody(): Promise<string> {
  return fs.readFile(path.resolve("skills/paperclip/SKILL.md"), "utf8");
}

async function learningSection(): Promise<string> {
  const body = await skillBody();
  const heading = "## Learning From Your Work (Required)";
  const start = body.indexOf(heading);
  if (start === -1) return "";
  const next = body.indexOf("\n## ", start + heading.length);
  return body.slice(start, next === -1 ? undefined : next).replace(/\s+/g, " ");
}

async function heartbeatStepEight(): Promise<string> {
  const body = await skillBody();
  const start = body.indexOf("**Step 8");
  if (start === -1) return "";
  const end = body.indexOf("**Step 9", start);
  return body.slice(start, end === -1 ? undefined : end).replace(/\s+/g, " ");
}

describe("paperclip skill learning guidance", () => {
  it("has a learning section", async () => {
    expect(await learningSection()).not.toBe("");
  });

  it("gates new learnings on surprise, correction, retry or recovered failure", async () => {
    const section = await learningSection();
    expect(section).toContain("surprise");
    expect(section).toContain("correction");
    expect(section).toContain("retry");
    expect(section).toContain("recovered failure");
    expect(section).toContain("write nothing");
  });

  it("wakes on execution_changes_requested as the main capture point", async () => {
    expect(await learningSection()).toContain("execution_changes_requested");
  });

  it("names the layout", async () => {
    const section = await learningSection();
    expect(section).toContain("learnings/INDEX.md");
    expect(section).toContain("learnings/retired/");
    expect(section).toContain("playbooks/");
  });

  it("requires evidence and frontmatter keys", async () => {
    const section = await learningSection();
    expect(section).toContain("evidence");
    expect(section).toContain("learned_at");
    expect(section).toContain("last_confirmed");
    expect(section).toContain("confirmations");
    expect(section).toContain("same company");
  });

  it("reconciles by confirming, superseding or retiring", async () => {
    const section = await learningSection();
    expect(section).toContain("confirm");
    expect(section).toContain("retire");
    expect(section).toContain("tombstone");
  });

  it("retires immediately when an applied learning no longer holds", async () => {
    expect(await learningSection()).toContain("no longer holds");
  });

  it("applies the stale rule", async () => {
    expect(await learningSection()).toContain("90 days");
  });

  it("forbids editing rules and recording secrets", async () => {
    const section = await learningSection();
    expect(section).toContain("AGENTS.md");
    expect(section).toContain("profile");
    expect(section).toContain("skills");
    expect(section).toContain("secrets");
  });

  it("step 8 points at the section", async () => {
    expect(await heartbeatStepEight()).toContain("Learning From Your Work");
  });
});
