import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createApi, mergeDelimitedValue, partitionByRisk, resolveBoardToken, sameMembers } from "./talon-onboarding.mjs";

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

function writeAuthStore(credentials) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "talon-onboarding-auth-"));
  const storePath = path.join(dir, "auth.json");
  fs.writeFileSync(storePath, JSON.stringify({ version: 1, credentials }));
  return storePath;
}

test("resolveBoardToken prefers PAPERCLIP_API_KEY over the stored board credential", async () => {
  const storePath = writeAuthStore({ "http://localhost:3100": { token: "stored" } });
  const token = await resolveBoardToken("http://localhost:3100", { PAPERCLIP_API_KEY: " from-env ", PAPERCLIP_AUTH_STORE: storePath });
  assert.equal(token, "from-env");
});

test("resolveBoardToken reads the CLI board credential for the server url, ignoring a trailing slash", async () => {
  const storePath = writeAuthStore({ "http://localhost:3100": { token: "stored" } });
  assert.equal(await resolveBoardToken("http://localhost:3100/", { PAPERCLIP_AUTH_STORE: storePath }), "stored");
});

test("resolveBoardToken returns null when no credential exists for the server", async () => {
  const storePath = writeAuthStore({ "http://other:3100": { token: "stored" } });
  assert.equal(await resolveBoardToken("http://localhost:3100", { PAPERCLIP_AUTH_STORE: storePath }), null);
  assert.equal(await resolveBoardToken("http://localhost:3100", { PAPERCLIP_AUTH_STORE: path.join(os.tmpdir(), "missing-auth.json") }), null);
});

test("createApi sends the bearer token and names the login command on a 401", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers });
    return new Response(JSON.stringify({ error: "Board access required" }), { status: 401 });
  };
  const api = createApi("http://localhost:3100", "tok", fetchImpl);
  await assert.rejects(() => api("GET", "/companies"), /paperclipai auth login/);
  assert.equal(seen[0].headers.authorization, "Bearer tok");
});

test("createApi sends no authorization header without a token", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers);
    return new Response("[]", { status: 200 });
  };
  await createApi("http://localhost:3100", null, fetchImpl)("GET", "/companies");
  assert.equal(seen[0].authorization, undefined);
});
