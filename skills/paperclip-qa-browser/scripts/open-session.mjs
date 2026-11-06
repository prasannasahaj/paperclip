#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEBUG_PORT = Number(process.env.QA_CHROME_PORT ?? 9333);
const PROFILE_DIR =
  process.env.QA_CHROME_PROFILE ?? path.join(homedir(), ".paperclip", "qa-chrome-profile");
const START_URL = process.argv[2] ?? "about:blank";
const HEADLESS = process.env.QA_CHROME_HEADLESS === "1";

const CHROME_CANDIDATES = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

function findChrome() {
  const candidates = CHROME_CANDIDATES[process.platform] ?? [];
  return process.env.QA_CHROME_BIN ?? candidates.find((candidate) => existsSync(candidate));
}

async function debugEndpoint() {
  try {
    const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function waitForDebugEndpoint(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpoint = await debugEndpoint();
    if (endpoint) return endpoint;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function report(endpoint, reused) {
  console.log(
    JSON.stringify({
      status: reused ? "already-running" : "started",
      cdpUrl: `http://127.0.0.1:${DEBUG_PORT}`,
      browser: endpoint.Browser,
      profileDir: PROFILE_DIR,
    }),
  );
}

const running = await debugEndpoint();
if (running) {
  report(running, true);
  process.exit(0);
}

const chromeBinary = findChrome();
if (!chromeBinary) {
  console.error("Google Chrome not found. Set QA_CHROME_BIN to its executable path.");
  process.exit(2);
}

mkdirSync(PROFILE_DIR, { recursive: true });

const chrome = spawn(
  chromeBinary,
  [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--remote-debugging-address=127.0.0.1",
    "--use-mock-keychain",
    "--password-store=basic",
    "--no-first-run",
    "--no-default-browser-check",
    ...(HEADLESS ? ["--headless=new"] : []),
    START_URL,
  ],
  { detached: true, stdio: "ignore" },
);
chrome.unref();

const started = await waitForDebugEndpoint(20_000);
if (!started) {
  console.error(`Chrome did not expose a debugging endpoint on port ${DEBUG_PORT} within 20s.`);
  process.exit(3);
}
report(started, false);
