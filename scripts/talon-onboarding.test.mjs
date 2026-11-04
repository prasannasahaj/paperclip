import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mergeDelimitedValue, partitionByRisk, sameMembers } from "./talon-onboarding.mjs";

test("mergeDelimitedValue appends only missing roots and reports a change", () => {
  const joined = ["/a", "/b"].join(path.delimiter);
  assert.deepEqual(mergeDelimitedValue(joined, ["/b", "/c"]), { value: ["/a", "/b", "/c"].join(path.delimiter), changed: true });
  assert.deepEqual(mergeDelimitedValue(joined, ["/a"]), { value: joined, changed: false });
  assert.deepEqual(mergeDelimitedValue(undefined, ["/a"]), { value: "/a", changed: true });
});

test("partitionByRisk allows listed risks and sends everything else to ask-first", () => {
  const tools = [
    { id: "1", risk: "read" },
    { id: "2", risk: "write" },
    { id: "3", risk: undefined },
  ];
  assert.deepEqual(partitionByRisk(tools, ["read"]), { enabled: ["1"], askFirst: ["2", "3"] });
});

test("sameMembers ignores order and rejects different sets", () => {
  assert.equal(sameMembers(["a", "b"], ["b", "a"]), true);
  assert.equal(sameMembers(["a"], ["a", "b"]), false);
});
