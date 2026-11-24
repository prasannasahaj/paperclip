import { describe, expect, it, vi } from "vitest";
import { DECISION_MODELS, DECISION_TEST_REQUEST, decisionBaseUrlForConnection, decisionProviderForConnection } from "@paperclipai/shared";
import { decisionReceipt, runDecisionProvider } from "../services/decision-model-provider.js";

function openaiResponse() {
  return { model: "gpt-6-luna", usage: { input_tokens: 123, output_tokens: 0 }, answers: [
    { type: "predicate", name: "billing", probability: 0.99 },
    { type: "choice", name: "team", choice: "billing", confidence: 0.9, probabilities: [{ value: "billing", probability: 0.9 }, { value: "technical", probability: 0.1 }] },
    { type: "score", name: "severity", score: 0.1, probabilities: [{ value: 0, probability: 0.9 }, { value: 1, probability: 0.1 }, { value: 2, probability: 0 }] },
  ] };
}
function openrouterResponse() {
  return { id: "decision-fixture", model: "typesafe/jev-1.13", usage: { input_tokens: 123, output_tokens: 0, cost: 0.000005166 }, answers: {
    billing: { type: "noul", noul: 0.99 }, team: { type: "choice", choice: "billing", confidence: 0.85, probabilities: { billing: 0.9, technical: 0.1 } },
    severity: { type: "score", score: 0.1, probabilities: { "0": 0.9, "1": 0.1, "2": 0 } },
  } };
}
function ollamaResponse() {
  return { model: "d3:9b", usage: { input_tokens: 327, output_tokens: 0 }, prompt_eval_cached_count: 0, answers: {
    billing: { type: "noul", noul: 0.99 },
    team: { type: "choice", choice: "billing", probabilities: { billing: 0.99, technical: 0.01 }, confidence: 0.99 },
    severity: { type: "score", score: 0.04, legend: { "0": "Product works", "1": "Some functionality is unavailable", "2": "Product cannot be used" }, probabilities: { "0": 0.96, "1": 0.03, "2": 0.01 }, confidence: 0.85 },
  } };
}
const ollamaInput = (baseUrl: string | null = "http://localhost:11434/v1") => ({
  provider: "ollama" as const, model: "d3:9b", apiKey: "", baseUrl, request: DECISION_TEST_REQUEST, signal: new AbortController().signal,
});
describe("decision provider contract", () => {
  it.each(["openai", "openrouter"] as const)("uses native %s decisions with the selected credential and preserves answers and fractional costs", async provider => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(provider === "openai" ? openaiResponse() : openrouterResponse()));
    const result = await runDecisionProvider({ provider, model: DECISION_MODELS[provider].id, apiKey: "selected-credential", request: DECISION_TEST_REQUEST, signal: new AbortController().signal }, { fetch: transport });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, options] = transport.mock.calls[0];
    expect(String(url)).toBe(provider === "openai" ? "https://api.openai.com/v1/decisions" : "https://openrouter.ai/api/alpha/decisions");
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer selected-credential");
    expect(new Headers(options?.headers).get("http-referer")).toBe(provider === "openrouter" ? "https://paperclip.ing" : null);
    expect(new Headers(options?.headers).get("x-openrouter-title")).toBe(provider === "openrouter" ? "Paperclip" : null);
    expect(result.answers).toMatchObject({ billing: { type: "boolean", probability: 0.99 }, team: { type: "choice", choice: "billing", confidence: provider === "openai" ? 0.9 : 0.85 }, severity: { type: "score", score: 0.1 } });
    expect(result.receipt.costCents).toBe(provider === "openai" ? "0.0012300" : "0.0005166");
    expect(JSON.stringify(result.receipt)).not.toContain("customer");
    expect(JSON.parse(String(options?.body)).model).toBe(DECISION_MODELS[provider].id);
  });
  it("sends D3 decisions to the connection's /v1/systemone without attribution headers", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(ollamaResponse()));
    const result = await runDecisionProvider(ollamaInput(), { fetch: transport });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, options] = transport.mock.calls[0];
    expect(String(url)).toBe("http://localhost:11434/v1/systemone");
    expect(new Headers(options?.headers).get("http-referer")).toBeNull();
    expect(new Headers(options?.headers).get("x-openrouter-title")).toBeNull();
    expect(JSON.parse(String(options?.body))).toMatchObject({ model: "d3:9b", questions: { billing: { type: "noul", instructions: "Is this a billing problem?" } } });
    expect(result.answers).toMatchObject({ billing: { type: "boolean", probability: 0.99 }, team: { choice: "billing", confidence: 0.99 }, severity: { score: 0.04, confidence: 0.85 } });
    expect(result.receipt).toMatchObject({ inputTokens: 327, outputTokens: 0, providerRequestId: null, costCents: "0.0000000", costStatus: "estimated",
      pricingProvenance: { source: "rate_card", version: "ollama-local-compute" } });
  });
  it.each([404, 500])("records a released zero-cost failure for D3 HTTP %i", async status => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "model 'd3:9b' not found" }, { status }));
    const result = await runDecisionProvider(ollamaInput(), { fetch: transport });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.errorCode).toBe("provider_failed"); expect(result.noProviderWork).toBe(true); expect(result.receipt.costStatus).toBe("estimated");
    expect(result.receipt.costCents).toBe("0.0000000");
  });
  it("records a released zero-cost failure when Ollama is unreachable", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    const result = await runDecisionProvider(ollamaInput(), { fetch: transport });
    expect(result.errorCode).toBe("provider_failed"); expect(result.noProviderWork).toBe(true); expect(result.receipt.costStatus).toBe("estimated");
    expect(result.receipt.costCents).toBe("0.0000000");
  });
  it("releases without calling Ollama when the connection has no base URL", async () => {
    const transport = vi.fn<typeof fetch>();
    const result = await runDecisionProvider(ollamaInput(null), { fetch: transport });
    expect(transport).not.toHaveBeenCalled();
    expect(result.errorCode).toBe("provider_failed"); expect(result.noProviderWork).toBe(true); expect(result.receipt.costStatus).toBe("estimated");
  });
  it("keeps usage for a charged refusal and never treats it as an answer", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...openaiResponse(), answers: [{ type: "refusal", name: null }] }));
    const result = await runDecisionProvider({ provider: "openai", model: "gpt-6-luna", apiKey: "key", request: DECISION_TEST_REQUEST, signal: new AbortController().signal }, { fetch: transport });
    expect(result.answers).toBeUndefined(); expect(result.errorCode).toBe("refused"); expect(result.receipt.inputTokens).toBe(123);
  });
  it.each([401, 429, 500])("does not retry HTTP %i or retain its response body", async status => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: "PRIVATE STATE AND KEY", type: "server_error" } }, { status }));
    const result = await runDecisionProvider({ provider: "openai", model: "gpt-6-luna", apiKey: "key", request: DECISION_TEST_REQUEST, signal: new AbortController().signal }, { fetch: transport });
    expect(transport).toHaveBeenCalledTimes(1); expect(result.receipt.costStatus).toBe(status === 500 ? "unpriced" : "estimated"); expect(result.noProviderWork).toBe(status !== 500); expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("preserves usage when answer validation fails", async () => {
    const response = openrouterResponse(); response.answers.team.choice = "invented";
    const result = await runDecisionProvider({ provider: "openrouter", model: "typesafe/jev-1.13", apiKey: "key", request: DECISION_TEST_REQUEST, signal: new AbortController().signal }, { fetch: async () => Response.json(response) });
    expect(result.answers).toBeUndefined(); expect(result.receipt.costStatus).toBe("reported");
  });
  it.each(["openai", "openrouter"] as const)("retains the %s receipt when the SDK rejects malformed wire answers", async provider => {
    const wire = provider === "openai" ? { ...openaiResponse(), answers: [{ type: "predicate", name: "billing", probability: 2 }] }
      : { ...openrouterResponse(), answers: { billing: { type: "noul", noul: "not-a-probability" } } };
    const result = await runDecisionProvider({ provider, model: DECISION_MODELS[provider].id, apiKey: "key", request: DECISION_TEST_REQUEST, signal: new AbortController().signal }, { fetch: async () => Response.json(wire) });
    expect(result.answers).toBeUndefined(); expect(result.receipt.inputTokens).toBe(123);
    expect(result.receipt.costStatus).toBe(provider === "openai" ? "estimated" : "reported");
  });
  it("fails closed on an OpenRouter refusal while retaining any reported charge", async () => {
    const result = await runDecisionProvider({ provider: "openrouter", model: DECISION_MODELS.openrouter.id, apiKey: "key", request: DECISION_TEST_REQUEST, signal: new AbortController().signal },
      { fetch: async () => Response.json({ ...openrouterResponse(), answers: { billing: { type: "refusal" } } }) });
    expect(result.answers).toBeUndefined(); expect(result.errorCode).toBe("refused"); expect(result.receipt.costStatus).toBe("reported");
  });
  it("does not invent prices when usage or a supported rate is missing", () => {
    expect(decisionReceipt("openai", {}).costCents).toBeNull();
    expect(decisionReceipt("openai", { usage: { inputTokens: 100_000 } }).costStatus).toBe("unpriced");
    expect(decisionReceipt("openrouter", { usage: { inputTokens: 1 } }).costCents).toBeNull();
    expect(decisionReceipt("openrouter", { providerMetadata: { openrouter: { usage: { cost: 0 } } } }).costStatus).toBe("reported");
  });
  it("rejects subscription, personal endpoint routing and other provider capabilities", () => {
    expect(decisionProviderForConnection({ provider: "openai", method: "subscription" })).toBeNull();
    expect(decisionProviderForConnection({ provider: "openai", method: "api_key", routing: { kind: "gateway", baseUrl: "https://example.com" } })).toBeNull();
    expect(decisionProviderForConnection({ provider: "anthropic", method: "api_key" })).toBeNull();
    expect(decisionProviderForConnection({ provider: "openrouter", method: "api_key", routing: { kind: "openrouter" } })).toBe("openrouter");
  });
  it("accepts only a keyless loopback local connection as Ollama decisions", () => {
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
  });
});
