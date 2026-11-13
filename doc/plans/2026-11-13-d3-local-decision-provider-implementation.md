# D3 Local Decision Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A company can select a local Ollama connection as its Decision model, run D3 9B on it, and see the invocation in history and Costs, with no data leaving the machine.

**Architecture:** Add `ollama` as a third `DecisionProvider`. A loopback "local" AI connection (`routing.kind === "local"`, `auth === "none"`, `provider === "openai"`) maps to it. A direct `fetch` runner posts to Ollama's `/v1/systemone` and maps answers to `DecisionAnswer`. The decision service learns to run a connection that has no credential secret.

**Tech Stack:** TypeScript, zod, vitest, Drizzle (no schema change), React.

**Spec:** `doc/plans/2026-11-13-d3-local-decision-provider.md`

## Global Constraints

- Never author code comments (user rule); names carry the explanation. Leave existing comments alone.
- Model id is exactly `d3:9b`; display name `D3 9B`; provider key `ollama`.
- No migration: `company_decision_models.provider` and `model` are text columns.
- Keep `packages/shared`, `server` and `ui` in sync (AGENTS.md rule 2). Do not change the OpenAI and OpenRouter providers.
- No fallback to a hosted provider when Ollama fails. A failed call returns `status: "failed"`.
- Cost is recorded as `"0.0000000"` with status `reported`.
- One commit at the end (user preference), after the checks in Task 4 pass. Run `git status` before staging.
- Verification command: `pnpm verify` (AGENTS.md section 7). Do not run repo-wide checks unless it exits 2.

## Review Focus

- Ollama not running (connection refused) returns `failed` with `provider_failed`, never a hosted call. Pinned in Task 2.
- Model not pulled (HTTP 404 from Ollama) returns `failed` and leaks no response body. Pinned in Task 2.
- A `choice` answer outside the question's criteria keys, or a probability outside 0..1, is rejected. Pinned in Task 2.
- Object or array `state` is sent as JSON text, since D3 takes a string. Pinned in Task 2.
- Base URL given with or without a trailing `/v1`, or with a trailing slash, resolves to one `/v1/systemone` URL. Pinned in Task 2.

---

### Task 1: Shared provider mapping

**Files:**
- Modify: `packages/shared/src/decision-models.ts`
- Test: `server/src/__tests__/decision-model-provider.test.ts`

**Interfaces:**
- Produces: `DECISION_MODELS.ollama = { id: "d3:9b", name: "D3 9B" }`; `DecisionProvider` includes `"ollama"`; `decisionProviderForConnection(metadata: { provider: string; method: string; routing?: { kind: string; baseUrl?: string; auth?: string } }): DecisionProvider | null`.

- [ ] **Step 1: Write failing tests** in the existing `decisionProviderForConnection` block:
  - `{ provider: "openai", method: "api_key", routing: { kind: "local", baseUrl: "http://localhost:11434/v1", auth: "none" } }` → `"ollama"`.
  - the same with `auth: "bearer"` → `null`.
  - `routing: { kind: "gateway", baseUrl: "https://example.com", auth: "none" }` stays `null`.
  - `{ provider: "anthropic", method: "api_key", routing: { kind: "local", auth: "none" } }` → `null`.
- [ ] **Step 2:** Run `pnpm vitest run server/src/__tests__/decision-model-provider.test.ts`; expected FAIL on the first case.
- [ ] **Step 3:** Add the `ollama` entry and the local-route rule to `decisionProviderForConnection`; fix any exhaustiveness errors that `pnpm -F @paperclipai/shared typecheck` reports.
- [ ] **Step 4:** Re-run the test file; expected PASS.

### Task 2: Ollama runner and receipt

**Files:**
- Create: `server/src/services/decision-model-ollama.ts`
- Modify: `server/src/services/decision-model-provider.ts`
- Test: `server/src/__tests__/decision-model-ollama.test.ts`

**Interfaces:**
- Consumes: `DECISION_MODELS.ollama`, `DecisionRequest`, `DecisionProviderOutcome`.
- Produces:
  - `ollamaSystemOneUrl(baseUrl: string): string`
  - `runOllamaDecision(input: { model: string; baseUrl: string; request: DecisionRequest; signal: AbortSignal }, options?: { fetch?: typeof fetch }): Promise<DecisionProviderOutcome>`
  - `runDecisionProvider` input gains `baseUrl?: string` and dispatches `provider === "ollama"` to `runOllamaDecision`; `apiKey` is ignored for `ollama`.
  - `decisionReceipt("ollama", …)` returns `costCents: "0.0000000"`, `costStatus: "reported"`, `pricingProvenance: { source: "rate_card", version: "local-zero-cost", inputCentsPerMillion: "0.0000000" }`, for a null result as well.

- [ ] **Step 1: Write failing tests** with an injected `fetch` returning the verified `d3:9b` payloads:
  - `ollamaSystemOneUrl` maps `http://localhost:11434`, `http://localhost:11434/`, `http://localhost:11434/v1` and `http://localhost:11434/v1/` to `http://localhost:11434/v1/systemone`.
  - `maps DECISION_TEST_REQUEST to systemone questions and back`: the posted body has `model: "d3:9b"`, the boolean sent as `type: "noul"` with `criteria.true` and `criteria.false` strings, choice sent with its criteria object, score sent with its criteria array. For the response `{ answers: { billing: { type: "noul", noul: 0.9955 }, team: { type: "choice", choice: "billing", probabilities: { billing: 0.9994, technical: 0.0006 }, confidence: 0.9932 }, severity: { type: "score", score: 0.0373, probabilities: { "0": 0.96, "1": 0.03, "2": 0.002 }, confidence: 0.85 } }, usage: { input_tokens: 108, output_tokens: 0 } }` the answers are `billing: { type: "boolean", probability: 0.9955 }`, `team: { type: "choice", choice: "billing", probabilities, confidence: 0.9932 }`, `severity: { type: "score", score: 0.0373, probabilities, confidence: 0.85 }`, and the receipt is zero cost with `inputTokens: 108`.
  - `sends object state as JSON text`: request `state: { a: 1 }` posts `state: "{\"a\":1}"`.
  - `fails closed without a hosted call`: a fetch that throws `TypeError` → `errorCode: "provider_failed"`, `answers` undefined, `fetch` called once with a loopback URL only.
  - `does not leak the response body`: HTTP 404 with body containing `PRIVATE` → `errorCode: "provider_failed"` and `JSON.stringify(result)` lacks `PRIVATE`.
  - `rejects an invented choice`: `choice: "invented"` → no answers, `errorCode: "provider_failed"`; likewise a probability of `1.5`.
  - `maps an aborted signal to timeout`: aborted signal → `errorCode: "timeout"`.
- [ ] **Step 2:** Run `pnpm vitest run server/src/__tests__/decision-model-ollama.test.ts`; expected FAIL (module missing).
- [ ] **Step 3:** Implement `decision-model-ollama.ts`: build the request, validate the response with a zod schema, convert score probabilities to the `Record<string, number>` shape. Default boolean criteria are fixed sentences about the question (e.g. "The answer to the question is yes."); tune the wording until the Paperclip test sentence returns billing above 0.9.
- [ ] **Step 4:** Wire dispatch and the receipt branch in `decision-model-provider.ts`; keep the OpenAI and OpenRouter paths untouched.
- [ ] **Step 5:** Run this test file and `decision-model-provider.test.ts`; expected PASS for both.

### Task 3: Credentialless run in the decision service

**Files:**
- Modify: `server/src/services/decision-models.ts` (`decide`, around lines 228–266)
- Test: `server/src/__tests__/decision-models.test.ts`

**Interfaces:**
- Consumes: `runDecisionProvider` input `baseUrl`, `aiConnectionMetadataSchema`.
- Produces: `decide()` runs a connection whose `ai.routing.auth === "none"` without a `ai.credential` secret, passing `baseUrl` from `ai.routing.baseUrl` to `providerCall`; other connections behave as before.

- [ ] **Step 1: Write failing test** following the file's existing fixtures: `runs a decision on a credentialless local connection`. Create a shared connection with local routing (`http://localhost:11434/v1`, `auth: "none"`, no secret), configure and enable it, inject a `provider` stub, call `decide` with the settings test feature. Assert: `status: "succeeded"`, the stub received `provider: "ollama"`, `model: "d3:9b"`, `baseUrl: "http://localhost:11434/v1"`, history shows provider `ollama`, and the ledger records cost `0`.
- [ ] **Step 2:** Run it; expected FAIL with `unavailable / connection_unavailable`.
- [ ] **Step 3:** Add a small `usesCredential(connection)` helper in the service and use it at the three secret sites: the snapshot lookup, the admission comparison, and the share-lock re-read. Pass `baseUrl` into `providerCall`.
- [ ] **Step 4:** Run the whole `decision-models.test.ts`; expected PASS, including the existing revoked-secret tests.

### Task 4: UI, docs and live check

**Files:**
- Modify: `ui/src/components/decision-models/DecisionModelSettings.tsx`, `maps/feature-map/companies.md`
- Test: `ui/src/components/decision-models/DecisionModelSettings.test.tsx`

**Interfaces:**
- Consumes: `DECISION_MODELS.ollama`, `DecisionConnectionChoice`.
- Produces: the Add dialog lists "Ollama (local)" with `D3 9B`; its flow uses the existing local-endpoint connection setup; a saved choice reads "d3:9b · Connected · runs locally".

- [ ] **Step 1: Write failing tests:** a choice whose routing is local renders `d3:9b` and "runs locally"; the Add dialog offers an Ollama entry; `incompatible_connection` copy mentions a local Ollama connection.
- [ ] **Step 2:** Run `pnpm vitest run ui/src/components/decision-models/DecisionModelSettings.test.tsx`; expected FAIL.
- [ ] **Step 3:** Implement the labels, the dialog entry and the copy. Confirm the setup flow accepts a local endpoint for this entry (`serviceSlug` for local routing, `aiConnection` provider `openai`); if it does not, report it instead of widening the flow.
- [ ] **Step 4:** Update the `company-ai-services` section of `maps/feature-map/companies.md`, then run `node scripts/check-maps.mjs`.
- [ ] **Step 5:** Run `pnpm verify`; expected exit 0 (exit 2 means run focused checks and report the gap).
- [ ] **Step 6: Live check** with Ollama running `d3:9b`: in Settings → Connections add a local endpoint `http://localhost:11434/v1`, select it under Decision model, enable, press Test. Expected: "Decision model is working", billing near 99%, team `billing`, a row in Costs → Decisions with provider `ollama` and zero cost. Stop Ollama and press Test again; expected a failure message, not a success.
- [ ] **Step 7:** `git status`, then one commit of the code, tests, docs and both plan files.
