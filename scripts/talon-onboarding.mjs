#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(SCRIPT_DIR, "talon-onboarding.config.json");
const IMPORT_ROOTS_ENV_KEY = "PAPERCLIP_SKILL_IMPORT_ROOTS";
const STEPS = ["env", "skills", "plugins", "mcp"];

function usage() {
  return [
    "Usage: talon-onboarding.mjs [--config <file>] [--only env,skills,plugins,mcp] [--dry-run] [--no-open]",
    "",
    "Applies scripts/talon-onboarding.config.json to a running Paperclip server. Safe to re-run.",
    "Order: env -> restart server if it changed -> skills -> plugins -> mcp (sign in once, then re-run).",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { config: DEFAULT_CONFIG_PATH, only: new Set(STEPS), dryRun: false, open: true };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--config") options.config = path.resolve(argv[++index]);
    else if (flag === "--only") options.only = new Set((argv[++index] ?? "").split(",").map((name) => name.trim()).filter(Boolean));
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--no-open") options.open = false;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  for (const step of options.only) if (!STEPS.includes(step)) throw new Error(`Unknown step: ${step}`);
  return options;
}

export function expandHome(candidate) {
  if (candidate === "~") return os.homedir();
  if (candidate.startsWith("~/")) return path.join(os.homedir(), candidate.slice(2));
  return candidate;
}

export function mergeDelimitedValue(existing, required, delimiter = path.delimiter) {
  const current = (existing ?? "").split(delimiter).map((entry) => entry.trim()).filter(Boolean);
  const merged = [...new Set([...current, ...required])];
  return { value: merged.join(delimiter), changed: merged.length !== current.length };
}

export function partitionByRisk(tools, allowedRisks) {
  const allowed = new Set(allowedRisks);
  return {
    enabled: tools.filter((tool) => allowed.has(tool.risk)).map((tool) => tool.id),
    askFirst: tools.filter((tool) => !allowed.has(tool.risk)).map((tool) => tool.id),
  };
}

export function sameMembers(left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function createLogger(dryRun) {
  const prefix = dryRun ? "[dry-run] " : "";
  return {
    step: (name) => console.log(`\n== ${name}`),
    ok: (message) => console.log(`  ok    ${message}`),
    change: (message) => console.log(`  ${prefix}do    ${message}`),
    warn: (message) => console.log(`  warn  ${message}`),
  };
}

function createApi(serverUrl) {
  return async function api(method, route, body) {
    const response = await fetch(new URL(`/api${route}`, serverUrl), {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(`${method} ${route} -> HTTP ${response.status}: ${payload?.error ?? text}`);
      error.status = response.status;
      error.code = payload?.code ?? payload?.details?.code ?? null;
      throw error;
    }
    return payload;
  };
}

function resolveInstanceEnvPath() {
  const home = path.resolve(expandHome(process.env.PAPERCLIP_HOME ?? path.join(os.homedir(), ".paperclip")));
  const instance = process.env.PAPERCLIP_INSTANCE_ID ?? "default";
  return path.join(home, "instances", instance, ".env");
}

async function ensureImportRootsEnv(config, context) {
  const envPath = resolveInstanceEnvPath();
  const required = config.skillImportRoots.map((root) => path.resolve(expandHome(root)));
  const raw = await fs.readFile(envPath, "utf8").catch(() => "");
  const lines = raw.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${IMPORT_ROOTS_ENV_KEY}=`));
  const existing = index >= 0 ? lines[index].slice(IMPORT_ROOTS_ENV_KEY.length + 1) : "";
  const { value, changed } = mergeDelimitedValue(existing, required);
  if (index >= 0 && !changed) {
    context.log.ok(`${IMPORT_ROOTS_ENV_KEY} already covers ${required.length} root(s)`);
    return;
  }
  context.log.change(`set ${IMPORT_ROOTS_ENV_KEY} in ${envPath}`);
  if (context.dryRun) return;
  const entry = `${IMPORT_ROOTS_ENV_KEY}=${value}`;
  const next = index >= 0 ? lines.map((line, position) => (position === index ? entry : line)) : [...lines.filter((line, position) => position < lines.length - 1 || line !== ""), entry, ""];
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  await fs.writeFile(envPath, next.join("\n"));
  context.log.warn("restart the Paperclip server so it picks up the new import roots, then re-run");
}

async function importSkills(config, context) {
  for (const source of config.skillSources.map((entry) => path.resolve(expandHome(entry)))) {
    if (context.dryRun) {
      context.log.change(`import ${source}`);
      continue;
    }
    try {
      const result = await context.api("POST", `/companies/${context.companyId}/skills/import`, { source });
      context.log.ok(`${result.imported.length} skill(s) from ${source}`);
    } catch (error) {
      if (error.code === "skill_workspace_boundary_denied") {
        throw new Error(`${source} is outside the server's approved import roots. Restart the server after the env step, then re-run.`);
      }
      throw error;
    }
  }
}

function runPluginSync(config, context) {
  const args = [
    path.join(SCRIPT_DIR, "claude-plugin-sync.mjs"),
    "--company", context.companyId,
    "--only", config.plugins.sync.join(","),
    "--claude-config-dir", path.resolve(expandHome(config.plugins.claudeConfigDir)),
  ];
  if (context.dryRun) args.push("--dry-run");
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error("claude-plugin-sync failed");
}

async function applyAgentPluginAllowLists(config, context) {
  for (const [agentName, plugins] of Object.entries(config.plugins.agentAllowList)) {
    const agent = context.agentsByName.get(agentName);
    if (!agent) throw new Error(`Agent not found: ${agentName}`);
    const current = (await context.api("GET", `/agents/${agent.id}`)).adapterConfig?.plugins ?? [];
    if (sameMembers(current, plugins)) {
      context.log.ok(`${agentName} plugin allow-list already ${JSON.stringify(plugins)}`);
      continue;
    }
    context.log.change(`set ${agentName} plugin allow-list to ${JSON.stringify(plugins)}`);
    if (!context.dryRun) await context.api("PATCH", `/agents/${agent.id}`, { adapterConfig: { plugins } });
  }
}

async function setupPlugins(config, context) {
  runPluginSync(config, context);
  await applyAgentPluginAllowLists(config, context);
}

async function findConnection(context, name) {
  const { connections } = await context.api("GET", `/companies/${context.companyId}/tools/connections`);
  const matches = connections.filter((connection) => connection.name === name);
  return matches.find((connection) => connection.status === "active") ?? matches[0] ?? null;
}

async function startAuthorization(context, spec, existing) {
  const body = {
    link: spec.url,
    name: spec.name,
    authMode: "oauth",
    oauthClient: { clientId: spec.oauthClientId },
    ...(existing ? { reconnectConnectionId: existing.id } : {}),
  };
  context.log.change(`${existing ? "reconnect" : "create"} ${spec.name} (browser sign-in required)`);
  if (context.dryRun) return;
  const result = await context.api("POST", `/companies/${context.companyId}/tools/apps/connect`, body);
  const startUrl = result.auth?.startUrl;
  if (!startUrl) throw new Error(`No authorization URL returned for ${spec.name}`);
  if (context.open && process.platform === "darwin") spawnSync("open", [startUrl]);
  else console.log(`  open this URL to sign in:\n  ${startUrl}`);
  context.log.warn(`sign in, then re-run with --only mcp to finish ${spec.name}`);
}

async function restoreIfArchived(connection, context) {
  if (connection.status !== "archived") return;
  context.log.change(`restore archived connection ${connection.name}`);
  if (context.dryRun) return;
  await context.api("PATCH", `/tool-connections/${connection.id}`, { status: "active" });
  await context.api("PATCH", `/tool-applications/${connection.applicationId}`, { status: "active" });
}

async function hasActiveGrant(connection, context) {
  const response = await context.api("GET", `/tool-connections/${connection.id}/grants`);
  return (response.grants ?? response).some((grant) => grant.status === "active");
}

async function ensureSessionFlag(connection, spec, context) {
  if (connection.config?.mcpSessionRequired === spec.mcpSessionRequired) {
    context.log.ok(`${spec.name} mcpSessionRequired=${spec.mcpSessionRequired}`);
    return;
  }
  context.log.change(`set mcpSessionRequired=${spec.mcpSessionRequired} on ${spec.name}`);
  if (context.dryRun) return;
  const nextConfig = { ...connection.config, mcpSessionRequired: spec.mcpSessionRequired };
  await context.api("PATCH", `/tool-connections/${connection.id}`, { config: nextConfig, transportConfig: nextConfig });
}

async function effectiveAgentIds(connection, context) {
  const holders = [];
  for (const agent of context.agentsByName.values()) {
    const effective = await context.api("GET", `/companies/${context.companyId}/tools/profiles/effective/agents/${agent.id}`);
    const entries = effective.entries ?? [];
    if (entries.some((entry) => entry.connectionId === connection.id)) holders.push(agent.id);
  }
  return holders;
}

async function applyAgentAccess(connection, spec, context) {
  const targetIds = spec.agents.map((name) => {
    const agent = context.agentsByName.get(name);
    if (!agent) throw new Error(`Agent not found: ${name}`);
    return agent.id;
  });
  if (sameMembers(await effectiveAgentIds(connection, context), targetIds)) {
    context.log.ok(`${spec.name} already assigned to ${spec.agents.join(", ")} only`);
    return;
  }
  context.log.change(`assign ${spec.name} to ${spec.agents.join(", ")} (risks allowed: ${spec.allowedRisks.join(",")}; rest ask-first)`);
  if (context.dryRun) return;
  const { catalog } = await context.api("GET", `/tool-connections/${connection.id}/catalog`);
  const access = await context.api("GET", `/tool-connections/${connection.id}/test-agents/${targetIds[0]}/access`);
  const riskByName = new Map(access.access.tools.map((tool) => [tool.toolName, tool.risk]));
  const { enabled, askFirst } = partitionByRisk(
    catalog.map((entry) => ({ id: entry.id, risk: riskByName.get(entry.toolName) })),
    spec.allowedRisks,
  );
  await context.api("POST", `/companies/${context.companyId}/tools/apps/${connection.id}/finish`, {
    enabledCatalogEntryIds: enabled,
    askFirstCatalogEntryIds: askFirst,
    access: { agentIds: targetIds },
  });
  context.log.ok(`${enabled.length} tool(s) allowed, ${askFirst.length} ask-first`);
}

async function setupMcpConnections(config, context) {
  for (const spec of config.mcpConnections) {
    const existing = await findConnection(context, spec.name);
    if (!existing) {
      await startAuthorization(context, spec, null);
      continue;
    }
    await restoreIfArchived(existing, context);
    if (!context.dryRun && !(await hasActiveGrant(existing, context))) {
      await startAuthorization(context, spec, existing);
      continue;
    }
    const fresh = context.dryRun ? existing : await findConnection(context, spec.name);
    await ensureSessionFlag(fresh, spec, context);
    await applyAgentAccess(fresh, spec, context);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const config = JSON.parse(await fs.readFile(options.config, "utf8"));
  const log = createLogger(options.dryRun);
  const api = createApi(config.serverUrl);
  const context = { api, log, dryRun: options.dryRun, open: options.open };

  if (options.only.has("env")) {
    log.step("env");
    await ensureImportRootsEnv(config, context);
  }

  const needsServer = ["skills", "plugins", "mcp"].some((step) => options.only.has(step));
  if (!needsServer) return;

  const companies = await api("GET", "/companies");
  const company = companies.find((entry) => entry.issuePrefix === config.company.issuePrefix);
  if (!company) throw new Error(`No company with issue prefix ${config.company.issuePrefix}`);
  context.companyId = company.id;
  const agents = await api("GET", `/companies/${company.id}/agents`);
  context.agentsByName = new Map(agents.map((agent) => [agent.name, agent]));

  if (options.only.has("skills")) {
    log.step("skills");
    await importSkills(config, context);
  }
  if (options.only.has("plugins")) {
    log.step("plugins");
    await setupPlugins(config, context);
  }
  if (options.only.has("mcp")) {
    log.step("mcp");
    await setupMcpConnections(config, context);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nFAILED: ${error.message}`);
    process.exit(1);
  });
}
