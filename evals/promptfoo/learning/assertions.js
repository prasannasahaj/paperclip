import { posix } from "node:path";

const FENCE_PATTERN = /^```[a-z]*\s*\n([\s\S]*?)\n```\s*$/i;
const KNOWN_OPS = ["read", "write", "update", "move"];
const RETIRED_ENTRY_SLUG = "run-full-suite-before-review";
const UNTOUCHED_ENTRY_SLUG = "lockfile-with-deps";
const CAPTURE_EVIDENCE_LINK = "/PAP/issues/PAP-601#comment-c-8841";
const CONTRADICTING_EVIDENCE_LINK = "/PAP/issues/PAP-640#comment-c-9177";
const REASON_PATTERN = /reason|because|no longer holds|superseded/i;

function normalizePath(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return { reason: "path must be a non-empty string" };
  }
  if (posix.isAbsolute(value) || value.split("/").includes("..")) {
    return { reason: `path escapes the agent directory: ${value}` };
  }
  return { path: posix.normalize(value) };
}

function normalizeOperation(operation) {
  if (!operation || typeof operation !== "object" || typeof operation.op !== "string") {
    return { reason: "every operation must be an object with an op string" };
  }
  if (!KNOWN_OPS.includes(operation.op)) {
    return { reason: `unknown op: ${operation.op}` };
  }
  const target = normalizePath(operation.path);
  if (target.reason) {
    return { reason: `${operation.op}: ${target.reason}` };
  }
  const normalized = { ...operation, path: target.path };
  if (operation.op === "move") {
    const source = normalizePath(operation.from);
    if (source.reason) {
      return { reason: `move needs a valid from: ${source.reason}` };
    }
    normalized.from = source.path;
  }
  return { operation: normalized };
}

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
  const operations = [];
  for (const operation of parsed) {
    const normalized = normalizeOperation(operation);
    if (normalized.reason) {
      return { reason: normalized.reason };
    }
    operations.push(normalized.operation);
  }
  return { operations };
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
const pathOf = (operation) => operation.path;
const contentOf = (operation) => String(operation.content ?? "");
const isRetiredPath = (path) => path.startsWith("learnings/retired/");
const isIndexPath = (path) => path === "learnings/INDEX.md";
const isNewEntryPath = (path) =>
  /^(learnings|playbooks)\//.test(path) && !isRetiredPath(path) && !isIndexPath(path);
const newEntryWrites = (operations) =>
  withOp(operations, "write").filter((operation) => isNewEntryPath(pathOf(operation)));
const summarize = (operations) =>
  JSON.stringify(operations.map(({ op, path, from }) => ({ op, path, from })));

const slugOf = (path) => posix.basename(path, ".md");
const escapeForPattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const listsSlug = (content, slug) =>
  new RegExp(`(^|[^a-z0-9-])${escapeForPattern(slug)}([^a-z0-9-]|$)`, "i").test(content);
const indexUpdates = (operations) =>
  withOp(operations, "update").filter((operation) => isIndexPath(pathOf(operation)));

function missingNames(requirements) {
  const missing = requirements.filter(([, present]) => !present).map(([name]) => name);
  return missing.length === 0 ? "nothing" : missing.join(", ");
}

function opensOnlyTheApplicableEntry(output) {
  return check(output, (operations) => {
    const reads = withOp(operations, "read").map((operation) => posix.basename(pathOf(operation)));
    const pass =
      reads.includes("issue-link-in-review-comments.md") && !reads.includes("lockfile-with-deps.md");
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
    const writes = newEntryWrites(operations);
    return { pass: writes.length === 1, reason: `new entries: ${summarize(writes)}` };
  });
}

function capturedLearningCarriesEvidence(output) {
  return check(output, (operations) => {
    const [write] = newEntryWrites(operations);
    if (!write) {
      return { pass: false, reason: "no write of a new learning entry" };
    }
    const content = contentOf(write);
    const requirements = [
      ["evidence key", /^evidence:/m.test(content)],
      ["learned_at key", /^learned_at:/m.test(content)],
      ["comment link", content.includes(CAPTURE_EVIDENCE_LINK)],
    ];
    return { pass: requirements.every(([, present]) => present), reason: `missing: ${missingNames(requirements)}` };
  });
}

function updatesTheIndex(output) {
  return check(output, (operations) => {
    const updates = indexUpdates(operations);
    if (updates.length !== 1) {
      return { pass: false, reason: `index updates: ${updates.length}` };
    }
    const newSlugs = newEntryWrites(operations).map((operation) => slugOf(pathOf(operation)));
    if (newSlugs.length === 0) {
      return { pass: false, reason: "no new entry for the regenerated index to list" };
    }
    const unlisted = newSlugs.filter((slug) => !listsSlug(contentOf(updates[0]), slug));
    return {
      pass: unlisted.length === 0,
      reason: `new entries missing from the regenerated index: ${unlisted.length === 0 ? "nothing" : unlisted.join(", ")}`,
    };
  });
}

function retirementMoves(operations) {
  return withOp(operations, "move").filter(
    (operation) =>
      operation.from === `learnings/${RETIRED_ENTRY_SLUG}.md` && isRetiredPath(pathOf(operation)),
  );
}

function retiresTheContradictedEntry(output) {
  return check(output, (operations) => ({
    pass: retirementMoves(operations).length === 1,
    reason: `moves: ${summarize(withOp(operations, "move"))}`,
  }));
}

function tombstoneCarriesReasonAndEvidence(output) {
  return check(output, (operations) => {
    const [retirement] = retirementMoves(operations);
    if (!retirement) {
      return { pass: false, reason: "the entry was not moved to learnings/retired/" };
    }
    const tombstoneContents = [
      retirement,
      ...operations.filter(
        (operation) =>
          ["write", "update"].includes(operation.op) && pathOf(operation) === pathOf(retirement),
      ),
    ].map(contentOf);
    const requirements = [
      ["reason", tombstoneContents.some((content) => REASON_PATTERN.test(content))],
      [
        "contradicting comment link",
        tombstoneContents.some((content) => content.includes(CONTRADICTING_EVIDENCE_LINK)),
      ],
    ];
    return {
      pass: requirements.every(([, present]) => present),
      reason: `tombstone missing: ${missingNames(requirements)}`,
    };
  });
}

function writesTheReplacement(output) {
  return check(output, (operations) => {
    const writes = newEntryWrites(operations);
    return { pass: writes.length >= 1, reason: `replacement writes: ${summarize(writes)}` };
  });
}

function indexDropsTheRetiredEntry(output) {
  return check(output, (operations) => {
    const [update] = indexUpdates(operations);
    if (!update) {
      return { pass: false, reason: "no update of learnings/INDEX.md" };
    }
    const content = contentOf(update);
    const requirements = [
      ["untouched entry kept", listsSlug(content, UNTOUCHED_ENTRY_SLUG)],
      ["retired entry dropped", !listsSlug(content, RETIRED_ENTRY_SLUG)],
    ];
    return {
      pass: requirements.every(([, present]) => present),
      reason: `regenerated index fails: ${missingNames(requirements)}`,
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
      [operation.path, operation.from].some((target) => /(^|\/)AGENTS\.md$/.test(target ?? "")),
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
          .some((target) => !/^(learnings|playbooks)\//.test(target)),
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
  tombstoneCarriesReasonAndEvidence,
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
