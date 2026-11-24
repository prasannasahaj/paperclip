# Company decision models

Decision model setup remains available in Company Settings → General when fast responses are off. Enabling **Experimental fast responses** in Company Settings → Experimental moves model setup to the Connections page. Company Settings → Connections → **Decision model** configures one shared API connection for optional Paperclip features. New companies remain unconfigured. A connection manager selects or adds an OpenAI, OpenRouter, or local Ollama connection, saves, and can run a small setup test that is billed for OpenAI and OpenRouter. Test answers appear only in that session; request metadata and charges appear under Activity → Costs → Decisions.

**Allow company-sponsored background decisions defaults on.** Saving authorizes internal background features to charge the selected connection without a responsible human. An explicit off setting survives later edits, including changing the connection or omitting the field from an update. Deleting the selected connection or grant preserves the setting and blocks calls until a valid replacement is selected. Disabling decisions prevents new calls. It does not cancel or erase calls already dispatched.

V1 supports native OpenAI Decisions (`gpt-6-luna`), OpenRouter Decisions (`typesafe/jev-1.13`), and Ollama (local) Decisions (`d3:9b`) through a keyless loopback connection. OpenAI and OpenRouter accept company-owned API keys only. Personal grants, subscription credentials, non-loopback custom endpoints, fallback chains, images, and public agent/plugin execution tools are outside this version. Decision compatibility is separate from CLI-adapter compatibility.

## Internal service

Register a feature once in its server module, then call `decisionModelService(db)` with trusted server context:

```ts
const classifyTask = defineDecisionFeature("tasks.classify");
const service = decisionModelService(db, { budgetHooks });
const context = { companyId, actor: req.actor, feature: classifyTask, issueId };
const available = await service.availability(context);
if (!available.available) return existingBehavior();
const result = await service.decide(context, {
  state: { title: task.title },
  questions: {
    billing: { type: "boolean", instructions: "Is this about billing?" },
    team: { type: "choice", instructions: "Which team should handle it?",
      criteria: { billing: "Payments", support: "Product support" } },
    urgency: { type: "score", instructions: "How urgent is it?",
      criteria: ["Routine", "Soon", "Immediately"] },
  },
});
```

The setup test is the only product caller in this release. Future callers must supply the existing budget enforcement hooks, handle unavailable/failure outcomes, and select their own thresholds. Boolean answers are probabilities, choice answers select a category, and scores use the ordered criteria's zero-based positions. Available distributions and provider confidence are preserved in returned answers. `succeeded` and `failed` results include an invocation ID and usage with reported, estimated, or unknown cost. Refusals and invalid responses never become invented answers.

`availability` reads local configuration and permissions only. It does not decrypt credentials, contact a provider, or promise reachability/budget admission. `availabilityForRequest()` returns a memoizing function; keep that function and its context object within one request. Dispatch never trusts this cached authorization.

Human calls use the authenticated user and retain the connection's audience checks. Agent calls reread the active persisted run and its current responsible user, check that user's current membership/resource access, and require an applicable agent/company connection installation. Task and project references must belong to that run/company. Attribution snapshots the effective identity at dispatch. Explicit internal system contexts additionally require a feature registered with `{ background: true }` and company sponsorship. A denied user/agent call cannot fall back to system context.

Credentials are resolved through the existing secret service immediately before admission, with the actual user/agent/system audit attribution. Keyless local connections have no credential, so nothing is resolved for them. Authorization, connection/configuration revisions, current run identity, and budgets are rechecked before dispatch. Requests allow 1–20 named questions, text/JSON state, and at most 32 KB serialized request data. Execution is limited to 30 seconds and SDK paid retries are disabled.

### Known limitation: local decision endpoints

When a company uses a local decision connection, the Paperclip server itself sends requests to that loopback endpoint. Anyone who can manage the company's connections can point such a connection at any localhost port, and the server then makes blind POSTs to that port. The feature is intended for `local_trusted`, single-machine use. It must be gated before hosted or multi-company use.

## Accounting and privacy

`decision_invocations` records feature, actor/responsible user, applicable task/project/agent/run and identity revision, connection/grant, provider/model, request ID, timing, status, question types/count, token counters, and a cost-ledger reference. It does not store state, question text, answers, or raw provider payloads. SDK input/output telemetry is disabled and provider errors are reduced to bounded codes. These are local database records, not first-party telemetry events.

Cost events have `usageKind: decision` and may have no agent. Agentless reporting uses **Paperclip services**. The public agent cost-reporting API still requires an agent; only the internal service receipt path accepts agentless charges. Decision events snapshot responsible-user attribution; historical run costs continue to use their existing attribution rules. Decision events have no heartbeat receipt reference, so run receipt reconciliation cannot count them again.

Paid admission and settlement use independent operation transactions. Admission keeps shared manual-control fences and best-effort budget observations; concurrent starts can exceed the same observed balance. Settlement does not acquire a company writer mutex. Company and applicable agent/project budgets include held reservations and observed spend. Reservations use the largest configured applicable reservation amount. Settlement is idempotent. Explicit provider authentication/validation/rate-limit rejection releases the hold when no model work occurred. Uncertain dispatches, timeouts, and unknown prices remain unpriced with the reservation held. Startup and deadline-driven accounting recovery marks stale invocations interrupted without resubmitting them. Late authoritative receipts can correct provisional interrupted accounting without another provider call. Use the existing audited cost adjustment workflow to resolve an otherwise unknown charge and release its hold, including a verified zero charge when appropriate.

OpenRouter-reported USD costs are converted to fractional cents. OpenAI uses a dedicated, versioned Decisions rate snapshot: $0.10 per million input tokens for the bounded short requests at the native default endpoint. No chat-model price is substituted. Local Ollama decisions are recorded as estimated zero-cost local compute (`ollama-local-compute`), including failed requests. Missing usage or an unsupported rate stays unknown; it is never displayed as a free request. The ledger retains seven decimal places in cents. Pricing provenance accompanies the cost event and remains available to accounting corrections.

History follows company cost visibility and rechecks task access before returning task/run links. It shows the latest 100 requests in the selected date window. Input/output contents remain absent after refresh.

## HTTP surface

All paths are under `/api/companies/:companyId/decision-model`:

| Method/path | Access and behavior |
| --- | --- |
| `GET /` | Board; returns manager capability and settings/compatible choices to connection managers |
| `PUT /` | Connection manager; validates and audits configuration |
| `GET /availability` | Authenticated company caller; local authorization check |
| `POST /test` | Connection manager; fixed server-owned three-question sample, ignoring client prompts/identity |
| `POST /triage` | Board user or agent in an active run; fixed server-owned task triage questions, confidence-gated decisions, shadow-logged |
| `GET /history` | Existing company cost-read rules; date bounds and limit up to 500 |

There is no general HTTP decision execution endpoint.

## Task triage

`POST /triage` runs the registered `tasks.triage` feature. Callers send `task` (up to 8,000 characters), optional `context` (up to 16,000), an optional `issueId` and their own `agentAnswers`. Optional fields add domain context without putting it in Core: `gatedAreas` (1–20 phrases that replace the default gated areas), `packChoices` (2–20 pack names with descriptions) and `chooseOwner` with optional `ownerCandidateIds` (2–20 agent ids). Unknown fields are rejected, so callers cannot supply questions or prompts.

The catalogue carries no company's domain. The server asks `work_type` (`investigation`, `data_analysis`, `product_discovery`, `requirements`, `implementation`, `review_and_testing`, `operations`, `communication`), `touches_gated_area` (whether the task changes or ships any gated area; reading or investigating one is not a yes), `size` (small, medium, large), `needs_split` (whether to split before anyone starts), `capability_tier` (routine, standard, hard), `pack` when `packChoices` is sent and `owner` when `chooseOwner` is true. The default gated areas are a schema or API contract change; merging, releasing or deploying code, or production configuration; a change to live data; an irreversible operation; authentication or permissions; and sending or publishing messages outside the team. `owner` choices are the company's agents that are not terminated, paused or pending approval, keyed by URL key and described as `title: capabilities`; the verdict and `agentAnswers.owner` are agent ids. `capability_tier` is a tier, never a model id: the caller maps it to its own model and effort.

A `succeeded` result returns `{ status, answers, verdicts, agreement, decisions }`. `verdicts` turns each answer into a comparable value: a boolean is true at probability 0.5 or more, a score is the nearest bucket (a fractional size score such as 1.93 means `large`), and a choice is the chosen key (an agent id for `owner`). `agreement` compares each verdict with the caller's answer.

`decisions` says per question whose answer to act on: `{ d3, confidence, use, reason, value }`. `value` is D3's verdict when `use` is `d3` and the caller's own answer (or `null`) when `use` is `agent`. Confidence is `max(p, 1 − p)` for a boolean and the provider's reported confidence for a choice or score (none reported means low confidence). The rules:

- `touches_gated_area` only escalates. A D3 yes at confidence 0.7 or more is used (`escalates_gate`) with no agreement record needed; a weaker yes goes to the caller (`low_confidence`), and a D3 no never relaxes the caller's call (`gate_never_relaxed`).
- Any other question goes to the caller when confidence is below 0.8 (`low_confidence`), when the company has fewer than 20 confident past answers with a recorded agreement among its last 100 triage entries (`insufficient_history`), or when those answers agreed with the caller less than 85% of the time (`low_agreement`). Otherwise D3's verdict is used (`confident_with_agreement_record`).

Agreement with the calling agent is the accuracy proxy, so the record only grows when callers send `agentAnswers`. An agent caller must send an answer for every question asked; otherwise the route returns 400 naming the missing ones, before D3 is called. Board users may omit them. Each `succeeded` call writes one `decision_model.triage_shadow` activity entry on the issue (or the company when no issue resolves) with D3's answers, the verdicts, the caller's answers, the agreement flags and each decision's confidence, use and reason. The entry never contains the task text or context. `unavailable` and `failed` results return HTTP 200 unchanged, and the caller continues on its own judgement.

## Provider dependencies and verification

The experimental Vercel contract is hidden behind Paperclip-owned types. Dependencies are pinned to `ai@7.0.130`, `@ai-sdk/openai@4.0.86`, and `@openrouter/ai-sdk-provider@3.1.0`. That OpenRouter release calls its compatible model factory `evaluationModel`; the wrapper adapts it to the current Decisions interface. Upgrade these together and rerun native wire-format tests. Ollama D3 reuses the OpenRouter evaluation model with the `/decisions` request path rewritten to `/systemone`; Ollama upgrades must rerun the provider contract tests.

CI owns lockfile updates. Before a direct Docker build of a feature checkout whose dependency manifests changed, refresh the local build context with `pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile`. Do not commit that generated lockfile; the hosted Docker workflow performs the same preparation and the lockfile bot updates master.

References: [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions), [Vercel AI SDK](https://ai-sdk.dev/docs/reference/ai-sdk-core/decide), [OpenRouter Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request).

Automated coverage lives in the provider contract and database-backed decision service tests. Provider tests use actual pinned SDK adapters with simulated HTTP responses; they do not establish live account/model availability. Storybook's **Decision models** group uses production components and includes settings states, metadata history, and a settings-to-history journey. A live acceptance check must run the fixed setup test with each authorized shared provider connection and inspect the corresponding persisted invocation/charge. Record live and simulated evidence separately.
