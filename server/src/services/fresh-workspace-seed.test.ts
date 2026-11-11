import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materializeFreshWorkspaceSeed } from "./fresh-workspace-seed.js";

const identity = { companyId: "company-1", issueId: "issue-1" };

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { stdio: "pipe" });
}

describe("materializeFreshWorkspaceSeed", () => {
  let sandbox: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    sandbox = realpathSync(mkdtempSync(path.join(os.tmpdir(), "fresh-seed-")));
    previousHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = path.join(sandbox, "home");
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    rmSync(sandbox, { recursive: true, force: true });
  });

  function repositoryWithProjectFolder() {
    const repository = path.join(sandbox, "repository");
    const projectFolder = path.join(repository, "context", "epics", "tactics");
    mkdirSync(projectFolder, { recursive: true });
    writeFileSync(path.join(projectFolder, "BRIEF.md"), "brief");
    writeFileSync(path.join(repository, "README.md"), "root");
    git(repository, "init", "--quiet");
    git(repository, "add", ".");
    git(repository, "commit", "--quiet", "-m", "seed");
    return { repository, projectFolder };
  }

  it("seeds a project folder that lives inside a larger repository", async () => {
    const { projectFolder } = repositoryWithProjectFolder();

    const cwd = await materializeFreshWorkspaceSeed({ ...identity, runId: "run-1", sourceCwd: projectFolder });

    expect(path.relative(path.join(process.env.PAPERCLIP_HOME!), cwd).endsWith(path.join("workspace", "context", "epics", "tactics"))).toBe(true);
    expect(readFileSync(path.join(cwd, "BRIEF.md"), "utf8")).toBe("brief");
  });

  it("returns the same folder when the seed is requested again for the same run", async () => {
    const { projectFolder } = repositoryWithProjectFolder();

    const first = await materializeFreshWorkspaceSeed({ ...identity, runId: "run-1", sourceCwd: projectFolder });
    const second = await materializeFreshWorkspaceSeed({ ...identity, runId: "run-1", sourceCwd: projectFolder });

    expect(second).toBe(first);
  });

  it("still seeds a project whose folder is the repository root", async () => {
    const { repository } = repositoryWithProjectFolder();

    const cwd = await materializeFreshWorkspaceSeed({ ...identity, runId: "run-1", sourceCwd: repository });

    expect(path.basename(cwd)).toBe("workspace");
    expect(readFileSync(path.join(cwd, "README.md"), "utf8")).toBe("root");
  });
});
