import { describe, expect, it } from "vitest";
import { classifyCommand } from "./classify-command.js";

describe("classifyCommand", () => {
  it("ranks checkstyle and pmd above compile when they appear together", () => {
    expect(classifyCommand("./gradlew compileJava compileTestJava checkstyleMain pmdMain -q")).toBe("lint");
  });

  it("classifies a plain compile task as compile", () => {
    expect(classifyCommand("./gradlew compileJava")).toBe("compile");
  });

  it.each([
    "./gradlew test",
    "pnpm vitest run server/src/x.test.ts",
    "pytest -q",
  ])("classifies %s as test", (command) => {
    expect(classifyCommand(command)).toBe("test");
  });

  it.each([
    "./gradlew pitest",
    "./gradlew check pitest",
  ])("classifies %s as mutation", (command) => {
    expect(classifyCommand(command)).toBe("mutation");
  });

  it("classifies a gradle build as build", () => {
    expect(classifyCommand("./gradlew build")).toBe("build");
  });

  it.each([
    "pnpm -r typecheck",
    "npx tsc --noEmit",
  ])("classifies %s as typecheck", (command) => {
    expect(classifyCommand(command)).toBe("typecheck");
  });

  it.each([
    "ruff check .",
    "eslint .",
  ])("classifies %s as lint", (command) => {
    expect(classifyCommand(command)).toBe("lint");
  });

  it.each([
    "git status",
    "glab mr view 12 -R x/y",
    "ls",
  ])("returns null for the unrelated command %s", (command) => {
    expect(classifyCommand(command)).toBeNull();
  });

  it("finds the check inside a compound command with a pipe", () => {
    expect(classifyCommand("cd svc && ./gradlew test 2>&1 | tail -40")).toBe("test");
  });

  it("does not treat a word containing test as a test run", () => {
    expect(classifyCommand("git checkout latest")).toBeNull();
  });

  it.each([
    "ls src/test/java",
    "rg foo src/test",
    "git add src/test/java/A.java",
    "mkdir -p test",
    "cat build/reports/tests/test/index.html",
    "cd build",
    "ls build/libs",
    "rm -rf build",
    "docker build .",
    "git log --grep lint",
    "grep -rn compileJava build.gradle",
    "git commit -m 'fix test'",
    "linter.js",
    "cat compileJava.log",
  ])("returns null when a check name is only a path or argument of another program: %s", (command) => {
    expect(classifyCommand(command)).toBeNull();
  });

  it("classifies a gradle check task as build", () => {
    expect(classifyCommand("./gradlew check")).toBe("build");
  });

  it("skips leading environment assignments before the program", () => {
    expect(classifyCommand("FOO=1 ./gradlew test")).toBe("test");
  });

  it("keeps the accepted flag-blind ranking of gradlew build -x test", () => {
    expect(classifyCommand("gradlew build -x test")).toBe("test");
  });

  it("classifies tsc -b as typecheck", () => {
    expect(classifyCommand("tsc -b")).toBe("typecheck");
  });

  it.each([
    ["python -m pytest tests", "test"],
    ["uv run pytest", "test"],
    ["tox -e py312", "test"],
    ["mvn -q test", "test"],
    ["./mvnw compile", "compile"],
    ["make lint", "lint"],
    ["npm run build", "build"],
    ["yarn test:unit", "test"],
    ["bun run lint:fix", "lint"],
    ["npx stryker run", "mutation"],
    ["mutmut run", "mutation"],
    ["mypy src", "typecheck"],
    ["pyright", "typecheck"],
    ["flake8 app", "lint"],
    ["jest --watch=false", "test"],
    ["javac Main.java", "compile"],
    ["./gradlew :svc:integrationTest", "test"],
    ["timeout 600 ./gradlew test", "test"],
  ] as const)("classifies %s as %s", (command, kind) => {
    expect(classifyCommand(command)).toBe(kind);
  });

  it("ranks the strongest kind across segments of a compound command", () => {
    expect(classifyCommand("pnpm lint; pnpm test || true")).toBe("test");
  });

  it("stops reading arguments after an end-of-options marker", () => {
    expect(classifyCommand("npm run lint -- --test")).toBe("lint");
  });
});
