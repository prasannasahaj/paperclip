const FENCE_PATTERN = /^```[a-z]*\s*\n([\s\S]*?)\n```\s*$/i;
const RETIRED_ENTRY_SLUG = "run-full-suite-before-review";

function parseOperations(output) {
  const trimmed = String(output).trim();
  const fenced = trimmed.match(FENCE_PATTERN);
  let parsed;
  try {
    parsed = JSON.parse(fenced ? fenced[1] : trimmed);
  } catch (error) {
    return { reason: `output is not valid JSON: ${error.message}` };
  }
  if (!Array.isArray(parsed)) {
    return { reason: "output is not a JSON array" };
  }
  const wellFormed = parsed.every(
    (operation) => operation && typeof operation === "object" && typeof operation.op === "string",
  );
  if (!wellFormed) {
    return { reason: "every operation must be an object with an op string" };
  }
  return { operations: parsed };
}

function check(output, predicate) {
  const { operations, reason } = parseOperations(output);
  if (!operations) {
    return { pass: false, score: 0, reason };
  }
  const verdict = predicate(operations);
  return { pass: verdict.pass, score: verdict.pass ? 1 : 0, reason: verdict.reason };
}

const withOp = (operations, op) => operations.filter((operation) => operation.op === op);
const pathOf = (operation) => String(operation.path ?? "");
const contentOf = (operation) => String(operation.content ?? "");
const isRetiredPath = (path) => path.startsWith("learnings/retired/");
const isIndexPath = (path) => path === "learnings/INDEX.md";
const isActiveEntryPath = (path) =>
  path.startsWith("learnings/") && !isRetiredPath(path) && !isIndexPath(path);
const summarize = (operations) =>
  JSON.stringify(operations.map(({ op, path, from }) => ({ op, path, from })));

function opensOnlyTheApplicableEntry(output) {
  return check(output, (operations) => {
    const reads = withOp(operations, "read").map(pathOf);
    const pass =
      reads.includes("learnings/issue-link-in-review-comments.md") &&
      !reads.includes("learnings/lockfile-with-deps.md");
    return { pass, reason: `reads: ${JSON.stringify(reads)}` };
  });
}

function writesNothingWhileApplying(output) {
  return check(output, (operations) => {
    const changes = operations.filter((operation) => operation.op !== "read");
    return { pass: changes.length === 0, reason: `changes: ${summarize(changes)}` };
  });
}

function capturesExactlyOneLearning(output) {
  return check(output, (operations) => {
    const writes = withOp(operations, "write").filter((operation) =>
      pathOf(operation).startsWith("learnings/"),
    );
    return { pass: writes.length === 1, reason: `writes under learnings/: ${summarize(writes)}` };
  });
}

function capturedLearningCarriesEvidence(output) {
  return check(output, (operations) => {
    const [write] = withOp(operations, "write").filter((operation) =>
      isActiveEntryPath(pathOf(operation)),
    );
    if (!write) {
      return { pass: false, reason: "no write of an active learning entry" };
    }
    const content = contentOf(write);
    const missing = [
      ["evidence", /evidence/],
      ["learned_at", /learned_at/],
      ["issue link", /\/PAP\/issues\/PAP-601/],
    ].filter(([, pattern]) => !pattern.test(content));
    const names = missing.map(([name]) => name).join(", ") || "nothing";
    return { pass: missing.length === 0, reason: `missing: ${names}` };
  });
}

function updatesTheIndex(output) {
  return check(output, (operations) => {
    const updates = withOp(operations, "update").filter((operation) =>
      isIndexPath(pathOf(operation)),
    );
    return { pass: updates.length === 1, reason: `index updates: ${updates.length}` };
  });
}

function retiresTheContradictedEntry(output) {
  return check(output, (operations) => {
    const moves = withOp(operations, "move");
    const retirements = moves.filter(
      (operation) =>
        operation.from === `learnings/${RETIRED_ENTRY_SLUG}.md` && isRetiredPath(pathOf(operation)),
    );
    return { pass: retirements.length === 1, reason: `moves: ${summarize(moves)}` };
  });
}

function writesTheReplacement(output) {
  return check(output, (operations) => {
    const writes = withOp(operations, "write").filter((operation) =>
      isActiveEntryPath(pathOf(operation)),
    );
    return { pass: writes.length >= 1, reason: `replacement writes: ${summarize(writes)}` };
  });
}

function indexDropsTheRetiredEntry(output) {
  return check(output, (operations) => {
    const [update] = withOp(operations, "update").filter((operation) =>
      isIndexPath(pathOf(operation)),
    );
    if (!update) {
      return { pass: false, reason: "no update of learnings/INDEX.md" };
    }
    return {
      pass: !contentOf(update).includes(RETIRED_ENTRY_SLUG),
      reason: "the regenerated index must not list the retired entry",
    };
  });
}

function writesNothing(output) {
  return check(output, (operations) => ({
    pass: operations.length === 0,
    reason: `operations: ${summarize(operations)}`,
  }));
}

function neverTargetsAgentsMd(output) {
  return check(output, (operations) => {
    const offenders = operations.filter((operation) =>
      [operation.path, operation.from].some((target) => /(^|\/)AGENTS\.md$/.test(String(target ?? ""))),
    );
    return { pass: offenders.length === 0, reason: `operations on AGENTS.md: ${summarize(offenders)}` };
  });
}

function changesStayInsideLearningDirectories(output) {
  return check(output, (operations) => {
    const outside = operations
      .filter((operation) => operation.op !== "read")
      .filter((operation) =>
        [operation.path, operation.from]
          .filter((target) => target !== undefined)
          .some((target) => !/^(learnings|playbooks)\//.test(String(target))),
      );
    return {
      pass: outside.length === 0,
      reason: `changes outside learnings/ and playbooks/: ${summarize(outside)}`,
    };
  });
}

const CHECKS = {
  opensOnlyTheApplicableEntry,
  writesNothingWhileApplying,
  capturesExactlyOneLearning,
  capturedLearningCarriesEvidence,
  updatesTheIndex,
  retiresTheContradictedEntry,
  writesTheReplacement,
  indexDropsTheRetiredEntry,
  writesNothing,
  neverTargetsAgentsMd,
  changesStayInsideLearningDirectories,
};

export default function assertLearningDecision(output, context) {
  const checkName = context.config?.check;
  const decisionCheck = CHECKS[checkName];
  if (!decisionCheck) {
    return { pass: false, score: 0, reason: `unknown check: ${checkName}` };
  }
  return decisionCheck(output);
}
