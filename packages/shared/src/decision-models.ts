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
export const TASK_TRIAGE_TIERS = ["routine", "standard", "hard"] as const;
export type TaskTriageTier = typeof TASK_TRIAGE_TIERS[number];
export const TASK_TRIAGE_WORK_TYPE_CRITERIA = {
  investigation: "Find out why something behaves as it does, or answer a question by reading code, logs or documents, without changing anything",
  data_analysis: "Answer a question by querying, counting or measuring data",
  product_discovery: "Decide what to build or whether to build it: weigh options, challenge an idea, give a user or domain view",
  requirements: "Write or refine a specification or story with scope and testable acceptance criteria",
  implementation: "Change code in a repository: a feature, a fix, a refactor, a dependency upgrade",
  review_and_testing: "Check work someone else did: review a merge request, run tests, verify behaviour in the running application",
  operations: "Ship or operate: merge or release, deploy, change environment configuration or feature flags, watch a system after a release",
  communication: "Write for people: a summary, status update, release notes or a reply",
} as const;
export const TASK_TRIAGE_WORK_TYPES = Object.keys(TASK_TRIAGE_WORK_TYPE_CRITERIA) as [TaskTriageWorkType, ...TaskTriageWorkType[]];
export type TaskTriageWorkType = keyof typeof TASK_TRIAGE_WORK_TYPE_CRITERIA;
export const TASK_TRIAGE_DEFAULT_GATED_AREAS = [
  "a database schema or API contract change",
  "merging, releasing or deploying code, or production configuration",
  "a change to live data",
  "an irreversible operation",
  "authentication or permissions",
  "sending or publishing messages to people outside the team",
] as const;
export function taskTriageGateInstructions(gatedAreas: readonly string[]) {
  return `Does doing this task change or ship any of these: ${gatedAreas.join("; ")}? Reading or investigating them without changing anything is not a yes.`;
}
export const TASK_TRIAGE_QUESTIONS = {
  work_type: { type: "choice", instructions: "What kind of work is the main part of this task?", criteria: TASK_TRIAGE_WORK_TYPE_CRITERIA },
  touches_gated_area: { type: "boolean", instructions: taskTriageGateInstructions(TASK_TRIAGE_DEFAULT_GATED_AREAS) },
  size: { type: "score", instructions: "How large is this task, whatever kind of work it is?", criteria: [
    "Small: one focused piece of work one person finishes quickly",
    "Medium: several related pieces that still make one deliverable",
    "Large: needs splitting into multiple deliverables",
  ] },
  needs_split: { type: "boolean", instructions: "Should this task be split into several separately delivered tasks before anyone starts it?" },
  capability_tier: { type: "score", instructions: "How much judgement does this task need from whoever does it?", criteria: [
    "Routine: mechanical and fully specified, little judgement",
    "Standard: ordinary engineering, review or analysis judgement",
    "Hard: ambiguous, high-stakes, or needs deep reasoning across systems",
  ] },
} satisfies DecisionRequest["questions"];
export const TASK_TRIAGE_PACK_INSTRUCTIONS = "Which context pack best fits this task?";
export const TASK_TRIAGE_OWNER_INSTRUCTIONS = "Which team member is best suited to own this task?";
export const TASK_TRIAGE_MIN_CONFIDENCE = 0.8;
export const TASK_TRIAGE_MIN_GATE_ESCALATION_CONFIDENCE = 0.7;
export const TASK_TRIAGE_HISTORY_WINDOW = 100;
export const TASK_TRIAGE_MIN_SAMPLES = 20;
export const TASK_TRIAGE_MIN_AGREEMENT = 0.85;
const packName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
export const taskTriageAgentAnswersSchema = z.object({
  work_type: z.enum(TASK_TRIAGE_WORK_TYPES).optional(),
  touches_gated_area: z.boolean().optional(),
  size: z.enum(TASK_TRIAGE_SIZES).optional(),
  needs_split: z.boolean().optional(),
  capability_tier: z.enum(TASK_TRIAGE_TIERS).optional(),
  owner: z.string().uuid().optional(),
  pack: packName.optional(),
}).strict();
export type TaskTriageAgentAnswers = z.infer<typeof taskTriageAgentAnswersSchema>;
export const taskTriageRequestSchema = z.object({
  issueId: z.string().uuid().optional(),
  task: z.string().trim().min(1).max(8000),
  context: z.string().max(16000).optional(),
  gatedAreas: z.array(z.string().trim().min(1).max(200)).min(1).max(20).optional(),
  packChoices: z.record(packName, z.string().trim().min(1).max(500))
    .refine(v => Object.keys(v).length >= 2 && Object.keys(v).length <= 20, { message: "Provide 2–20 pack choices" }).optional(),
  chooseOwner: z.boolean().optional(),
  ownerCandidateIds: z.array(z.string().uuid()).min(2).max(20).optional(),
  agentAnswers: taskTriageAgentAnswersSchema.optional(),
}).strict().refine(v => !v.agentAnswers?.pack || Object.hasOwn(v.packChoices ?? {}, v.agentAnswers.pack), {
  message: "agentAnswers.pack must be one of packChoices", path: ["agentAnswers", "pack"],
}).refine(v => !v.ownerCandidateIds || v.chooseOwner, {
  message: "ownerCandidateIds needs chooseOwner", path: ["ownerCandidateIds"],
});
export type TaskTriageRequest = z.infer<typeof taskTriageRequestSchema>;
export type TaskTriageQuestion = keyof TaskTriageAgentAnswers;
export type TaskTriageAgreement = Partial<Record<TaskTriageQuestion, boolean>>;
export type TaskTriageVerdicts = Record<string, boolean | string>;
export type TaskTriageDecisionReason =
  | "confident_with_agreement_record" | "escalates_gate"
  | "gate_never_relaxed" | "low_confidence" | "insufficient_history" | "low_agreement";
export interface TaskTriageDecision {
  d3: boolean | string;
  confidence: number | null;
  use: "d3" | "agent";
  reason: TaskTriageDecisionReason;
  value: boolean | string | null;
}
export type TaskTriageDecisions = Partial<Record<TaskTriageQuestion, TaskTriageDecision>>;
export type TaskTriageResult =
  | { status: "succeeded"; answers: Record<string, DecisionAnswer>; verdicts: TaskTriageVerdicts; agreement: TaskTriageAgreement; decisions: TaskTriageDecisions }
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
