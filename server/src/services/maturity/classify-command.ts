import type { CheckKind } from "@paperclipai/shared";

const TOKEN_START = String.raw`(?<![\w.-])`;
const EXACT_TOKEN_END = String.raw`(?![\w.-])`;
const PREFIX_TOKEN_END = String.raw`(?![.-])`;

function exactToken(...names: string[]): RegExp {
  return new RegExp(`${TOKEN_START}(?:${names.join("|")})${EXACT_TOKEN_END}`, "i");
}

function prefixToken(...names: string[]): RegExp {
  return new RegExp(`${TOKEN_START}(?:${names.join("|")})\\w*${PREFIX_TOKEN_END}`, "i");
}

const CHECK_KIND_PRIORITY: ReadonlyArray<readonly [CheckKind, RegExp]> = [
  ["mutation", prefixToken("pitest", "stryker", "mutmut")],
  ["test", exactToken("test", "pytest", "vitest", "jest")],
  ["build", exactToken("build")],
  ["typecheck", exactToken("typecheck", "tsc", "mypy", "pyright")],
  ["lint", prefixToken("lint", "eslint", "ruff", "checkstyle", "pmd", "flake8")],
  ["compile", prefixToken("compile", "javac")],
];

export function classifyCommand(command: string): CheckKind | null {
  const match = CHECK_KIND_PRIORITY.find(([, pattern]) => pattern.test(command));
  return match ? match[0] : null;
}
