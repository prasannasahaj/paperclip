import { describe, expect, it, vi } from "vitest";
import { DECISION_MODELS, DECISION_TEST_REQUEST } from "@paperclipai/shared";
import { decisionReceipt, runDecisionProvider } from "../services/decision-model-provider.js";
import { ollamaSystemOneUrl, runOllamaDecision } from "../services/decision-model-ollama.js";

const BASE_URL = "http://localhost:11434/v1";

function d3Response() {
  return {
    answers: {
      billing: { type: "noul", noul: 0.9955 },
      team: { type: "choice", choice: "billing", probabilities: { billing: 0.9994, technical: 0.0006 }, confidence: 0.9932 },
      severity: { type: "score", score: 0.0373, probabilities: { "0": 0.96, "1": 0.03, "2": 0.002 }, confidence: 0.85 },
    },
    usage: { input_tokens: 108, output_tokens: 0 },
  };
}

function run(transport: typeof fetch, overrides: { request?: typeof DECISION_TEST_REQUEST; signal?: AbortSignal } = {}) {
  return runOllamaDecision({
    model: DECISION_MODELS.ollama.id,
    baseUrl: BASE_URL,
    request: overrides.request ?? DECISION_TEST_REQUEST,
    signal: overrides.signal ?? new AbortController().signal,
  }, { fetch: transport });
}

describe("ollama decision runner", () => {
  it.each([
    "http://localhost:11434",
    "http://localhost:11434/",
    "http://localhost:11434/v1",
    "http://localhost:11434/v1/",
  ])("resolves %s to one systemone url", baseUrl => {
    expect(ollamaSystemOneUrl(baseUrl)).toBe("http://localhost:11434/v1/systemone");
  });

  it("maps DECISION_TEST_REQUEST to systemone questions and back", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(d3Response()));
    const result = await run(transport);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, options] = transport.mock.calls[0];
    expect(String(url)).toBe("http://localhost:11434/v1/systemone");
    expect(options?.method).toBe("POST");
    const body = JSON.parse(String(options?.body));
    expect(body.model).toBe("d3:9b");
    expect(body.state).toBe(DECISION_TEST_REQUEST.state);
    expect(body.questions.billing.type).toBe("noul");
    expect(typeof body.questions.billing.criteria.true).toBe("string");
    expect(typeof body.questions.billing.criteria.false).toBe("string");
    expect(body.questions.team).toMatchObject({ type: "choice", criteria: { billing: "Charges and payments", technical: "Product failures" } });
    expect(body.questions.severity).toMatchObject({ type: "score", criteria: ["Product works", "Some functionality is unavailable", "Product cannot be used"] });
    expect(result.errorCode).toBeUndefined();
    expect(result.answers).toEqual({
      billing: { type: "boolean", probability: 0.9955 },
      team: { type: "choice", choice: "billing", probabilities: { billing: 0.9994, technical: 0.0006 }, confidence: 0.9932 },
      severity: { type: "score", score: 0.0373, probabilities: { "0": 0.96, "1": 0.03, "2": 0.002 }, confidence: 0.85 },
    });
    expect(result.receipt).toMatchObject({
      inputTokens: 108, outputTokens: 0, costCents: "0.0000000", costStatus: "reported",
      pricingProvenance: { source: "rate_card", version: "local-zero-cost", inputCentsPerMillion: "0.0000000" },
    });
  });

  it("sends object state as JSON text", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(d3Response()));
    await run(transport, { request: { ...DECISION_TEST_REQUEST, state: { a: 1 } } });
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).state).toBe("{\"a\":1}");
  });

  it("sends no credential", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(d3Response()));
    await run(transport);
    expect(new Headers(transport.mock.calls[0][1]?.headers).get("authorization")).toBeNull();
  });

  it("fails closed without a hosted call", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    const result = await run(transport);
    expect(result.answers).toBeUndefined();
    expect(result.errorCode).toBe("provider_failed");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(String(transport.mock.calls[0][0])).toMatch(/^http:\/\/localhost:11434\//);
  });

  it("refuses to follow redirects so decision state never leaves the endpoint", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed: unexpected redirect"));
    const result = await run(transport);
    expect(result.errorCode).toBe("provider_failed");
    expect(result.answers).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1]?.redirect).toBe("error");
  });

  it("does not leak the response body", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("model PRIVATE not found", { status: 404 }));
    const result = await run(transport);
    expect(result.errorCode).toBe("provider_failed");
    expect(result.answers).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("rejects an invented choice", async () => {
    const wire = d3Response();
    wire.answers.team.choice = "invented";
    const result = await run(vi.fn<typeof fetch>().mockResolvedValue(Response.json(wire)));
    expect(result.answers).toBeUndefined();
    expect(result.errorCode).toBe("provider_failed");
  });

  it("rejects a probability outside zero to one", async () => {
    const wire = d3Response();
    wire.answers.billing.noul = 1.5;
    const result = await run(vi.fn<typeof fetch>().mockResolvedValue(Response.json(wire)));
    expect(result.answers).toBeUndefined();
    expect(result.errorCode).toBe("provider_failed");
  });

  it("accepts a score leaning to a later bucket", async () => {
    const wire = d3Response();
    wire.answers.severity.score = 1.9;
    const result = await run(vi.fn<typeof fetch>().mockResolvedValue(Response.json(wire)));
    expect(result.errorCode).toBeUndefined();
    expect(result.answers?.severity).toMatchObject({ type: "score", score: 1.9 });
  });

  it("rejects a score beyond the last criterion", async () => {
    const wire = d3Response();
    wire.answers.severity.score = 3;
    const result = await run(vi.fn<typeof fetch>().mockResolvedValue(Response.json(wire)));
    expect(result.answers).toBeUndefined();
    expect(result.errorCode).toBe("provider_failed");
  });

  it("rejects a response that omits a question", async () => {
    const wire = d3Response() as { answers: Record<string, unknown> };
    delete wire.answers.severity;
    const result = await run(vi.fn<typeof fetch>().mockResolvedValue(Response.json(wire)));
    expect(result.answers).toBeUndefined();
    expect(result.errorCode).toBe("provider_failed");
  });

  it("maps an aborted signal to timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("aborted", "AbortError"));
    const result = await run(transport, { signal: controller.signal });
    expect(result.errorCode).toBe("timeout");
    expect(result.answers).toBeUndefined();
  });
});

describe("ollama through the decision provider", () => {
  it("dispatches to the local endpoint and ignores the api key", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(d3Response()));
    const result = await runDecisionProvider({
      provider: "ollama", model: DECISION_MODELS.ollama.id, apiKey: "must-not-be-sent", baseUrl: BASE_URL,
      request: DECISION_TEST_REQUEST, signal: new AbortController().signal,
    }, { fetch: transport });
    expect(String(transport.mock.calls[0][0])).toBe("http://localhost:11434/v1/systemone");
    expect(new Headers(transport.mock.calls[0][1]?.headers).get("authorization")).toBeNull();
    expect(JSON.stringify(transport.mock.calls[0][1])).not.toContain("must-not-be-sent");
    expect(result.answers?.billing).toEqual({ type: "boolean", probability: 0.9955 });
  });

  it("fails closed when no base url is supplied", async () => {
    const transport = vi.fn<typeof fetch>();
    const result = await runDecisionProvider({
      provider: "ollama", model: DECISION_MODELS.ollama.id, apiKey: "", request: DECISION_TEST_REQUEST, signal: new AbortController().signal,
    }, { fetch: transport });
    expect(transport).not.toHaveBeenCalled();
    expect(result.errorCode).toBe("provider_failed");
    expect(result.answers).toBeUndefined();
  });

  it("reports a local zero-cost receipt even without a result", () => {
    const expected = {
      costCents: "0.0000000", costStatus: "reported",
      pricingProvenance: { source: "rate_card", version: "local-zero-cost", inputCentsPerMillion: "0.0000000" },
    };
    expect(decisionReceipt("ollama", null)).toMatchObject(expected);
    expect(decisionReceipt("ollama", { usage: { inputTokens: 5, outputTokens: 0 } })).toMatchObject({ ...expected, inputTokens: 5 });
  });
});
