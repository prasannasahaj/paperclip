import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEARNINGS_INDEX_MAX_BYTES,
  LEARNINGS_INDEX_RELATIVE_PATH,
  formatLearningsIndexGuidance,
  readLearningsIndex,
} from "../services/agent-learnings-index.js";

describe("readLearningsIndex", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-learnings-index-"));
    await fs.mkdir(path.join(root, "learnings"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const indexPath = () => path.join(root, LEARNINGS_INDEX_RELATIVE_PATH);

  it("returns null when the index is missing", async () => {
    await expect(readLearningsIndex(root)).resolves.toBeNull();
  });

  it("returns null for empty or whitespace-only index", async () => {
    await fs.writeFile(indexPath(), "");
    await expect(readLearningsIndex(root)).resolves.toBeNull();
    await fs.writeFile(indexPath(), "  \n\t\n  ");
    await expect(readLearningsIndex(root)).resolves.toBeNull();
  });

  it("returns null when the index is a symlink", async () => {
    const realFile = path.join(root, "elsewhere.md");
    await fs.writeFile(realFile, "- a real entry\n");
    await fs.symlink(realFile, indexPath());
    await expect(readLearningsIndex(root)).resolves.toBeNull();
  });

  it("returns null for invalid UTF-8", async () => {
    await fs.writeFile(indexPath(), Buffer.from([0xff, 0xfe, 0x0a]));
    await expect(readLearningsIndex(root)).resolves.toBeNull();
  });

  it("returns the text unchanged and truncated false when under the cap", async () => {
    const content = "- first entry\n- second entry\n";
    await fs.writeFile(indexPath(), content);
    await expect(readLearningsIndex(root)).resolves.toEqual({ text: content, truncated: false });
  });

  it("truncates at the last newline within the cap", async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `- entry number ${i} with some padding`);
    const content = `${lines.join("\n")}\n`;
    expect(Buffer.byteLength(content)).toBeGreaterThan(LEARNINGS_INDEX_MAX_BYTES);
    await fs.writeFile(indexPath(), content);

    const result = await readLearningsIndex(root);

    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(Buffer.byteLength(result!.text)).toBeLessThanOrEqual(LEARNINGS_INDEX_MAX_BYTES);
    expect(result!.text.endsWith("\n")).toBe(true);
    expect(content.startsWith(result!.text)).toBe(true);
    const keptLines = result!.text.split("\n").slice(0, -1);
    expect(keptLines.length).toBeGreaterThan(0);
    expect(keptLines.every((line) => lines.includes(line))).toBe(true);
  });

  it("a single line longer than the cap yields empty text and truncated true", async () => {
    await fs.writeFile(indexPath(), "x".repeat(LEARNINGS_INDEX_MAX_BYTES + 100));
    await expect(readLearningsIndex(root)).resolves.toEqual({ text: "", truncated: true });
  });

  it("truncation never splits a multi-byte character", async () => {
    const snowmanLine = "☃☃☃\n";
    const lineCount = Math.ceil(LEARNINGS_INDEX_MAX_BYTES / Buffer.byteLength(snowmanLine)) + 5;
    const content = snowmanLine.repeat(lineCount);
    await fs.writeFile(indexPath(), content);

    const result = await readLearningsIndex(root);

    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(Buffer.byteLength(result!.text)).toBeLessThanOrEqual(LEARNINGS_INDEX_MAX_BYTES);
    expect(result!.text).not.toContain("�");
    expect(Buffer.from(result!.text, "utf8").toString("utf8")).toBe(result!.text);
    expect(content.startsWith(result!.text)).toBe(true);
  });
});

describe("formatLearningsIndexGuidance", () => {
  const today = new Date("2026-11-13T10:00:00Z");

  it("names the path and today's date", () => {
    const output = formatLearningsIndexGuidance({ text: "- keep PRs small\n", truncated: false }, today);
    expect(output).toContain("learnings/INDEX.md");
    expect(output).toContain("2026-11-13");
    expect(output).toContain("- keep PRs small");
  });

  it("adds the truncation notice", () => {
    const truncatedOutput = formatLearningsIndexGuidance({ text: "- entry\n", truncated: true }, today);
    expect(truncatedOutput).toContain(
      "The index was truncated at 4096 bytes. Consolidate or retire entries in learnings/INDEX.md.",
    );
    const completeOutput = formatLearningsIndexGuidance({ text: "- entry\n", truncated: false }, today);
    expect(completeOutput).not.toContain("truncated");
  });
});
