export type CheckKind = "compile" | "lint" | "typecheck" | "test" | "mutation" | "build";

export const FAST_CHECK_BUDGET_MS = 60_000;

export type MaturityFindingCode = "no_checks_ran" | "slow_check" | "environment_blocked" | "low_first_pass";

export interface MaturityFinding {
  code: MaturityFindingCode;
  message: string;
}

export interface CheckKindStats {
  kind: CheckKind;
  commands: number;
  failures: number;
  firstPassRate: number | null;
  medianMs: number | null;
  slowestMs: number | null;
}

export interface ModelMixEntry {
  model: string;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
}

export interface IssueMaturityScorecard {
  issueId: string;
  includeDescendants: boolean;
  truncated: boolean;
  runCount: number;
  reworkRuns: number;
  recheckAfterFailure: number;
  environmentBlockedCount: number;
  agentWaitShare: number | null;
  byKind: CheckKindStats[];
  modelMix: ModelMixEntry[];
  findings: MaturityFinding[];
}
