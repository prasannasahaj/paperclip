import type { CheckKind } from "@paperclipai/shared";

type ArgumentMatcher = ReadonlyArray<readonly [CheckKind, RegExp]>;

const KIND_PRIORITY: readonly CheckKind[] = ["mutation", "test", "build", "typecheck", "lint", "compile"];
const SEGMENT_SEPARATOR = /&&|\|\||[;|\n]/;
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;
const END_OF_OPTIONS = "--";
const TRANSPARENT_PREFIXES = new Set(["env", "time"]);
const TIMEOUT_PREFIX = "timeout";

function gradleTask(names: string): RegExp {
  return new RegExp(`^(?:[\\w-]*:)*(?:${names})$`);
}

function scriptName(...names: string[]): RegExp {
  return new RegExp(`^(?:${names.join("|")})(?:[:_-][\\w:-]*)?$`);
}

const GRADLE_TASKS: ArgumentMatcher = [
  ["mutation", gradleTask("pitest\\w*")],
  ["test", gradleTask("test|integrationTest")],
  ["build", gradleTask("build|check")],
  ["lint", gradleTask("(?:checkstyle|pmd|spotbugs|ktlint|detekt|lint)\\w*")],
  ["compile", gradleTask("compile\\w*")],
];

const MAVEN_GOALS: ArgumentMatcher = [
  ["mutation", /pitest/i],
  ["test", /^(?:test|integration-test)$/],
  ["build", /^(?:verify|package|install)$/],
  ["lint", /^(?:checkstyle|pmd|spotbugs|spotless):/],
  ["compile", /^(?:compile|test-compile)$/],
];

const SCRIPT_NAMES: ArgumentMatcher = [
  ["mutation", scriptName("stryker")],
  ["test", scriptName("test", "vitest", "jest")],
  ["build", scriptName("build", "check")],
  ["typecheck", scriptName("typecheck", "tsc")],
  ["lint", scriptName("lint", "eslint")],
];

const PROGRAM_KINDS = new Map<string, CheckKind>([
  ["pytest", "test"],
  ["tox", "test"],
  ["vitest", "test"],
  ["jest", "test"],
  ["tsc", "typecheck"],
  ["mypy", "typecheck"],
  ["pyright", "typecheck"],
  ["eslint", "lint"],
  ["ruff", "lint"],
  ["flake8", "lint"],
  ["stryker", "mutation"],
  ["mutmut", "mutation"],
  ["javac", "compile"],
]);

const TASK_RUNNERS = new Map<string, ArgumentMatcher>([
  ["gradlew", GRADLE_TASKS],
  ["gradle", GRADLE_TASKS],
  ["mvn", MAVEN_GOALS],
  ["mvnw", MAVEN_GOALS],
  ["pnpm", SCRIPT_NAMES],
  ["npm", SCRIPT_NAMES],
  ["yarn", SCRIPT_NAMES],
  ["bun", SCRIPT_NAMES],
  ["make", SCRIPT_NAMES],
]);

const PACKAGE_LAUNCHERS = new Set(["npx", "pnpx", "bunx"]);
const RUN_SUBCOMMAND_LAUNCHERS = new Set(["uv", "poetry"]);
const PYTHON_INTERPRETERS = new Set(["python", "python3"]);

function isFlag(token: string): boolean {
  return token.startsWith("-");
}

function basename(token: string): string {
  return token.slice(token.lastIndexOf("/") + 1);
}

function tokensOf(segment: string): string[] {
  return segment.trim().replace(/^\(+|\)+$/g, "").split(/\s+/).filter(Boolean);
}

function withoutPrefixes(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (ENV_ASSIGNMENT.test(token) || TRANSPARENT_PREFIXES.has(token)) index += 1;
    else if (token === TIMEOUT_PREFIX) index += 2;
    else break;
  }
  return tokens.slice(index);
}

function positionalArguments(args: string[]): string[] {
  const endOfOptions = args.indexOf(END_OF_OPTIONS);
  const scanned = endOfOptions === -1 ? args : args.slice(0, endOfOptions);
  return scanned.filter((arg) => !isFlag(arg));
}

function strongestKind(kinds: Array<CheckKind | null>): CheckKind | null {
  return KIND_PRIORITY.find((kind) => kinds.includes(kind)) ?? null;
}

function argumentKind(matcher: ArgumentMatcher, arg: string): CheckKind | null {
  return matcher.find(([, pattern]) => pattern.test(arg))?.[0] ?? null;
}

function dropLeadingFlags(tokens: string[]): string[] {
  const firstPositional = tokens.findIndex((token) => !isFlag(token));
  return firstPositional === -1 ? [] : tokens.slice(firstPositional);
}

function launchedInvocation(program: string, args: string[]): string[] | null {
  if (PACKAGE_LAUNCHERS.has(program)) return dropLeadingFlags(args);
  if (RUN_SUBCOMMAND_LAUNCHERS.has(program)) {
    const [subcommand, ...rest] = dropLeadingFlags(args);
    return subcommand === "run" ? dropLeadingFlags(rest) : null;
  }
  if (PYTHON_INTERPRETERS.has(program) && args[0] === "-m") return args.slice(1);
  return null;
}

function classifyInvocation(tokens: string[]): CheckKind | null {
  const [programToken, ...args] = withoutPrefixes(tokens);
  if (programToken === undefined) return null;
  const program = basename(programToken);
  const direct = PROGRAM_KINDS.get(program);
  if (direct) return direct;
  const runner = TASK_RUNNERS.get(program);
  if (runner) return strongestKind(positionalArguments(args).map((arg) => argumentKind(runner, arg)));
  const launched = launchedInvocation(program, args);
  return launched ? classifyInvocation(launched) : null;
}

export function classifyCommand(command: string): CheckKind | null {
  return strongestKind(command.split(SEGMENT_SEPARATOR).map((segment) => classifyInvocation(tokensOf(segment))));
}
