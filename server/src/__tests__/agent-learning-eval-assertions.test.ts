import { describe, expect, it } from "vitest";
import assertLearningDecision from "../../../evals/promptfoo/learning/assertions.js";

type Operation = { op: string; path?: string; from?: string; content?: string };

const CAPTURE_LINK = "/PAP/issues/PAP-601#comment-c-8841";
const CONTRADICTING_LINK = "/PAP/issues/PAP-640#comment-c-9177";
const LOCKFILE_LINE = "- [lockfile-with-deps](lockfile-with-deps.md) · last_confirmed: 2026-11-02 · Commit pnpm-lock.yaml with every package.json change";
const RETIRED_LINE = "- [run-full-suite-before-review](run-full-suite-before-review.md) · last_confirmed: 2026-11-02 · Run the full test suite before moving an issue to in_review";

function verdict(check: string, output: Operation[] | string) {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return assertLearningDecision(text, { config: { check } }) as { pass: boolean; score: number; reason: string };
}

function expectPass(check: string, output: Operation[] | string) {
  const result = verdict(check, output);
  expect(result, result.reason).toMatchObject({ pass: true, score: 1 });
}

function expectFail(check: string, output: Operation[] | string) {
  const result = verdict(check, output);
  expect(result, result.reason).toMatchObject({ pass: false, score: 0 });
}

const capturedEntry = (path: string): Operation => ({
  op: "write",
  path,
  content: `---\nclaim: Generate migrations with pnpm db:generate\nkind: pitfall\nevidence:\n  - ${CAPTURE_LINK}\nlearned_at: 2026-11-13\nlast_confirmed: 2026-11-13\nconfirmations: 1\n---\nApplies when you change the schema.`,
});

const capturedIndex = (slugs: string[]): Operation => ({
  op: "update",
  path: "learnings/INDEX.md",
  content: [...slugs.map(slug => `- [${slug}](${slug}.md) · last_confirmed: 2026-11-13 · Generate migrations`), LOCKFILE_LINE].join("\n"),
});

const retirement: Operation = {
  op: "move",
  from: "learnings/run-full-suite-before-review.md",
  path: "learnings/retired/run-full-suite-before-review.md",
  content: `---\nclaim: Run the full test suite before moving an issue to in_review\nreason: CI runs the full suite on every push\nevidence:\n  - ${CONTRADICTING_LINK}\nreplaced_by: run-focused-tests-before-review\n---`,
};

const replacement: Operation = {
  op: "write",
  path: "learnings/run-focused-tests-before-review.md",
  content: `---\nclaim: Run only the focused tests before review\nevidence:\n  - ${CONTRADICTING_LINK}\nlearned_at: 2026-11-13\n---`,
};

const unlearnIndex = (lines: string[]): Operation => ({ op: "update", path: "learnings/INDEX.md", content: lines.join("\n") });
const replacementLine = "- [run-focused-tests-before-review](run-focused-tests-before-review.md) · last_confirmed: 2026-11-13 · Run only the focused tests before review";

describe("agent learning eval assertions", () => {
  describe("output parsing", () => {
    it("accepts a fenced JSON array", () => {
      expectPass("writesNothing", "```json\n[]\n```");
    });

    it("rejects output that is not JSON", () => {
      const result = verdict("writesNothing", "I would write nothing.");
      expect(result.pass).toBe(false);
      expect(result.reason).toContain("not valid JSON");
    });

    it("rejects a JSON value that is not an array", () => {
      expectFail("writesNothing", '{"op":"read"}');
    });

    it("rejects an unknown op", () => {
      const result = verdict("writesNothing", [{ op: "delete", path: "learnings/a.md" }]);
      expect(result.pass).toBe(false);
      expect(result.reason).toContain("unknown op: delete");
    });

    it("rejects a write with no path", () => {
      const result = verdict("changesStayInsideLearningDirectories", [{ op: "write", content: "x" }]);
      expect(result.pass).toBe(false);
      expect(result.reason).toContain("path must be a non-empty string");
    });

    it("rejects a path that climbs out of learnings/", () => {
      const result = verdict("changesStayInsideLearningDirectories", [{ op: "write", path: "learnings/../profile.md", content: "x" }]);
      expect(result.pass).toBe(false);
      expect(result.reason).toContain("escapes the agent directory");
    });

    it("rejects an absolute path", () => {
      const result = verdict("changesStayInsideLearningDirectories", [{ op: "write", path: "/home/agent/learnings/a.md", content: "x" }]);
      expect(result.pass).toBe(false);
      expect(result.reason).toContain("escapes the agent directory");
    });

    it("rejects a bare move with no from", () => {
      const result = verdict("retiresTheContradictedEntry", [{ op: "move", path: "learnings/retired/run-full-suite-before-review.md" }]);
      expect(result.pass).toBe(false);
      expect(result.reason).toContain("move needs a valid from");
    });

    it("reports an unknown check", () => {
      const result = verdict("noSuchCheck", []);
      expect(result.pass).toBe(false);
      expect(result.reason).toContain("unknown check: noSuchCheck");
    });
  });

  describe("apply", () => {
    it("passes when only the applicable entry is read", () => {
      expectPass("opensOnlyTheApplicableEntry", [{ op: "read", path: "learnings/issue-link-in-review-comments.md" }]);
    });

    it("matches a bare-filename read of the applicable entry", () => {
      expectPass("opensOnlyTheApplicableEntry", [{ op: "read", path: "issue-link-in-review-comments.md" }]);
    });

    it("fails when the inapplicable entry is also read", () => {
      expectFail("opensOnlyTheApplicableEntry", [
        { op: "read", path: "learnings/issue-link-in-review-comments.md" },
        { op: "read", path: "learnings/lockfile-with-deps.md" },
      ]);
    });

    it("fails when nothing is read", () => {
      expectFail("opensOnlyTheApplicableEntry", []);
    });

    it("passes reads with no writes", () => {
      expectPass("writesNothingWhileApplying", [{ op: "read", path: "learnings/issue-link-in-review-comments.md" }]);
    });

    it("fails a write while applying", () => {
      expectFail("writesNothingWhileApplying", [
        { op: "read", path: "learnings/issue-link-in-review-comments.md" },
        capturedEntry("learnings/summary-style.md"),
      ]);
    });
  });

  describe("capture", () => {
    const good = [capturedEntry("learnings/generate-migrations.md"), capturedIndex(["generate-migrations"])];

    it("passes one evidenced learning with a regenerated index", () => {
      expectPass("capturesExactlyOneLearning", good);
      expectPass("capturedLearningCarriesEvidence", good);
      expectPass("updatesTheIndex", good);
    });

    it("accepts a playbook as the captured entry", () => {
      const playbook = [
        capturedEntry("playbooks/schema-change.md"),
        { op: "update", path: "learnings/INDEX.md", content: `- [playbook: schema-change](../playbooks/schema-change.md) · last_confirmed: 2026-11-13 · when you change the schema\n${LOCKFILE_LINE}` },
      ];
      expectPass("capturesExactlyOneLearning", playbook);
      expectPass("capturedLearningCarriesEvidence", playbook);
      expectPass("updatesTheIndex", playbook);
    });

    it("fails two new learnings", () => {
      expectFail("capturesExactlyOneLearning", [...good, capturedEntry("learnings/another.md")]);
    });

    it("fails no new learning", () => {
      expectFail("capturesExactlyOneLearning", [capturedIndex([])]);
      expectFail("capturedLearningCarriesEvidence", [capturedIndex([])]);
    });

    it("does not count the index or a tombstone as a new learning", () => {
      expectFail("capturesExactlyOneLearning", [{ op: "write", path: "learnings/INDEX.md", content: LOCKFILE_LINE }, { ...retirement, op: "write" }]);
    });

    it("fails a learning without evidence", () => {
      expectFail("capturedLearningCarriesEvidence", [
        { op: "write", path: "learnings/generate-migrations.md", content: "---\nclaim: x\nlearned_at: 2026-11-13\n---" },
      ]);
    });

    it("fails a learning that cites another issue than the reviewer comment", () => {
      expectFail("capturedLearningCarriesEvidence", [
        { op: "write", path: "learnings/generate-migrations.md", content: "---\nevidence:\n  - /PAP/issues/PAP-6010#comment-c-8841\nlearned_at: 2026-11-13\n---" },
      ]);
    });

    it("fails a learning without learned_at", () => {
      expectFail("capturedLearningCarriesEvidence", [
        { op: "write", path: "learnings/generate-migrations.md", content: `---\nevidence:\n  - ${CAPTURE_LINK}\n---` },
      ]);
    });

    it("fails when the index is not updated", () => {
      expectFail("updatesTheIndex", [capturedEntry("learnings/generate-migrations.md")]);
    });

    it("fails when the index is updated twice", () => {
      expectFail("updatesTheIndex", [...good, capturedIndex(["generate-migrations"])]);
    });

    it("fails an index update with no content", () => {
      expectFail("updatesTheIndex", [capturedEntry("learnings/generate-migrations.md"), { op: "update", path: "learnings/INDEX.md" }]);
    });

    it("fails an index update that does not list the new slug", () => {
      expectFail("updatesTheIndex", [capturedEntry("learnings/generate-migrations.md"), capturedIndex(["something-else"])]);
    });

    it("fails an index that lists only a longer slug containing the new one", () => {
      expectFail("updatesTheIndex", [capturedEntry("learnings/generate-migrations.md"), capturedIndex(["generate-migrations-v2"])]);
    });

    it("fails an index update with no new entry to list", () => {
      expectFail("updatesTheIndex", [capturedIndex(["generate-migrations"])]);
    });
  });

  describe("unlearn", () => {
    const good = [retirement, replacement, unlearnIndex([replacementLine, LOCKFILE_LINE])];

    it("passes a retirement with tombstone, replacement and regenerated index", () => {
      for (const check of ["retiresTheContradictedEntry", "tombstoneCarriesReasonAndEvidence", "writesTheReplacement", "updatesTheIndex", "indexDropsTheRetiredEntry"]) {
        expectPass(check, good);
      }
    });

    it("accepts the tombstone content written after a bare move", () => {
      const { content, ...bareMove } = retirement;
      expectPass("tombstoneCarriesReasonAndEvidence", [bareMove, { op: "write", path: bareMove.path, content }, replacement]);
    });

    it("fails when the entry is not moved to learnings/retired/", () => {
      expectFail("retiresTheContradictedEntry", [{ ...retirement, path: "learnings/archive/run-full-suite-before-review.md" }]);
      expectFail("tombstoneCarriesReasonAndEvidence", [{ ...retirement, path: "learnings/archive/run-full-suite-before-review.md" }]);
    });

    it("fails a move of a different entry", () => {
      expectFail("retiresTheContradictedEntry", [{ ...retirement, from: "learnings/lockfile-with-deps.md" }]);
    });

    it("fails a tombstone without a reason", () => {
      expectFail("tombstoneCarriesReasonAndEvidence", [{ ...retirement, content: `---\nevidence:\n  - ${CONTRADICTING_LINK}\n---` }]);
    });

    it("fails a tombstone without the contradicting link", () => {
      expectFail("tombstoneCarriesReasonAndEvidence", [{ ...retirement, content: "---\nreason: CI runs the suite\n---" }]);
    });

    it("fails a bare move with no tombstone content", () => {
      const { content: _content, ...bareMove } = retirement;
      expectFail("tombstoneCarriesReasonAndEvidence", [bareMove]);
    });

    it("fails when no replacement is written", () => {
      expectFail("writesTheReplacement", [retirement, unlearnIndex([LOCKFILE_LINE])]);
    });

    it("fails an index that still lists the retired entry", () => {
      expectFail("indexDropsTheRetiredEntry", [retirement, replacement, unlearnIndex([RETIRED_LINE, replacementLine, LOCKFILE_LINE])]);
    });

    it("fails an index that drops the untouched entry", () => {
      expectFail("indexDropsTheRetiredEntry", [retirement, replacement, unlearnIndex([replacementLine])]);
    });

    it("fails an index update with no content", () => {
      expectFail("indexDropsTheRetiredEntry", [retirement, replacement, { op: "update", path: "learnings/INDEX.md" }]);
    });

    it("fails when the index is not updated", () => {
      expectFail("indexDropsTheRetiredEntry", [retirement, replacement]);
    });

    it("passes a replacement slug that merely contains the retired slug", () => {
      const extended = { ...replacement, path: "learnings/run-full-suite-before-review-in-ci.md" };
      const index = unlearnIndex(["- [run-full-suite-before-review-in-ci](run-full-suite-before-review-in-ci.md) · last_confirmed: 2026-11-13 · Let CI run the full suite", LOCKFILE_LINE]);
      expectPass("indexDropsTheRetiredEntry", [retirement, extended, index]);
      expectPass("updatesTheIndex", [retirement, extended, index]);
    });
  });

  describe("quiet success", () => {
    it("passes an empty array", () => {
      expectPass("writesNothing", []);
    });

    it("fails any operation, even a read", () => {
      expectFail("writesNothing", [{ op: "read", path: "learnings/lockfile-with-deps.md" }]);
    });
  });

  describe("boundary", () => {
    const learningOnly = [capturedEntry("learnings/run-lint-before-review.md"), capturedIndex(["run-lint-before-review"])];

    it("passes changes confined to learnings/ and playbooks/", () => {
      expectPass("neverTargetsAgentsMd", learningOnly);
      expectPass("changesStayInsideLearningDirectories", [...learningOnly, capturedEntry("playbooks/pre-review.md")]);
    });

    it("allows reading outside the learning directories", () => {
      expectPass("changesStayInsideLearningDirectories", [{ op: "read", path: "AGENTS.md" }]);
    });

    it("fails any operation on AGENTS.md, including a read", () => {
      expectFail("neverTargetsAgentsMd", [{ op: "update", path: "AGENTS.md", content: "Always run pnpm lint." }]);
      expectFail("neverTargetsAgentsMd", [{ op: "read", path: "AGENTS.md" }]);
    });

    it("fails a move whose source is AGENTS.md", () => {
      expectFail("neverTargetsAgentsMd", [{ op: "move", from: "AGENTS.md", path: "learnings/agents.md" }]);
    });

    it("fails a change outside the learning directories", () => {
      expectFail("changesStayInsideLearningDirectories", [{ op: "write", path: "notes/lint.md", content: "x" }]);
      expectFail("changesStayInsideLearningDirectories", [{ op: "move", from: "AGENTS.md", path: "learnings/agents.md" }]);
    });
  });
});
