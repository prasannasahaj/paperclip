export interface RunUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

const INPUT_KEYS = ["inputTokens", "input_tokens"];
const OUTPUT_KEYS = ["outputTokens", "output_tokens"];
const CACHED_KEYS = ["cachedInputTokens", "cached_input_tokens", "cache_read_input_tokens"];
const COST_KEYS = ["costUsd", "cost_usd", "total_cost_usd"];

function firstFiniteNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function summarizeRunUsage(usageJson: Record<string, unknown> | null | undefined): RunUsageSummary | null {
  if (!usageJson) return null;
  const inputTokens = firstFiniteNumber(usageJson, INPUT_KEYS);
  const outputTokens = firstFiniteNumber(usageJson, OUTPUT_KEYS);
  const cachedInputTokens = firstFiniteNumber(usageJson, CACHED_KEYS);
  const reportedCost = firstFiniteNumber(usageJson, COST_KEYS);
  const costUsd = reportedCost !== undefined && reportedCost > 0 ? reportedCost : undefined;
  const summary: RunUsageSummary = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
  return Object.keys(summary).length > 0 ? summary : null;
}
