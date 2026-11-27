import { createHash } from "node:crypto";
import { and, desc, eq, gt, inArray, notInArray } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import {
  TASK_TRIAGE_AUDIT_ONE_IN, TASK_TRIAGE_CALIBRATION_MAX_AGE_DAYS, TASK_TRIAGE_HISTORY_WINDOW, TASK_TRIAGE_MIN_AGREEMENT, TASK_TRIAGE_MIN_CONFIDENCE, TASK_TRIAGE_MIN_GATE_ESCALATION_CONFIDENCE, TASK_TRIAGE_MIN_SAMPLES,
  TASK_TRIAGE_OWNER_INSTRUCTIONS, TASK_TRIAGE_PACK_INSTRUCTIONS, TASK_TRIAGE_QUESTIONS, TASK_TRIAGE_SIZES, TASK_TRIAGE_TIERS,
  deriveAgentUrlKey, taskTriageCalibrationSchema, taskTriageGateInstructions,
  type DecisionAnswer, type DecisionRequest, type TaskTriageAgentAnswers, type TaskTriageAgreement, type TaskTriageCalibration, type TaskTriageDecision,
  type TaskTriageDecisions, type TaskTriageQuestion, type TaskTriageRequest, type TaskTriageResult, type TaskTriageVerdicts,
} from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { logActivity } from "./activity-log.js";
import type { AuthorizationActor } from "./authorization.js";
import { defineDecisionFeature, type decisionModelService } from "./decision-models.js";

export const taskTriageFeature = defineDecisionFeature("tasks.triage");
const SHADOW_ACTION = "decision_model.triage_shadow";
const CALIBRATION_ACTION = "decision_model.triage_calibration";
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const BOOLEAN_YES_PROBABILITY = 0.5;
const GATE_QUESTION = "touches_gated_area";
const OWNER_QUESTION = "owner";
const MAX_OWNER_CHOICES = 20;
const OWNER_CRITERION_LENGTH = 480;
const AGENT_STATUSES_THAT_CANNOT_OWN = ["terminated", "paused", "pending_approval"];
const SCORE_BUCKETS: Record<string, readonly string[]> = { size: TASK_TRIAGE_SIZES, capability_tier: TASK_TRIAGE_TIERS };

export interface TaskTriageCaller {
  companyId: string;
  actor: AuthorizationActor;
  activityActor: { actorType: "agent" | "user"; actorId: string; agentId: string | null; runId: string | null };
}

type OwnerChoices = { criteria: Record<string, string>; agentIdByKey: Record<string, string> };
type QuestionRecord = { samples: number; agreeing: number };
type RecordedTriageCalibration = TaskTriageCalibration & { recordedAt: string };
export type ActiveTriageCalibration = Partial<Record<TaskTriageQuestion, RecordedTriageCalibration>>;

export function taskTriageDecisionRequest(input: TaskTriageRequest, owners?: OwnerChoices): DecisionRequest {
  const questions: DecisionRequest["questions"] = { ...TASK_TRIAGE_QUESTIONS };
  if (input.gatedAreas) questions[GATE_QUESTION] = { type: "boolean", instructions: taskTriageGateInstructions(input.gatedAreas) };
  if (input.packChoices) questions.pack = { type: "choice", instructions: TASK_TRIAGE_PACK_INSTRUCTIONS, criteria: input.packChoices };
  if (owners) questions[OWNER_QUESTION] = { type: "choice", instructions: TASK_TRIAGE_OWNER_INSTRUCTIONS, criteria: owners.criteria };
  const state: Record<string, string> = {};
  if (input.title !== undefined) state.title = input.title;
  state.task = input.task;
  if (input.context !== undefined) state.context = input.context;
  return { state, questions };
}

function nearestBucket(buckets: readonly string[], score: number) {
  return buckets[Math.min(buckets.length - 1, Math.max(0, Math.round(score)))];
}

function d3Verdict(question: string, answer: DecisionAnswer, owners?: OwnerChoices) {
  if (answer.type === "boolean") return answer.probability >= BOOLEAN_YES_PROBABILITY;
  if (answer.type === "score") return nearestBucket(SCORE_BUCKETS[question] ?? TASK_TRIAGE_SIZES, answer.score);
  if (question === OWNER_QUESTION && owners) return owners.agentIdByKey[answer.choice] ?? answer.choice;
  return answer.choice;
}

export function triageVerdicts(answers: Record<string, DecisionAnswer>, owners?: OwnerChoices): TaskTriageVerdicts {
  return Object.fromEntries(Object.entries(answers).map(([question, answer]) => [question, d3Verdict(question, answer, owners)]));
}

export function triageAgreement(verdicts: TaskTriageVerdicts, agentAnswers: TaskTriageAgentAnswers = {}): TaskTriageAgreement {
  return Object.fromEntries(Object.entries(agentAnswers).flatMap(([question, agentAnswer]) =>
    question in verdicts ? [[question, verdicts[question] === agentAnswer]] : []));
}

function answerConfidence(answer: DecisionAnswer) {
  if (answer.type === "boolean") return Math.max(answer.probability, 1 - answer.probability);
  return typeof answer.confidence === "number" ? answer.confidence : null;
}

function isConfident(confidence: number | null): confidence is number {
  return confidence !== null && confidence >= TASK_TRIAGE_MIN_CONFIDENCE;
}

function hasTrustworthyRecord(record: QuestionRecord | undefined) {
  return Boolean(record && record.samples >= TASK_TRIAGE_MIN_SAMPLES && record.agreeing / record.samples >= TASK_TRIAGE_MIN_AGREEMENT);
}

function hasPoorRecord(record: QuestionRecord | undefined) {
  return Boolean(record && record.samples >= TASK_TRIAGE_MIN_SAMPLES && record.agreeing / record.samples < TASK_TRIAGE_MIN_AGREEMENT);
}

export function triageDecision(question: string, d3: boolean | string, confidence: number | null,
  agentAnswer: boolean | string | undefined, record: QuestionRecord | undefined,
  calibration?: RecordedTriageCalibration): TaskTriageDecision {
  const useD3 = (reason: TaskTriageDecision["reason"]) => ({ d3, confidence, use: "d3" as const, reason, value: d3 });
  const useAgent = (reason: TaskTriageDecision["reason"]) => ({ d3, confidence, use: "agent" as const, reason, value: agentAnswer ?? null });
  if (question === GATE_QUESTION) {
    if (d3 !== true) return useAgent("gate_never_relaxed");
    return confidence !== null && confidence >= TASK_TRIAGE_MIN_GATE_ESCALATION_CONFIDENCE ? useD3("escalates_gate") : useAgent("low_confidence");
  }
  if (calibration) {
    if (confidence === null || confidence < calibration.minConfidence) return useAgent("low_confidence");
    return hasPoorRecord(record) ? useAgent("low_agreement") : useD3("calibrated");
  }
  if (!isConfident(confidence)) return useAgent("low_confidence");
  if (!record || record.samples < TASK_TRIAGE_MIN_SAMPLES) return useAgent("insufficient_history");
  return hasTrustworthyRecord(record) ? useD3("confident_with_agreement_record") : useAgent("low_agreement");
}

function confidenceBarFor(question: string, calibration: ActiveTriageCalibration) {
  return calibration[question as TaskTriageQuestion]?.minConfidence ?? TASK_TRIAGE_MIN_CONFIDENCE;
}

async function confidentAgreementRecord(db: Db, companyId: string, calibration: ActiveTriageCalibration) {
  const rows = await db.select({ details: activityLog.details }).from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, SHADOW_ACTION)))
    .orderBy(desc(activityLog.createdAt)).limit(TASK_TRIAGE_HISTORY_WINDOW * TASK_TRIAGE_AUDIT_ONE_IN);
  const records: Record<string, QuestionRecord> = {};
  for (const { details } of rows) {
    const decisions = (details?.decisions ?? {}) as Record<string, { confidence?: unknown }>;
    const agreement = (details?.agreement ?? {}) as Record<string, unknown>;
    for (const [question, agrees] of Object.entries(agreement)) {
      const confidence = decisions[question]?.confidence;
      if (typeof agrees !== "boolean" || typeof confidence !== "number" || confidence < confidenceBarFor(question, calibration)) continue;
      const record = records[question] ??= { samples: 0, agreeing: 0 };
      if (record.samples >= TASK_TRIAGE_HISTORY_WINDOW) continue;
      record.samples += 1;
      if (agrees) record.agreeing += 1;
    }
  }
  return records;
}

export async function recordTriageCalibration(db: Db, caller: TaskTriageCaller, input: TaskTriageCalibration): Promise<RecordedTriageCalibration> {
  const parsed = taskTriageCalibrationSchema.safeParse(input);
  if (!parsed.success) throw badRequest("Invalid calibration", parsed.error.issues);
  const valid = parsed.data;
  if (valid.samples < TASK_TRIAGE_MIN_SAMPLES) throw badRequest(`A calibration needs at least ${TASK_TRIAGE_MIN_SAMPLES} samples`);
  if (valid.accuracy < TASK_TRIAGE_MIN_AGREEMENT) throw badRequest(`A calibration needs accuracy of at least ${TASK_TRIAGE_MIN_AGREEMENT}`);
  const activity = await logActivity(db, { companyId: caller.companyId, ...caller.activityActor, action: CALIBRATION_ACTION,
    entityType: "company", entityId: caller.companyId, details: { ...valid } });
  const [{ createdAt }] = await db.select({ createdAt: activityLog.createdAt }).from(activityLog).where(eq(activityLog.id, activity.id));
  return { ...valid, recordedAt: createdAt.toISOString() };
}

export async function activeTriageCalibration(db: Db, companyId: string, now: Date = new Date()): Promise<ActiveTriageCalibration> {
  const oldestAcceptable = new Date(now.getTime() - TASK_TRIAGE_CALIBRATION_MAX_AGE_DAYS * MILLISECONDS_PER_DAY);
  const rows = await db.select({ details: activityLog.details, createdAt: activityLog.createdAt }).from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, CALIBRATION_ACTION), gt(activityLog.createdAt, oldestAcceptable)))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id));
  const active: ActiveTriageCalibration = {};
  for (const { details, createdAt } of rows) {
    const parsed = taskTriageCalibrationSchema.safeParse(details);
    if (!parsed.success || active[parsed.data.question]) continue;
    active[parsed.data.question] = { ...parsed.data, recordedAt: createdAt.toISOString() };
  }
  return active;
}

async function ownerChoices(db: Db, companyId: string, input: TaskTriageRequest): Promise<OwnerChoices | undefined> {
  if (!input.chooseOwner) return undefined;
  const conditions = [eq(agents.companyId, companyId), notInArray(agents.status, AGENT_STATUSES_THAT_CANNOT_OWN)];
  if (input.ownerCandidateIds) conditions.push(inArray(agents.id, input.ownerCandidateIds));
  const candidates = await db.select({ id: agents.id, name: agents.name, title: agents.title, capabilities: agents.capabilities })
    .from(agents).where(and(...conditions)).orderBy(agents.name);
  if (input.ownerCandidateIds && candidates.length !== new Set(input.ownerCandidateIds).size) {
    throw badRequest("ownerCandidateIds must name working agents in this company");
  }
  if (candidates.length < 2 || candidates.length > MAX_OWNER_CHOICES) {
    throw badRequest(`chooseOwner needs 2–${MAX_OWNER_CHOICES} working agents; send ownerCandidateIds to narrow the choice`);
  }
  const criteria: Record<string, string> = {}, agentIdByKey: Record<string, string> = {};
  for (const agent of candidates) {
    const base = deriveAgentUrlKey(agent.name, agent.id);
    let key = base;
    for (let n = 2; key in criteria; n++) key = `${base}-${n}`;
    const role = agent.title ?? agent.name;
    criteria[key] = (agent.capabilities ? `${role}: ${agent.capabilities}` : role).slice(0, OWNER_CRITERION_LENGTH);
    agentIdByKey[key] = agent.id;
  }
  if (input.agentAnswers?.owner && !Object.values(agentIdByKey).includes(input.agentAnswers.owner)) {
    throw badRequest("agentAnswers.owner must be one of the owner candidates");
  }
  return { criteria, agentIdByKey };
}

async function assertAgentHasActiveRun(db: Db, companyId: string, actor: AuthorizationActor) {
  if (actor.type !== "agent") return;
  if (!actor.agentId || !actor.runId) throw forbidden("An active run is required");
  const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.agentId, actor.agentId),
  ));
  if (run?.status !== "running") throw forbidden("An active run is required");
}

export function isAuditedTriageCall(seed: string): boolean {
  if (seed === "") return false;
  return createHash("sha256").update(seed).digest().readUInt32BE(0) % TASK_TRIAGE_AUDIT_ONE_IN === 0;
}

function assertAgentAnsweredRequiredQuestions(decisionRequest: DecisionRequest, input: TaskTriageRequest, caller: TaskTriageCaller,
  calibration: ActiveTriageCalibration) {
  const hasCalibration = Object.keys(calibration).length > 0;
  const audited = hasCalibration && isAuditedTriageCall(input.issueId ?? caller.activityActor.runId ?? "");
  const missing = Object.keys(decisionRequest.questions).filter(question =>
    input.agentAnswers?.[question as TaskTriageQuestion] === undefined && (audited || !(question in calibration)));
  if (missing.length === 0) return;
  const reason = audited
    ? "This call was picked for a calibration audit, so every question needs your own answer."
    : "Send your own answer for every question D3 is not calibrated on so D3's agreement record can grow.";
  throw badRequest(`${reason} Missing agentAnswers: ${missing.join(", ")}`);
}

async function shadowLogEntity(db: Db, companyId: string, issueId: string | undefined) {
  const [issue] = issueId ? await db.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))) : [];
  return issue ? { entityType: "issue", entityId: issue.id, issueId: issue.id } : { entityType: "company", entityId: companyId };
}

export function taskTriageService(db: Db, decisions: ReturnType<typeof decisionModelService>) {
  async function triage(caller: TaskTriageCaller, input: TaskTriageRequest): Promise<TaskTriageResult> {
    await assertAgentHasActiveRun(db, caller.companyId, caller.actor);
    const owners = await ownerChoices(db, caller.companyId, input);
    const decisionRequest = taskTriageDecisionRequest(input, owners);
    const calibration = await activeTriageCalibration(db, caller.companyId);
    if (caller.activityActor.actorType === "agent") assertAgentAnsweredRequiredQuestions(decisionRequest, input, caller, calibration);
    const result = await decisions.decide({ companyId: caller.companyId, actor: caller.actor, feature: taskTriageFeature, issueId: input.issueId },
      decisionRequest);
    if (result.status !== "succeeded") return result;
    const verdicts = triageVerdicts(result.answers, owners);
    const agentAnswers: TaskTriageAgentAnswers = input.agentAnswers ?? {};
    const agreement = triageAgreement(verdicts, agentAnswers);
    const records = await confidentAgreementRecord(db, caller.companyId, calibration);
    const decided: TaskTriageDecisions = Object.fromEntries(Object.entries(result.answers).map(([question, answer]) => [question,
      triageDecision(question, verdicts[question], answerConfidence(answer), agentAnswers[question as TaskTriageQuestion], records[question],
        calibration[question as TaskTriageQuestion])]));
    const loggedDecisions = Object.fromEntries(Object.entries(decided).map(([question, d]) =>
      [question, { confidence: d.confidence, use: d.use, reason: d.reason }]));
    await logActivity(db, { companyId: caller.companyId, ...caller.activityActor, action: SHADOW_ACTION,
      ...(await shadowLogEntity(db, caller.companyId, input.issueId)),
      details: { invocationId: result.invocationId, d3Answers: result.answers, verdicts, agentAnswers, agreement, decisions: loggedDecisions } });
    return { status: "succeeded", answers: result.answers, verdicts, agreement, decisions: decided };
  }
  return { triage };
}
