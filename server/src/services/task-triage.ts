import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import {
  TASK_TRIAGE_PACK_INSTRUCTIONS, TASK_TRIAGE_QUESTIONS, TASK_TRIAGE_SIZES,
  type DecisionAnswer, type DecisionRequest, type TaskTriageAgentAnswers, type TaskTriageAgreement,
  type TaskTriageRequest, type TaskTriageResult,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { logActivity } from "./activity-log.js";
import type { AuthorizationActor } from "./authorization.js";
import { defineDecisionFeature, type decisionModelService } from "./decision-models.js";

export const taskTriageFeature = defineDecisionFeature("tasks.triage");
const BOOLEAN_YES_PROBABILITY = 0.5;

export interface TaskTriageCaller {
  companyId: string;
  actor: AuthorizationActor;
  activityActor: { actorType: "agent" | "user"; actorId: string; agentId: string | null; runId: string | null };
}

export function taskTriageDecisionRequest(input: TaskTriageRequest): DecisionRequest {
  const questions: DecisionRequest["questions"] = { ...TASK_TRIAGE_QUESTIONS };
  if (input.packChoices) questions.pack = { type: "choice", instructions: TASK_TRIAGE_PACK_INSTRUCTIONS, criteria: input.packChoices };
  const state: Record<string, string> = { task: input.task };
  if (input.context !== undefined) state.context = input.context;
  return { state, questions };
}

function d3Verdict(answer: DecisionAnswer | undefined) {
  if (!answer) return undefined;
  if (answer.type === "boolean") return answer.probability >= BOOLEAN_YES_PROBABILITY;
  if (answer.type === "score") return TASK_TRIAGE_SIZES[answer.score];
  return answer.choice;
}

export function triageAgreement(answers: Record<string, DecisionAnswer>, agentAnswers: TaskTriageAgentAnswers = {}): TaskTriageAgreement {
  return Object.fromEntries(Object.entries(agentAnswers).flatMap(([question, agentAnswer]) => {
    const verdict = d3Verdict(answers[question]);
    return verdict === undefined ? [] : [[question, verdict === agentAnswer]];
  }));
}

async function assertAgentHasActiveRun(db: Db, companyId: string, actor: AuthorizationActor) {
  if (actor.type !== "agent") return;
  if (!actor.agentId || !actor.runId) throw forbidden("An active run is required");
  const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.agentId, actor.agentId),
  ));
  if (run?.status !== "running") throw forbidden("An active run is required");
}

async function shadowLogEntity(db: Db, companyId: string, issueId: string | undefined) {
  const [issue] = issueId ? await db.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))) : [];
  return issue ? { entityType: "issue", entityId: issue.id, issueId: issue.id } : { entityType: "company", entityId: companyId };
}

export function taskTriageService(db: Db, decisions: ReturnType<typeof decisionModelService>) {
  async function triage(caller: TaskTriageCaller, input: TaskTriageRequest): Promise<TaskTriageResult> {
    await assertAgentHasActiveRun(db, caller.companyId, caller.actor);
    const result = await decisions.decide({ companyId: caller.companyId, actor: caller.actor, feature: taskTriageFeature, issueId: input.issueId },
      taskTriageDecisionRequest(input));
    if (result.status !== "succeeded") return result;
    const agreement = triageAgreement(result.answers, input.agentAnswers);
    await logActivity(db, { companyId: caller.companyId, ...caller.activityActor, action: "decision_model.triage_shadow",
      ...(await shadowLogEntity(db, caller.companyId, input.issueId)),
      details: { invocationId: result.invocationId, d3Answers: result.answers, agentAnswers: input.agentAnswers ?? {}, agreement } });
    return { status: "succeeded", answers: result.answers, agreement };
  }
  return { triage };
}
