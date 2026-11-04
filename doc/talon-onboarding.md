# Talon onboarding

Re-creates the Talon setup on a fresh Paperclip instance: Atlas skills, plugin hooks, and the non-prod MCP gateway.

## Run it

```
node scripts/talon-onboarding.mjs --dry-run
node scripts/talon-onboarding.mjs
```

The script is idempotent. Re-run it after any change to `scripts/talon-onboarding.config.json`.

Order on a new machine:

1. Run once. The `env` step writes `PAPERCLIP_SKILL_IMPORT_ROOTS` into the instance `.env`. If it changed anything it says so.
2. Restart the Paperclip server. Env is read at startup.
3. Run again. Skills import, plugins sync, and the MCP connection starts its browser sign-in.
4. Sign in with AWS SSO, then run `node scripts/talon-onboarding.mjs --only mcp` to finish access assignment.

Use `--only env,skills,plugins,mcp` to run single steps and `--no-open` to print the sign-in URL instead of opening a browser.

## What each step does

| Step | Effect |
| --- | --- |
| `env` | Adds the atlas marketplace clone to `PAPERCLIP_SKILL_IMPORT_ROOTS` so local skill imports from it pass the import boundary (`skill-import-roots.ts`). |
| `skills` | Imports atlas-core, atlas-design and `jira-story-groomer` as linked `local_path` skills. They follow `claude plugin marketplace update`. atlas-toolkit's `langfuse` and `prompt-engineer` are skipped because they duplicate atlas-core's. |
| `plugins` | Copies the installed atlas-core plugin into the company plugin store (`claude-plugin-sync.mjs`) and allow-lists it per agent. This is what delivers the plugin hooks (secret and credential scanning) to the agent. |
| `mcp` | Creates or reconnects `talon-mcp-gw-uk-nonprod` with the shared Cognito client, sets `mcpSessionRequired`, and assigns only the configured agents, with only the configured risk levels allowed and the rest ask-first. |

## Config reference

`scripts/talon-onboarding.config.json`:

- `company.issuePrefix`: the company to configure.
- `skillImportRoots` and `skillSources`: marketplace paths, `~` expanded.
- `plugins.sync`: plugin names copied from `plugins.claudeConfigDir`'s `installed_plugins.json`.
- `plugins.agentAllowList`: agent name to plugin names.
- `mcpConnections[]`: `name`, `url`, `oauthClientId`, `mcpSessionRequired`, `agents`, `allowedRisks`.

## Things to know

- The plugin hooks are a pinned snapshot of the installed plugin version. After `claude plugin update`, re-run the `plugins` step. Skills are linked and follow the marketplace clone, so skills and hooks can be on different versions until you do.
- The hooks fail closed. They need `trufflehog` and `jq` on the host running the agent.
- `talon-mcp-gw-uk-nonprod` needs `mcpSessionRequired: true`. Without it tool discovery returns HTTP 422.
- The Cognito client allows `http://localhost:3100/api/tools/oauth/callback` and the `127.0.0.1` variant. A Paperclip server on another port needs its callback added in `Plato2.0/infra/cluster` (`mcp_gateway_callback_urls`).
- Prod gateways are intentionally not configured.

## Not covered

- Lint and test before push. Those are `pre-commit` hooks in each repo's `.pre-commit-config.yaml` and are not installed in the clones. Set `provisionCommand: pre-commit install --install-hooks` on the project execution workspace to install them for agent worktrees.
- Subagents. The atlas plugins ship none.
