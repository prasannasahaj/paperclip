import { z } from "zod";
import type { AiManagedConnectionSummary } from "./ai-connections.js";

export const DECISION_MODELS = {
  openai: { id: "gpt-6-luna", name: "GPT-6 Luna" },
  openrouter: { id: "typesafe/jev-1.13", name: "Jev 1.13" },
  ollama: { id: "d3:9b", name: "D3" },
} as const;
export type DecisionProvider = keyof typeof DECISION_MODELS;
export const updateDecisionModelSchema = z.object({
  enabled: z.boolean(),
  connectionId: z.string().uuid().nullable(),
  grantId: z.string().uuid().nullable(),
  allowBackground: z.boolean().optional(),
}).refine(v => Boolean(v.connectionId) === Boolean(v.grantId) && (!v.enabled || Boolean(v.connectionId)), {
  message: "Select a connection before enabling decisions",
});
export type UpdateDecisionModel = z.infer<typeof updateDecisionModelSchema>;
export interface DecisionModelSettings extends UpdateDecisionModel {
  allowBackground: boolean;
  companyId: string;
  provider: DecisionProvider | null;
  model: string | null;
}
export type DecisionConnectionChoice = AiManagedConnectionSummary & { decisionModel: string };
export type DecisionUnavailableReason = "not_configured" | "disabled" | "connection_unavailable" | "incompatible_connection" | "access_denied" | "responsible_user_missing" | "background_disabled" | "budget_blocked";
export type DecisionAvailability = { available: true } | { available: false; reason: DecisionUnavailableReason };
const instructions = z.string().trim().min(1).max(8000);
export const decisionQuestionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("boolean"), instructions }),
  z.object({ type: z.literal("choice"), instructions, criteria: z.record(z.string().min(1).max(100), z.string().min(1).max(2000)).refine(v => Object.keys(v).length >= 2 && Object.keys(v).length <= 20) }),
  z.object({ type: z.literal("score"), instructions, criteria: z.array(z.string().min(1).max(2000)).min(2).max(20) }),
]);
export const decisionRequestSchema = z.object({
  state: z.union([z.string().min(1), z.record(z.string(), z.json()), z.array(z.json())]),
  questions: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), decisionQuestionSchema)
    .refine(v => Object.keys(v).length > 0 && Object.keys(v).length <= 20),
});
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;
export type DecisionAnswer =
  | { type: "boolean"; probability: number; confidence?: number }
  | { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence?: number }
  | { type: "score"; score: number; probabilities?: Record<string, number>; confidence?: number };
export interface DecisionUsage {
  inputTokens: number | null; outputTokens: number | null; costCents: string | null;
  costStatus: "reported" | "estimated" | "unpriced";
}
export type DecisionResult =
  | { status: "succeeded"; invocationId: string; answers: Record<string, DecisionAnswer>; usage: DecisionUsage }
  | { status: "unavailable"; reason: DecisionUnavailableReason; invocationId?: string }
  | { status: "failed"; invocationId: string; errorCode: string; usage: DecisionUsage };
export interface DecisionHistoryEntry {
  id: string; feature: string; actorType: string; responsibleUserId: string | null; userName: string | null;
  issueId: string | null; issueIdentifier: string | null; agentId: string | null; runId: string | null;
  connectionId: string; provider: string; model: string; status: string; errorCode: string | null;
  startedAt: string; finishedAt: string | null; durationMs: number | null;
  inputTokens: number | null; outputTokens: number | null; costCents: string | null; costStatus: string | null;
}
export const DECISION_TEST_REQUEST: DecisionRequest = {
  state: "A customer reports being charged twice for an order. The product still works.",
  questions: {
    billing: { type: "boolean", instructions: "Is this a billing problem?" },
    team: { type: "choice", instructions: "Which team should handle the request?", criteria: { billing: "Charges and payments", technical: "Product failures" } },
    severity: { type: "score", instructions: "How severe is the product disruption?", criteria: ["Product works", "Some functionality is unavailable", "Product cannot be used"] },
  },
};
export const TASK_TRIAGE_SIZES = ["small", "medium", "large"] as const;
export type TaskTriageSize = typeof TASK_TRIAGE_SIZES[number];
export const TASK_TRIAGE_WORK_TYPE_CRITERIA = {
  support_investigation: "Find out why something in a running environment behaves as it does: an incident, a support question, a production or UAT defect report",
  data_analysis: "Answer a question from data: bids, pacing, delivery, impressions, plays, reporting numbers",
  product_discovery: "Decide what to build or whether to build it: a vague ask, a stakeholder request, options and trade-offs, research",
  story_grooming: "Turn an agreed need into a story with scope and testable acceptance criteria",
  implementation: "Change application code in a repository: a feature, a fix, a refactor, a dependency upgrade",
  testing: "Verify finished work: review a merge request, run or write tests, check behaviour in the running application",
  deployment: "Ship or operate: a release, a pipeline, infrastructure, or a change to deployment, environment or feature-flag configuration, including a configuration merge request for an environment",
  stakeholder_communication: "Write for people outside the team: a status update, release notes, a client reply, a showcase",
} as const;
export const TASK_TRIAGE_WORK_TYPES = Object.keys(TASK_TRIAGE_WORK_TYPE_CRITERIA) as [TaskTriageWorkType, ...TaskTriageWorkType[]];
export type TaskTriageWorkType = keyof typeof TASK_TRIAGE_WORK_TYPE_CRITERIA;
export const TASK_TRIAGE_QUESTIONS = {
  work_type: { type: "choice", instructions: "What kind of work is the main part of this task?", criteria: TASK_TRIAGE_WORK_TYPE_CRITERIA },
  single_repo: { type: "boolean", instructions: "Can this task be completed by changing at most one code repository? Answer yes when it needs no code change." },
  fits_one_small_mr: { type: "boolean", instructions: "Can this task be delivered as one small, reviewable merge request of roughly 200 changed lines or fewer? Answer yes when it needs no code change." },
  touches_gated_area: { type: "boolean", instructions: "Does this task touch a gated area: a database schema or API contract change, work spanning more than one repository, bidder/RTB/pacing/budget/billing logic, a production configuration, deployment or release change, a change to live data, an irreversible operation, authentication/permissions, or posting to Jira, Confluence or Slack?" },
  size: { type: "score", instructions: "How large is this task, whatever kind of work it is?", criteria: [
    "Small: one focused piece of work one person finishes quickly",
    "Medium: several related pieces that still make one deliverable",
    "Large: needs splitting into multiple deliverables",
  ] },
} satisfies DecisionRequest["questions"];
export const TASK_TRIAGE_PACK_INSTRUCTIONS = "Which context pack best fits this task?";
const packName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
export const taskTriageAgentAnswersSchema = z.object({
  single_repo: z.boolean().optional(),
  fits_one_small_mr: z.boolean().optional(),
  touches_gated_area: z.boolean().optional(),
  size: z.enum(TASK_TRIAGE_SIZES).optional(),
  work_type: z.enum(TASK_TRIAGE_WORK_TYPES).optional(),
  pack: packName.optional(),
}).strict();
export type TaskTriageAgentAnswers = z.infer<typeof taskTriageAgentAnswersSchema>;
export const taskTriageRequestSchema = z.object({
  issueId: z.string().uuid().optional(),
  task: z.string().trim().min(1).max(8000),
  context: z.string().max(16000).optional(),
  packChoices: z.record(packName, z.string().trim().min(1).max(500))
    .refine(v => Object.keys(v).length >= 2 && Object.keys(v).length <= 20, { message: "Provide 2–20 pack choices" }).optional(),
  agentAnswers: taskTriageAgentAnswersSchema.optional(),
}).strict().refine(v => !v.agentAnswers?.pack || Object.hasOwn(v.packChoices ?? {}, v.agentAnswers.pack), {
  message: "agentAnswers.pack must be one of packChoices", path: ["agentAnswers", "pack"],
});
export type TaskTriageRequest = z.infer<typeof taskTriageRequestSchema>;
export type TaskTriageQuestion = keyof TaskTriageAgentAnswers;
export type TaskTriageAgreement = Partial<Record<TaskTriageQuestion, boolean>>;
export type TaskTriageVerdicts = Record<string, boolean | string>;
export type TaskTriageResult =
  | { status: "succeeded"; answers: Record<string, DecisionAnswer>; verdicts: TaskTriageVerdicts; agreement: TaskTriageAgreement }
  | Exclude<DecisionResult, { status: "succeeded" }>;

type DecisionConnectionRouting = { kind: string; baseUrl?: string; auth?: string };
function isKeylessLocalRouting(routing: DecisionConnectionRouting | undefined): routing is DecisionConnectionRouting & { baseUrl: string } {
  return routing?.kind === "local" && routing.auth === "none" && Boolean(routing.baseUrl);
}

/** Native endpoints only; OpenRouter's official routing metadata is compatible. */
export function decisionProviderForConnection(metadata: { provider: string; method: string; routing?: DecisionConnectionRouting }): DecisionProvider | null {
  if (metadata.method !== "api_key") return null;
  if (metadata.provider === "openai" && !metadata.routing) return "openai";
  if (metadata.provider === "openai" && isKeylessLocalRouting(metadata.routing)) return "ollama";
  if (metadata.provider === "openrouter" && (!metadata.routing || (metadata.routing.kind === "openrouter" && !metadata.routing.baseUrl))) return "openrouter";
  return null;
}

export function decisionBaseUrlForConnection(metadata: { routing?: DecisionConnectionRouting }): string | null {
  return isKeylessLocalRouting(metadata.routing) ? metadata.routing.baseUrl.replace(/\/+$/, "") : null;
}
