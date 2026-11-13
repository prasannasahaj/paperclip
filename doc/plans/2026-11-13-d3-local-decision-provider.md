# D3 as a local Decision model provider

## Intent

Data privacy forbids sending Atlas issue text to a hosted decision model, so the Decision model setting needs a provider that runs on the operator's machine. Ollama's D3 (`d3:9b`, vLLM Semantic Router, Apache 2.0) is the chosen model. Its Jev Decision Index score (0.3.1 text board) is 59.0 against 60.1 for hosted Jev, and it loads in about 10 GB.

## Goals

- A company can select a local Ollama connection under Settings → Connections → Decision model, run Test, and see the invocation in history and Costs.
- Decisions on this provider never leave the machine.

## Non-goals

- No feature calls decisions yet. Owner routing for new issues is a separate follow-up.
- No new connection type. Local loopback connections already exist.
- No change to the OpenAI and OpenRouter providers.

## Anti-goals

- A silent fallback to a hosted provider when Ollama is unreachable.
- Recording token prices for a local model.

## Constraints

- D3 requires Ollama 0.40.9 or later; verified on 0.40.16.
- D3 packages use a 4,096-token context, so the request must stay small.
- `company_decision_models.provider` and `model` are text columns, so no migration is needed.
- Contracts stay synchronized across `packages/shared`, `server` and `ui` (AGENTS.md rule 2).

## Approaches

1. **Reuse the existing local connection kind and add a custom decision model (chosen).** `routing.kind === "local"` already carries a loopback `baseUrl` with no credential. Accept it in `decisionProviderForConnection` as provider `ollama`, and call `/v1/systemone` through a small `doDecide` model.
2. A new Ollama connection type. More UI and storage for no extra capability.
3. Point the OpenAI provider at Ollama's OpenAI-compatible route. D3 is not served there; it only answers `/v1/systemone`.

## Design

- `DECISION_MODELS` gains `ollama: { id: "d3:9b", name: "D3 9B" }`.
- `decisionProviderForConnection` returns `ollama` for an OpenAI-protocol connection whose routing is `local`. Other routed connections stay rejected.
- The provider builds a `doDecide` model that posts to `<baseUrl>/systemone` and maps the answers.
- Answer mapping, verified against `d3:9b` on 2026-11-13:
  - `choice` and `score` pass through (`choice`, `score`, `probabilities`, `confidence`).
  - `boolean` becomes D3's `noul` question; the returned probability is the `true` probability.
- D3 requires `true` and `false` criteria that a Paperclip boolean question does not carry. The mapper supplies fixed defaults derived from the question instructions.
- Receipts record zero cost with status `reported` and a `local` pricing source.
- The UI choice list shows D3 9B with a "runs locally" description, and the empty state mentions a local Ollama connection.

## Left to the builder

- The exact default `true` and `false` criteria wording; tune it against the test request.
- Error mapping when Ollama is down or the model is missing (`provider_failed` versus a new reason).
- Timeout value; latency has not been measured.
