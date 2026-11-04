#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SNAPSHOT_RECORD_FILE = ".paperclip-snapshot.json";
const PLUGIN_MANIFEST_RELATIVE_PATH = path.join(".claude-plugin", "plugin.json");
const EXCLUDED_ENTRY_NAMES = new Set([".git", ".in_use"]);
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function usage() {
  return [
    "Usage: claude-plugin-sync.mjs --company <companyId> [--only name,name] [--dry-run]",
    "                              [--claude-config-dir <dir>] [--paperclip-home <dir>] [--instance <id>]",
    "",
    "Copies installed Claude Code plugins into the company's Paperclip plugin store as pinned snapshots.",
    "Re-run after `claude plugin update` to refresh them.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { dryRun: false, only: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--company") options.company = argv[++index];
    else if (flag === "--only") options.only = new Set((argv[++index] ?? "").split(",").map((name) => name.trim()).filter(Boolean));
    else if (flag === "--claude-config-dir") options.claudeConfigDir = argv[++index];
    else if (flag === "--paperclip-home") options.paperclipHome = argv[++index];
    else if (flag === "--instance") options.instance = argv[++index];
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return options;
}

function expandHome(candidate) {
  if (candidate === "~") return os.homedir();
  if (candidate.startsWith("~/")) return path.join(os.homedir(), candidate.slice(2));
  return candidate;
}

function resolveStoreDir(options) {
  const home = path.resolve(expandHome(options.paperclipHome ?? process.env.PAPERCLIP_HOME ?? path.join(os.homedir(), ".paperclip")));
  const instance = options.instance ?? process.env.PAPERCLIP_INSTANCE_ID ?? "default";
  if (!INSTANCE_ID_PATTERN.test(instance)) throw new Error(`Invalid instance id '${instance}'.`);
  return path.join(home, "instances", instance, "companies", options.company, "claude-plugins");
}

function resolveClaudeConfigDir(options) {
  const configured = options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR;
  return path.resolve(expandHome(configured ?? path.join(os.homedir(), ".claude")));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readInstalledPlugins(claudeConfigDir) {
  const registry = await readJson(path.join(claudeConfigDir, "plugins", "installed_plugins.json"));
  return Object.entries(registry.plugins ?? {}).flatMap(([key, installs]) => {
    const install = installs.find((candidate) => candidate.scope === "user") ?? installs[0];
    if (!install?.installPath) return [];
    const separator = key.lastIndexOf("@");
    return [{
      key,
      name: separator < 0 ? key : key.slice(0, separator),
      marketplace: separator < 0 ? null : key.slice(separator + 1),
      installPath: install.installPath,
      version: install.version ?? null,
      gitCommitSha: install.gitCommitSha ?? null,
    }];
  });
}

async function readSnapshotRecord(pluginDir) {
  return readJson(path.join(pluginDir, SNAPSHOT_RECORD_FILE)).catch(() => null);
}

function isCurrent(record, plugin) {
  return Boolean(record)
    && record.key === plugin.key
    && record.version === plugin.version
    && record.gitCommitSha === plugin.gitCommitSha;
}

async function copyPluginTree(source, destination) {
  await fs.cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: (entry) => !EXCLUDED_ENTRY_NAMES.has(path.basename(entry)),
  });
}

async function writeSnapshot(plugin, storeDir) {
  const target = path.join(storeDir, plugin.name);
  const staging = await fs.mkdtemp(path.join(storeDir, ".staging-"));
  try {
    await copyPluginTree(plugin.installPath, staging);
    await fs.writeFile(
      path.join(staging, SNAPSHOT_RECORD_FILE),
      JSON.stringify({
        key: plugin.key,
        version: plugin.version,
        gitCommitSha: plugin.gitCommitSha,
        sourcePath: plugin.installPath,
        syncedAt: new Date().toISOString(),
      }, null, 2),
    );
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(staging, target);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function syncPlugin(plugin, storeDir, dryRun, claimedNames) {
  const manifestPath = path.join(plugin.installPath, PLUGIN_MANIFEST_RELATIVE_PATH);
  const hasManifest = await fs.access(manifestPath).then(() => true).catch(() => false);
  if (!hasManifest) return { plugin, outcome: "skipped", reason: "no .claude-plugin/plugin.json at install path" };
  if (claimedNames.has(plugin.name)) return { plugin, outcome: "skipped", reason: `name collides with ${claimedNames.get(plugin.name)}` };
  claimedNames.set(plugin.name, plugin.key);
  const existing = await readSnapshotRecord(path.join(storeDir, plugin.name));
  if (isCurrent(existing, plugin)) return { plugin, outcome: "unchanged" };
  if (dryRun) return { plugin, outcome: existing ? "would-update" : "would-add" };
  await writeSnapshot(plugin, storeDir);
  return { plugin, outcome: existing ? "updated" : "added" };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.company) {
    console.log(usage());
    process.exit(options.help ? 0 : 2);
  }
  const claudeConfigDir = resolveClaudeConfigDir(options);
  const storeDir = resolveStoreDir(options);
  const installed = await readInstalledPlugins(claudeConfigDir);
  const selected = options.only ? installed.filter((plugin) => options.only.has(plugin.name)) : installed;
  if (selected.length === 0) {
    console.error(`No matching plugins in ${path.join(claudeConfigDir, "plugins", "installed_plugins.json")}`);
    process.exit(1);
  }
  if (!options.dryRun) await fs.mkdir(storeDir, { recursive: true });
  const claimedNames = new Map();
  const results = [];
  for (const plugin of selected) results.push(await syncPlugin(plugin, storeDir, options.dryRun, claimedNames));
  for (const { plugin, outcome, reason } of results) {
    const detail = reason ? ` (${reason})` : "";
    console.log(`${outcome.padEnd(12)} ${plugin.name}@${plugin.version ?? "unversioned"}${detail}`);
  }
  console.log(`store: ${storeDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
