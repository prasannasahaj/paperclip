import path from "node:path";

export const SKILL_IMPORT_ROOTS_ENV = "PAPERCLIP_SKILL_IMPORT_ROOTS";

export function resolveConfiguredSkillImportRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[SKILL_IMPORT_ROOTS_ENV];
  if (typeof raw !== "string") return [];
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry));
}
