# D3 (local Ollama) Decision Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a company choose a loopback Ollama connection serving `d3:9b` as its decision model. The existing `decisionModelService.decide()` and the settings test then run on local D3, with zero-cost accounting.

**Architecture:**
- D3's `POST /v1/systemone` speaks the TypeSafe/OpenRouter Decisions wire format. Questions are a map using `noul`/`choice`/`score` with `instructions` and `criteria`, and answers come back as a map with `confidence`.
- We therefore reuse `@openrouter/ai-sdk-provider`'s `evaluationModel`, with `decisionsBaseURL` set to the connection's base URL and a fetch wrapper that rewrites the trailing `/decisions` to `/systemone`.
- A keyless (`auth: "none"`) local connection skips the credential-secret path.
- Local compute is recorded as an `estimated` 0-cent cost, so budget reservations always settle or release and never stay held.

**Tech Stack:** TypeScript, zod, Drizzle, Vitest, AI SDK `ai@7.0.130` (`experimental_decide`), `@openrouter/ai-sdk-provider@3.1.0`, React (UI).

**Spec:** `/Users/prasannaa/.claude-talon/plans/we-need-to-bring-lucky-fountain.md`, Layer 0. Read the "Devil's advocate" and "Working agreement" sections before starting.

**Evidence already gathered (2026-11-24, Ollama 0.40.16, `d3:9b`):**
- `DECISION_TEST_REQUEST` sent to `http://localhost:11434/v1/systemone` with `instructions` fields returned `billing` noul 0.99, `team` = billing (confidence 0.99), and `severity` score 0.04 (confidence 0.85). It also returned `usage.input_tokens` 327, output 0, and no `id`.
- A spike through `createOpenRouter({ decisionsBaseURL: "http://localhost:11434/v1", fetch: rewrite }).evaluationModel("d3:9b")` with `experimental_decide` returned mapped answers. Confidence came back under `providerMetadata.openrouter.answers[id].confidence`.
- A wrong model returns HTTP 404 `{"error":"model 'nope' not found"}`.

**Planner's calls that differ from the spec (all confirmed by Prasanna on 2026-11-24):**
- **The model id is fixed at `d3:9b`, not configurable.** Paperclip runs on a Mac M5 Pro, and `d3:9b` is the only decision model that runs on that machine.
- **A missing request id stays `null`, rather than a generated id.** The column is already nullable, and a made-up id would be presented as provider evidence.
- **The OpenRouter SDK is reused with a path rewrite, instead of a hand-written adapter.** The spike shows it works. The risk is that the SDK's path changes, and the Task 2 URL assertion catches that.

## Global Constraints

- **Branch:** work directly on `development` (Prasanna's instruction). Never stage `packages/adapters/claude-local/src/server/setup-token-parse*.ts`. Those are unrelated local edits.
- **No new code comments** (user rule). Leave existing comments alone.
- **Commits:** commit each task locally on `development`. Squash the local task commits into one commit before pushing. Each commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Provider and model:** the provider key is `ollama`, and the model id is fixed at `d3:9b`. Display names are `"Ollama (local)"` for the provider and `"D3"` for the model.
- **Qualifying connection:** only one shape qualifies as `ollama`. Metadata must be `provider: "openai"` and `method: "api_key"`, with `routing.kind: "local"`, `routing.auth: "none"`, and `routing.baseUrl` present.
  - Any other local or gateway connection stays incompatible.
  - The loopback-only rule in `packages/shared/src/ai-provider-routing.ts:54-75` is unchanged.
- **Prompt-injection prevention:** keep it accepting `openrouter` only (`server/src/services/ai-connections.ts:533`, `server/src/services/prompt-injection-prevention.ts:65`).
- **Never send OpenRouter attribution headers to Ollama.**
- **Pricing provenance for `ollama`:**
  - `{ source: "rate_card", version: "ollama-local-compute", inputCentsPerMillion: "0.0000000" }`
  - `costCents: "0.0000000"`, `costStatus: "estimated"`, also on failures.
- **Cost-event fields for `ollama` invocations:** `provider: "ollama"`, `biller: "ollama"`, `billingType: "fixed"`.
- **Verification:** the final gate is `pnpm verify`. Don't run repo-wide typecheck, test or build unless `pnpm verify` exits 2 and a focused check can't close the gap (AGENTS.md §7).
- **Working agreement:** if code contradicts this plan, stop and ask Prasanna with a recommended answer. Don't work around it.

## Review Focus

1. **Ollama not running (connection refused).** The decision returns `failed` with `provider_failed`. The reservation is released, not left `held`, and a 0-cent estimated cost event is recorded. Pinned in Task 2 and Task 3.
2. **D3 not pulled (404 model not found).** Returns `failed`, and the reservation is released. Pinned in Task 2.
3. **The wrong local endpoint shape.** A `local` connection with `auth: "bearer"`, or a `gateway` connection with `auth: "none"`, must not be offered or accepted as a decision connection. Pinned in Task 1.
4. **A keyless Ollama connection is picked for prompt-injection prevention.** It must be rejected. Pinned in Task 1.
5. **Ollama returns no `id`.** `providerRequestId` is `null` and nothing throws. Pinned in Task 2.

---

### Task 1: Shared decision contract recognises a keyless local Ollama connection

**Files:**
- Modify: `packages/shared/src/decision-models.ts:4-8`, `:67-73`
- Test: `server/src/__tests__/decision-model-provider.test.ts`. Extend the existing `"rejects subscription, personal endpoint routing and other provider capabilities"` block, or add a sibling `it`.

**Interfaces:**
- Produces:
  - `DECISION_MODELS.ollama = { id: "d3:9b", name: "D3" }`, and therefore `DecisionProvider = "openai" | "openrouter" | "ollama"`.
  - `decisionProviderForConnection(metadata: { provider: string; method: string; routing?: { kind: string; baseUrl?: string; auth?: string } }): DecisionProvider | null`
  - `decisionBaseUrlForConnection(metadata: { routing?: { kind: string; baseUrl?: string; auth?: string } }): string | null` returns the trailing-slash-trimmed `baseUrl` for the `ollama` shape, and `null` otherwise.

- [ ] **Step 1: Write the failing test** `it("accepts only a keyless loopback local connection as Ollama decisions")`.

```ts
const local = { provider: "openai", method: "api_key", routing: { kind: "local", protocol: "chat", auth: "none", baseUrl: "http://localhost:11434/v1/" } };
expect(decisionProviderForConnection(local)).toBe("ollama");
expect(decisionBaseUrlForConnection(local)).toBe("http://localhost:11434/v1");
expect(decisionProviderForConnection({ ...local, routing: { ...local.routing, auth: "bearer" } })).toBeNull();
expect(decisionProviderForConnection({ ...local, routing: { ...local.routing, kind: "gateway" } })).toBeNull();
expect(decisionProviderForConnection({ ...local, provider: "anthropic" })).toBeNull();
expect(decisionProviderForConnection({ ...local, routing: { ...local.routing, baseUrl: undefined } })).toBeNull();
expect(decisionProviderForConnection({ provider: "openai", method: "api_key" })).toBe("openai");
expect(decisionBaseUrlForConnection({ provider: "openai", method: "api_key" })).toBeNull();
expect(DECISION_MODELS.ollama.id).toBe("d3:9b");
```

- [ ] **Step 2: Run the test and confirm it fails.**
  - Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/decision-model-provider.test.ts`
  - Expected: FAIL. `decisionBaseUrlForConnection` is not exported, or the first assertion receives `null`.

- [ ] **Step 3: Implement both functions and the `DECISION_MODELS.ollama` entry** in `packages/shared/src/decision-models.ts`.
  - Export `decisionBaseUrlForConnection` from the shared package index, following how `decisionProviderForConnection` is exported.
  - Keep the existing `openai` and `openrouter` branches unchanged.

- [ ] **Step 4: Run the same command and confirm it passes.** Then run `grep -rn "DECISION_MODELS\[" server/src ui/src` and confirm every indexed use still typechecks.
  - Run: `pnpm --filter @paperclipai/shared exec tsc --noEmit`
  - Expected: no errors. The UI's `id === "openai" ? … : "OpenRouter"` ternary compiles but is wrong for `ollama`. Task 4 fixes it.

- [ ] **Step 5: Pin Review Focus 4 by asserting that prompt-injection selection rejects the Ollama shape.**
  - Add `it("never offers a keyless local connection for prompt injection checks")` to the existing prompt-injection test file (find it with `grep -ln "selectPromptInjectionPrevention\|prompt-injection" server/src/__tests__`).
  - Follow that file's connection-fixture pattern. Save the `local` shape as a shared organization connection, then:
    - expect `selectPromptInjectionPrevention` to reject with code `incompatible_connection`;
    - expect the prompt-injection `choices` list to exclude it.
  - Run it and expect a PASS with no code change, because `=== "openrouter"` already guards both.

- [ ] **Step 6: Commit** with the message `feat(decision-models): recognise keyless local Ollama connections`.

---

### Task 2: Provider runs D3 through the OpenRouter decisions model with a `/systemone` rewrite

**Files:**
- Modify: `server/src/services/decision-model-provider.ts:26-48`, `:62-67`, `:77-91`
- Test: `server/src/__tests__/decision-model-provider.test.ts`

**Interfaces:**
- Consumes: `DecisionProvider` including `"ollama"` (from Task 1).
- Produces:
  - `runDecisionProvider(input: { provider: DecisionProvider; model: string; apiKey: string; baseUrl?: string | null; request: DecisionRequest; signal: AbortSignal }, options?: { fetch?: typeof fetch }): Promise<DecisionProviderOutcome>`
  - `decisionReceipt("ollama", result)` always returns `costCents "0.0000000"` and `costStatus "estimated"` with the Global Constraints provenance.

- [ ] **Step 1: Write the failing tests.** Add an `ollamaResponse()` fixture copied from the captured D3 output.

```ts
function ollamaResponse() {
  return { model: "d3:9b", usage: { input_tokens: 327, output_tokens: 0 }, prompt_eval_cached_count: 0, answers: {
    billing: { type: "noul", noul: 0.99 },
    team: { type: "choice", choice: "billing", probabilities: { billing: 0.99, technical: 0.01 }, confidence: 0.99 },
    severity: { type: "score", score: 0.04, legend: { "0": "Product works", "1": "Some functionality is unavailable", "2": "Product cannot be used" }, probabilities: { "0": 0.96, "1": 0.03, "2": 0.01 }, confidence: 0.85 },
  } };
}
```

  - `it("sends D3 decisions to the connection's /v1/systemone without attribution headers")`:
    - `runDecisionProvider({ provider: "ollama", model: "d3:9b", apiKey: "", baseUrl: "http://localhost:11434/v1", request: DECISION_TEST_REQUEST, signal }, { fetch: transport })`
    - Expect `String(url)` to be `"http://localhost:11434/v1/systemone"`.
    - Expect `http-referer` and `x-openrouter-title` to be `null`.
    - Expect `JSON.parse(body)` to match `{ model: "d3:9b", questions: { billing: { type: "noul", instructions: "Is this a billing problem?" } } }`.
    - Expect `result.answers` to match `{ billing: { type: "boolean", probability: 0.99 }, team: { choice: "billing", confidence: 0.99 }, severity: { score: 0.04, confidence: 0.85 } }`.
    - Expect `result.receipt` to match `{ inputTokens: 327, outputTokens: 0, providerRequestId: null, costCents: "0.0000000", costStatus: "estimated", pricingProvenance: { source: "rate_card", version: "ollama-local-compute" } }`.
  - `it.each([404, 500])("records a released zero-cost failure for D3 HTTP %i")`:
    - Expect `errorCode` to be `"provider_failed"`, `noProviderWork` to be `true`, and `receipt.costStatus` to be `"estimated"`.
  - `it("records a released zero-cost failure when Ollama is unreachable")`:
    - The transport rejects with `new TypeError("fetch failed")`.
    - Expect the same result as the 404/500 case.

- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/decision-model-provider.test.ts`
  - Expected: FAIL. The URL is wrong, or an `ollama` branch is missing.

- [ ] **Step 3: Implement the changes.**
  - **Model construction:** for `ollama`, use `createOpenRouter({ apiKey: "ollama", decisionsBaseURL: input.baseUrl!, fetch: (url, init) => (options.fetch ?? fetch)(String(url).replace(/\/decisions$/, "/systemone"), init) }).evaluationModel(input.model)`.
    - Pass no `headers`.
    - If `baseUrl` is missing, return `{ errorCode: "provider_failed", noProviderWork: true, receipt }` without calling fetch.
  - **Confidence:** read it from `metadata.openrouter.answers[id].confidence` for both `openrouter` and `ollama`.
  - **`decisionReceipt`:** add an early `ollama` branch for the zero-cost receipt.
  - **Catch path:** for `ollama`, always set `noProviderWork: true` and keep the zero-cost estimated receipt. A local failure can't produce an unknown charge.

- [ ] **Step 4: Run the same command and confirm it passes.** Existing `openai` and `openrouter` cases must still pass.

- [ ] **Step 5: Commit** with the message `feat(decision-models): run D3 decisions through the local systemone endpoint`.

---

### Task 3: The decision service and connection selection support the keyless D3 path end to end

**Files:**
- Modify:
  - `server/src/services/ai-connections.ts:419-451` (`selectDecision`)
  - `server/src/services/decision-models.ts:69`, `:81`, `:136`, `:206-207`, `:228-235`, `:256`, `:263-266`, `:292-294`
- Test: `server/src/__tests__/decision-models.test.ts`. Use the existing database-backed fixtures and the injected `provider` option of `decisionModelService`.

**Interfaces:**
- Consumes:
  - `decisionProviderForConnection` and `decisionBaseUrlForConnection` (Task 1)
  - `runDecisionProvider({ …, baseUrl })` (Task 2)
- Produces: `selectDecision(...)` returns `{ connection, grant, provider: DecisionProvider, keyless: boolean, baseUrl: string | null }`, where `keyless` is `metadata.routing?.auth === "none"`.

- [ ] **Step 1: Write the failing test** `it("runs a background decision on a keyless local D3 connection and settles it at zero cost")`.
  - **Setup:**
    - Save a shared organization AI connection with `{ provider: "openai", method: "api_key", ownership: "shared", allAgents: true, routing: { kind: "local", protocol: "chat", auth: "none", baseUrl: "http://localhost:11434/v1", models: [] } }` and api key `""`. Follow the no-auth save pattern in `server/src/__tests__/ai-connections.test.ts:1707-1716`.
    - `configure(companyId, userId, { enabled: true, connectionId, grantId })`.
  - **Assert:**
    - `settings(companyId)` matches `{ provider: "ollama", model: "d3:9b" }`.
    - `choices(companyId, userId)` contains the connection with `decisionModel: "d3:9b"`.
    - With an injected `provider` spy returning `{ answers: { billing: { type: "boolean", probability: 0.99 } }, receipt: decisionReceipt("ollama", { usage: { inputTokens: 10, outputTokens: 0 } }) }`, a `decide({ companyId, actor: { type: "system" }, feature: <a test feature defined with { background: true }> }, DECISION_TEST_REQUEST)`:
      - returns `status: "succeeded"`;
      - leaves the spy called once with `{ provider: "ollama", model: "d3:9b", apiKey: "", baseUrl: "http://localhost:11434/v1" }`.
    - The cost event matches `{ provider: "ollama", biller: "ollama", billingType: "fixed", costStatus: "estimated", costCents: "0.0000000" }`.
    - The invocation's budget reservation `state` is `"settled"`.
  - **Second test,** `it("releases the reservation when local D3 fails")`:
    - The spy returns `{ errorCode: "provider_failed", noProviderWork: true, receipt: decisionReceipt("ollama", null) }`.
    - Expect `status: "failed"`, and the reservation `state` to be `"released"`.

- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/decision-models.test.ts -t "local D3"`
  - Expected: FAIL with `connection_unavailable`. That's the secret check at `decision-models.ts:231`.

- [ ] **Step 3: Implement the changes.**
  - **`selectDecision`:** return `keyless` and `baseUrl`.
  - **`decide`, when `selected.connection.keyless`:**
    - Skip the secret snapshot and credential acquisition, and use `credential = ""`.
    - In admission, skip the secret-id comparison (`:256`) and the secret recheck (`:263-266`).
    - Every other recheck stays.
  - **Provider call:** pass `baseUrl: selected.connection.baseUrl`.
  - **Cost event:** `provider` is `typesafe` for `openrouter` and otherwise `invocation.provider`. `billingType` is `"fixed"` for `ollama` and `"metered_api"` otherwise.

- [ ] **Step 4: Run the tests and confirm they pass.** Then run the whole file and `ai-connections.test.ts` to confirm no regressions.
  - Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/decision-models.test.ts src/__tests__/ai-connections.test.ts src/__tests__/decision-model-provider.test.ts`
  - Expected: all PASS.

- [ ] **Step 5: Commit** with the message `feat(decision-models): admit keyless local D3 connections with zero-cost settlement`.

---

### Task 4: Settings UI offers Ollama (local) as a decision provider

**Files:**
- Modify: `ui/src/components/decision-models/DecisionModelSettings.tsx:113-129`
- Test: `ui/src/components/decision-models/DecisionModelSettings.test.tsx`

**Interfaces:**
- Consumes: `DECISION_MODELS.ollama` (Task 1).
- Produces: none.

- [ ] **Step 1: Write the failing test** `it("offers Ollama (local) with D3 and opens the local connection setup")`.
  - Open the add dialog.
  - Expect three provider choices: `OpenAI`, `OpenRouter`, and `Ollama (local)`, described as `D3`.
  - After selecting `Ollama (local)`, expect the setup flow to render with `serviceSlug "local"` and `aiConnection { provider: "openai", method: "api_key", mode: "shared" }`. Use the existing test's mock or spy pattern for `ConnectionSetupFlow`.

- [ ] **Step 2: Run the test and confirm it fails.**
  - Run: `pnpm --filter @paperclipai/ui exec vitest run src/components/decision-models/DecisionModelSettings.test.tsx`
  - Expected: FAIL, because `Ollama (local)` isn't found.

- [ ] **Step 3: Implement the UI change.**
  - Replace the two-way ternaries with a `DECISION_PROVIDER_PRESENTATION: Record<DecisionProvider, { name: string; brandKey: string; serviceSlug: string; aiProvider: "openai" | "openrouter" }>` constant in this file.
    - `ollama` maps to `{ name: "Ollama (local)", brandKey: "ollama", serviceSlug: "local", aiProvider: "openai" }`.
  - Use it for the list and for `ConnectionSetupFlow`'s `serviceSlug` and `aiConnection.provider`.
  - Follow `DESIGN.md`: tokens only, no new styles.

- [ ] **Step 4: Run the same command and confirm it passes.**

- [ ] **Step 5: Commit** with the message `feat(ui): offer local Ollama D3 as a decision model`.

---

### Task 5: Docs and a live acceptance check against local D3

**Files:**
- Modify: `doc/decision-models.md`:
  - Line 7: supported providers. Add "Ollama (local) Decisions (`d3:9b`) through a keyless loopback connection". Narrow "custom endpoints … outside this version" to non-loopback endpoints.
  - Line 47: pricing. Add "Local Ollama decisions are recorded as estimated zero-cost local compute (`ollama-local-compute`)".
  - Line 67: dependencies. Note the `/decisions`→`/systemone` rewrite on the OpenRouter evaluation model, and that Ollama upgrades must rerun the provider contract tests.

**Interfaces:** none.

- [ ] **Step 1: Update the doc.** This is plain prose, with no new sections beyond those three edits.

- [ ] **Step 2: Live acceptance.** Record live and simulated evidence separately, per `doc/decision-models.md:73`.
  1. Confirm D3 is up: `ollama list | grep d3:9b`.
  2. Start the app: `node scripts/agent-preflight.mjs && pnpm dev`.
  3. In the UI:
     - Go to Company Settings → Connections (or General) → Decision model → Add, and pick **Ollama (local)**.
     - Enter base URL `http://localhost:11434/v1` with no auth. Make it shared, then save and enable it.
  4. Click **Test**. Expected: billing ≈ 0.99 yes, team `billing`, severity at the lowest level.
  5. Check Activity → Costs → Decisions. Expected: one `settings.test` row with provider `ollama`, model `d3:9b`, status `succeeded`, and cost $0.00 (estimated).
  6. Stop Ollama with `brew services stop ollama`, or quit the app, and click **Test** again.
     - Expected: a clear failure message, and a `failed` history row with no held reservation.
     - Restart Ollama afterwards.

- [ ] **Step 3: Run `pnpm verify`.**
  - Expected: exit 0. If it exits 2, run the focused files from Tasks 1–4 and report the gap. Don't automatically run `--full`.

- [ ] **Step 4: Commit** with the message `docs(decision-models): document local Ollama D3 decisions`. Then squash this plan's local commits on `development` into one commit, and put the live evidence from Step 2 in its message. Pushing and opening a PR are the controller's job. Leave them to the controller.
