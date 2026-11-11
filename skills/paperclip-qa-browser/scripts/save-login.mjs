#!/usr/bin/env node
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { chromium } from "@playwright/test";

const START_URL = process.argv[2];
if (!START_URL) {
  console.error("Usage: node skills/paperclip-qa-browser/scripts/save-login.mjs <url> [storage-state-path]");
  process.exit(2);
}

function defaultStorageStatePath() {
  const home = process.env.PAPERCLIP_HOME?.trim() || path.join(homedir(), ".paperclip");
  const instanceId = process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  return path.join(path.resolve(home), "instances", instanceId, "qa-browser", "storage-state.json");
}

const storageStatePath = path.resolve(process.argv[3] ?? defaultStorageStatePath());

const browser = await chromium.launch({ channel: "chrome", headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(START_URL);

const prompt = createInterface({ input: process.stdin, output: process.stdout });
await prompt.question("Sign in in the browser window, then press Enter here to save the login. ");
prompt.close();

await mkdir(path.dirname(storageStatePath), { recursive: true, mode: 0o700 });
await context.storageState({ path: storageStatePath });
await chmod(storageStatePath, 0o600);
await browser.close();

console.log(JSON.stringify({ saved: storageStatePath }));
