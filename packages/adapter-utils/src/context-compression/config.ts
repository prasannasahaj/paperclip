export const CONTEXT_COMPRESSION_MODES = ["on", "record", "off"] as const;

export type ContextCompressionMode = (typeof CONTEXT_COMPRESSION_MODES)[number];

const DEFAULT_CONTEXT_COMPRESSION_MODE: ContextCompressionMode = "on";

export function readContextCompressionMode(config: Record<string, unknown>): ContextCompressionMode {
  const configured = config.contextCompression;
  if (typeof configured !== "string") return DEFAULT_CONTEXT_COMPRESSION_MODE;
  const normalized = configured.trim().toLowerCase();
  return CONTEXT_COMPRESSION_MODES.find((mode) => mode === normalized) ?? DEFAULT_CONTEXT_COMPRESSION_MODE;
}
