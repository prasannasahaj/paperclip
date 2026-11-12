import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RUNNER_BINARY_STALE_CODE,
  RUNNER_EMBEDDED_CONTRACT_FILES,
  assertRunnerBinaryFresh,
  checkRunnerBinaryFreshness,
} from "./runner-binary-freshness.js";

let packageRoot: string;

async function writeContractFiles(contents: (file: string) => string) {
  for (const file of RUNNER_EMBEDDED_CONTRACT_FILES) {
    const target = join(packageRoot, file);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents(file));
  }
}

async function writeBinaryEmbedding(files: readonly string[], contents: (file: string) => string) {
  const binary = join(packageRoot, "dist", "bin", "paperclip-runnerd");
  await mkdir(join(binary, ".."), { recursive: true });
  await writeFile(binary, ["binary-header", ...files.map(contents), "binary-footer"].join("\n"), { mode: 0o700 });
  return binary;
}

beforeEach(async () => {
  packageRoot = await mkdtemp(join(tmpdir(), "runner-freshness-"));
});

afterEach(async () => {
  await rm(packageRoot, { recursive: true, force: true });
});

describe("runner binary freshness", () => {
  it("is fresh when the binary embeds every contract file as it is on disk", async () => {
    const contents = (file: string) => `{"contract":"${file}"}`;
    await writeContractFiles(contents);
    const binary = await writeBinaryEmbedding(RUNNER_EMBEDDED_CONTRACT_FILES, contents);

    expect(checkRunnerBinaryFreshness(binary, packageRoot)).toEqual({ status: "fresh" });
    expect(() => assertRunnerBinaryFresh(binary, packageRoot)).not.toThrow();
  });

  it("names each contract file that changed after the binary was built", async () => {
    const staleFile = "protocol/schemas/provider-event.schema.json";
    await writeContractFiles((file) => `{"contract":"${file}"}`);
    const binary = await writeBinaryEmbedding(RUNNER_EMBEDDED_CONTRACT_FILES, (file) =>
      file === staleFile ? `{"contract":"${file}","older":true}` : `{"contract":"${file}"}`);

    expect(checkRunnerBinaryFreshness(binary, packageRoot)).toEqual({ status: "stale", staleFiles: [staleFile] });
    expect(() => assertRunnerBinaryFresh(binary, packageRoot)).toThrow(RUNNER_BINARY_STALE_CODE);
    expect(() => assertRunnerBinaryFresh(binary, packageRoot)).toThrow(staleFile);
    expect(() => assertRunnerBinaryFresh(binary, packageRoot)).toThrow("build:binary");
  });

  it("notices a contract file edited after an earlier fresh check", async () => {
    const contents = (file: string) => `{"contract":"${file}"}`;
    await writeContractFiles(contents);
    const binary = await writeBinaryEmbedding(RUNNER_EMBEDDED_CONTRACT_FILES, contents);
    expect(checkRunnerBinaryFreshness(binary, packageRoot)).toEqual({ status: "fresh" });

    const edited = "protocol/schemas/workspace-diff.schema.json";
    await writeFile(join(packageRoot, edited), `{"contract":"${edited}","newField":true}`);

    expect(checkRunnerBinaryFreshness(binary, packageRoot)).toEqual({ status: "stale", staleFiles: [edited] });
  });

  it("cannot judge a packaged runner that ships without the contract sources", async () => {
    const binary = await writeBinaryEmbedding([], () => "");

    expect(checkRunnerBinaryFreshness(binary, packageRoot)).toMatchObject({ status: "unverifiable" });
    expect(() => assertRunnerBinaryFresh(binary, packageRoot)).not.toThrow();
  });

  it("cannot judge a binary that lives outside the runner package", async () => {
    const contents = (file: string) => `{"contract":"${file}"}`;
    await writeContractFiles(contents);
    const outside = await mkdtemp(join(tmpdir(), "runner-outside-"));
    try {
      const binary = join(outside, "paperclip-runnerd");
      await writeFile(binary, "unrelated executable", { mode: 0o700 });

      expect(checkRunnerBinaryFreshness(binary, packageRoot)).toMatchObject({ status: "unverifiable" });
      expect(() => assertRunnerBinaryFresh(binary, packageRoot)).not.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("cannot judge a binary that cannot be read", async () => {
    await writeContractFiles((file) => `{"contract":"${file}"}`);

    expect(checkRunnerBinaryFreshness(join(packageRoot, "dist", "bin", "missing"), packageRoot))
      .toMatchObject({ status: "unverifiable" });
  });
});
