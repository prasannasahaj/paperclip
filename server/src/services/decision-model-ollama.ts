import { z } from "zod";
import type { DecisionAnswer, DecisionRequest } from "@paperclipai/shared";
import { decisionReceipt, type DecisionProviderOutcome } from "./decision-model-provider.js";

const MAX_RESPONSE_BYTES = 1_000_000;
const probability = z.number().min(0).max(1);
const probabilities = z.record(z.string(), probability);

const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities: probabilities.optional(), confidence: probability.optional() }),
  z.object({ type: z.literal("score"), score: z.number().min(0), probabilities: probabilities.optional(), confidence: probability.optional() }),
]);
const responseSchema = z.object({
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).optional(),
});
type OllamaAnswer = z.infer<typeof answerSchema>;

export function ollamaSystemOneUrl(baseUrl: string): string {
  const root = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${root}/v1/systemone`;
}

function stateText(state: DecisionRequest["state"]): string {
  return typeof state === "string" ? state : JSON.stringify(state);
}

function systemOneQuestion(question: DecisionRequest["questions"][string]) {
  if (question.type === "boolean") {
    return {
      type: "noul",
      criteria: {
        true: `Yes. ${question.instructions}`,
        false: `No. This is not the case for: ${question.instructions}`,
      },
    };
  }
  return { type: question.type, instructions: question.instructions, criteria: question.criteria };
}

function systemOneBody(model: string, request: DecisionRequest) {
  return {
    model,
    state: stateText(request.state),
    questions: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, systemOneQuestion(question)])),
  };
}

function decisionAnswer(question: DecisionRequest["questions"][string], answer: OllamaAnswer): DecisionAnswer | null {
  if (question.type === "boolean" && answer.type === "noul") return { type: "boolean", probability: answer.noul };
  if (question.type === "choice" && answer.type === "choice" && answer.choice in question.criteria) {
    const { type, choice, probabilities: odds, confidence } = answer;
    return { type, choice, ...(odds ? { probabilities: odds } : {}), ...(confidence !== undefined ? { confidence } : {}) };
  }
  if (question.type === "score" && answer.type === "score" && answer.score <= question.criteria.length - 1) {
    const { type, score, probabilities: odds, confidence } = answer;
    return { type, score, ...(odds ? { probabilities: odds } : {}), ...(confidence !== undefined ? { confidence } : {}) };
  }
  return null;
}

function decisionAnswers(request: DecisionRequest, answers: Record<string, OllamaAnswer>): Record<string, DecisionAnswer> | null {
  const mapped: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = answers[id];
    const converted = answer ? decisionAnswer(question, answer) : null;
    if (!converted) return null;
    mapped[id] = converted;
  }
  return mapped;
}

export async function runOllamaDecision(input: {
  model: string; baseUrl: string; request: DecisionRequest; signal: AbortSignal;
}, options: { fetch?: typeof fetch } = {}): Promise<DecisionProviderOutcome> {
  const transport = options.fetch ?? fetch;
  let receipt = decisionReceipt("ollama", null);
  const failed = (): DecisionProviderOutcome => ({ errorCode: input.signal.aborted ? "timeout" : "provider_failed", receipt });
  try {
    const response = await transport(ollamaSystemOneUrl(input.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(systemOneBody(input.model, input.request)),
      signal: input.signal,
      redirect: "error",
    });
    if (!response.ok) return failed();
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) return failed();
    const parsed = responseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return failed();
    receipt = decisionReceipt("ollama", { usage: { inputTokens: parsed.data.usage?.input_tokens, outputTokens: parsed.data.usage?.output_tokens } });
    const answers = decisionAnswers(input.request, parsed.data.answers);
    return answers ? { answers, receipt } : failed();
  } catch {
    return failed();
  }
}
