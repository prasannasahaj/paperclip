# Talon onboarding

Re-creates the Talon setup on a fresh Paperclip instance: Atlas skills and the MCP gateways.

## Run it

```
node scripts/talon-onboarding.mjs --dry-run
node scripts/talon-onboarding.mjs
```

On an authenticated instance the script sends your board credential. Run `pnpm paperclipai auth login` once, or set `PAPERCLIP_API_KEY`. `PAPERCLIP_AUTH_STORE` overrides the credential file.

The script is idempotent. Re-run it after any change to `scripts/talon-onboarding.config.json`.

Order on a new machine:

1. Run once. The `env` step writes `PAPERCLIP_SKILL_IMPORT_ROOTS` into the instance `.env`. If it changed anything it says so.
2. Restart the Paperclip server. Env is read at startup.
3. Run again. Skills import and the MCP connection starts its browser sign-in.
4. Sign in with AWS SSO, then run `node scripts/talon-onboarding.mjs --only mcp` to finish access assignment.

Use `--only env,skills,mcp` to run single steps and `--no-open` to print the sign-in URL instead of opening a browser.

## What each step does

| Step | Effect |
| --- | --- |
| `env` | Adds the atlas marketplace clone to `PAPERCLIP_SKILL_IMPORT_ROOTS` so local skill imports from it pass the import boundary (`skill-import-roots.ts`). |
| `skills` | Imports atlas-core, atlas-design and `jira-story-groomer` as linked `local_path` skills. They follow `claude plugin marketplace update`. atlas-toolkit's `langfuse` and `prompt-engineer` are skipped because they duplicate atlas-core's. |
| `mcp` | Creates or reconnects `talon-mcp-gw-uk-nonprod` and `talon-mcp-gw-uk-prod` with their Cognito clients, sets `mcpSessionRequired`, and assigns only the configured agents, with only the configured risk levels allowed and the rest ask-first. |

## Config reference

`scripts/talon-onboarding.config.json`:

- `company.issuePrefix`: the company to configure.
- `skillImportRoots` and `skillSources`: marketplace paths, `~` expanded.
- `mcpConnections[]`: `name`, `url`, `oauthClientId`, `mcpSessionRequired`, `agents`, `allowedRisks`.

## Things to know

- `talon-mcp-gw-uk-nonprod` and `talon-mcp-gw-uk-prod` need `mcpSessionRequired: true`. Without it tool discovery returns HTTP 422.
- The Cognito client allows `http://localhost:3100/api/tools/oauth/callback` and the `127.0.0.1` variant. A Paperclip server on another port needs its callback added in `Plato2.0/infra/cluster` (`mcp_gateway_callback_urls`).
- Only the UK prod gateway is configured, read-only. US prod and US non-prod gateways are not configured.

## Not covered

- Lint and test before push. Those are `pre-commit` hooks in each repo's `.pre-commit-config.yaml` and are not installed in the clones. Set `provisionCommand: pre-commit install --install-hooks` on the project execution workspace to install them for agent worktrees.
