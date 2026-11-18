export type ParsedCompactCommand =
  | { matched: false }
  | { matched: true }
  | { matched: true; error: string };

const COMPACT_TOKEN = "/compact";

export function parseCompactCommand(value: string): ParsedCompactCommand {
  const trimmed = value.replaceAll(" ", " ").trim();
  if (!trimmed) return { matched: false };
  const firstWhitespace = trimmed.search(/\s/);
  const firstToken = firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
  if (firstToken !== COMPACT_TOKEN) return { matched: false };
  if (firstWhitespace === -1) return { matched: true };
  return { matched: true, error: "/compact does not accept arguments." };
}
