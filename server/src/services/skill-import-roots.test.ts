import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfiguredSkillImportRoots } from "./skill-import-roots.js";

describe("resolveConfiguredSkillImportRoots", () => {
  it("returns no roots when unset or empty", () => {
    expect(resolveConfiguredSkillImportRoots({})).toEqual([]);
    expect(resolveConfiguredSkillImportRoots({ PAPERCLIP_SKILL_IMPORT_ROOTS: "  " })).toEqual([]);
  });

  it("splits on the platform delimiter and trims entries", () => {
    const value = ["/opt/skills", " /srv/more ", ""].join(path.delimiter);
    expect(resolveConfiguredSkillImportRoots({ PAPERCLIP_SKILL_IMPORT_ROOTS: value })).toEqual(["/opt/skills", "/srv/more"]);
  });

  it("drops relative entries so the working directory can never widen the boundary", () => {
    const value = ["relative/skills", "/opt/skills"].join(path.delimiter);
    expect(resolveConfiguredSkillImportRoots({ PAPERCLIP_SKILL_IMPORT_ROOTS: value })).toEqual(["/opt/skills"]);
  });
});
