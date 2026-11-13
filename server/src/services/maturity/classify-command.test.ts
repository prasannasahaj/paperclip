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
});
