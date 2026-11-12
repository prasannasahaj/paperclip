import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNNER_BINARY_STALE_CODE = "paperclip_runner_binary_stale";

export const RUNNER_EMBEDDED_CONTRACT_FILES = [
  "antigravity-distributions.json",
  "protocol/schemas/provider-event.schema.json",
  "protocol/schemas/provider-failure.schema.json",
  "protocol/schemas/question-response.schema.json",
  "protocol/schemas/question-set.schema.json",
  "protocol/schemas/result.schema.json",
  "protocol/schemas/workspace-diff.schema.json",
] as const;

export type RunnerBinaryFreshness =
  | { status: "fresh" }
  | { status: "stale"; staleFiles: string[] }
  | { status: "unverifiable"; reason: string };

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const checkoutRunnerPackageRoot = resolve(moduleDirectory, "../../../../packages/paperclip-runner");

const verdictCache = new Map<string, { signature: string; verdict: RunnerBinaryFreshness }>();

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function fileSignature(path: string): string {
  const stat = statSync(path);
  return `${stat.mtimeMs}:${stat.size}`;
}

function readContractFiles(packageRoot: string): Map<string, Buffer> | null {
  const contents = new Map<string, Buffer>();
  for (const file of RUNNER_EMBEDDED_CONTRACT_FILES) {
    try {
      contents.set(file, readFileSync(resolve(packageRoot, file)));
    } catch {
      return null;
    }
  }
  return contents;
}

function judge(binaryPath: string, packageRoot: string): RunnerBinaryFreshness {
  if (!isInside(packageRoot, resolve(binaryPath))) {
    return { status: "unverifiable", reason: "binary is not built from this checkout" };
  }
  const contracts = readContractFiles(packageRoot);
  if (!contracts) {
    return { status: "unverifiable", reason: "contract sources are not shipped with this runner" };
  }
  let binary: Buffer;
  try {
    binary = readFileSync(binaryPath);
  } catch {
    return { status: "unverifiable", reason: "binary could not be read" };
  }
  const staleFiles = [...contracts].filter(([, contents]) => !binary.includes(contents)).map(([file]) => file);
  return staleFiles.length > 0 ? { status: "stale", staleFiles } : { status: "fresh" };
}

function signatureOf(binaryPath: string, packageRoot: string): string | null {
  try {
    return [binaryPath, ...RUNNER_EMBEDDED_CONTRACT_FILES.map((file) => resolve(packageRoot, file))]
      .map((path) => {
        try {
          return fileSignature(path);
        } catch {
          return "absent";
        }
      })
      .join("|");
  } catch {
    return null;
  }
}

export function checkRunnerBinaryFreshness(
  binaryPath: string,
  packageRoot = checkoutRunnerPackageRoot,
): RunnerBinaryFreshness {
  const signature = signatureOf(binaryPath, packageRoot);
  const cacheKey = `${packageRoot}\0${binaryPath}`;
  const cached = verdictCache.get(cacheKey);
  if (signature && cached?.signature === signature) return cached.verdict;
  const verdict = judge(binaryPath, packageRoot);
  if (signature) verdictCache.set(cacheKey, { signature, verdict });
  return verdict;
}

export class RunnerBinaryStaleError extends Error {
  constructor(readonly binaryPath: string, readonly staleFiles: string[]) {
    super(
      `${RUNNER_BINARY_STALE_CODE}: ${staleFiles.join(", ")} changed after ${binaryPath} was built; ` +
        "rebuild it with: pnpm --filter @paperclipai/paperclip-runner run build:binary",
    );
  }
}

export function assertRunnerBinaryFresh(binaryPath: string, packageRoot = checkoutRunnerPackageRoot): void {
  const freshness = checkRunnerBinaryFreshness(binaryPath, packageRoot);
  if (freshness.status === "stale") throw new RunnerBinaryStaleError(binaryPath, freshness.staleFiles);
}
