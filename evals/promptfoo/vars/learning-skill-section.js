import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SKILL_PATH = fileURLToPath(new URL("../../../skills/paperclip/SKILL.md", import.meta.url));
const SECTION_HEADING = "## Learning From Your Work (Required)";
const NEXT_SECTION_MARKER = "\n## ";

export default function learningSkillSection() {
  const skill = readFileSync(SKILL_PATH, "utf8");
  const headingStart = skill.indexOf(`\n${SECTION_HEADING}\n`);
  if (headingStart === -1) {
    throw new Error(`Heading "${SECTION_HEADING}" not found in ${SKILL_PATH}`);
  }
  const sectionStart = headingStart + 1;
  const sectionEnd = skill.indexOf(NEXT_SECTION_MARKER, sectionStart + SECTION_HEADING.length);
  const section = skill.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd).trim();
  return { output: section };
}
