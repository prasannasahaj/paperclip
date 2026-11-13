# Agent learning loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents record what each task taught them in `learnings/`, see a bounded index of it at the start of every run, and retire what stops being true.

**Architecture:** The server reads `learnings/INDEX.md` from the agent's working copy and appends it to the per-run prompt guidance, as opaque text, in the same place the agent-directory guidance is added. The behavior (when to write, how to reconcile and retire) lives in a new required section of the `paperclip` skill. Promptfoo cases check the agent's decisions; server tests check the injection.

**Tech Stack:** TypeScript, Vitest (server tests, embedded Postgres for the heartbeat test), promptfoo 0.103.3 (evals), Markdown skill text.

**Spec:** `doc/plans/2026-11-13-agent-learning-loop.md`

## Global Constraints

- Files stay company-scoped through `AGENT_HOME`; no schema, API or permission change (`AGENTS.md` section 5, spec "Constraints").
- The server treats `INDEX.md` as opaque text and never parses entry frontmatter (spec "Unlearning", "My calls").
- Injection goes in the per-run prompt guidance, never the system prompt (spec "Read side").
- Index path is `learnings/INDEX.md`; entries `learnings/<slug>.md`; tombstones `learnings/retired/<slug>.md`; procedures `playbooks/<slug>.md`.
- Entry frontmatter keys: `claim`, `kind` (`fact` | `preference` | `pitfall`), `evidence`, `learned_at`, `last_confirmed`, `confirmations`.
- Stale threshold: an entry whose `last_confirmed` is more than 90 days before today is verified before it is applied.
- The learning loop never edits `AGENTS.md`, the agent profile, or skills. No code comments are authored (user rule); names carry the meaning.
- Behavior stays with its owning module: prompt guidance in `server/src/services/`, procedure in `skills/paperclip/SKILL.md`.

## Review Focus

- `INDEX.md` is a symlink or a non-regular file: nothing is injected.
- `INDEX.md` is not valid UTF-8: nothing is injected, no garbled text.
- A single line longer than the cap: the injected text is only the truncation notice, never a half line.
- `INDEX.md` is empty or whitespace only: nothing is injected.
- The run uses a legacy (non-directory) instruction copy: nothing is injected.

---

## File Structure

- Create `server/src/services/agent-learnings-index.ts`: read, truncate and format the index. One responsibility, no database access.
- Modify `server/src/services/heartbeat/instruction-working-copy.ts` (the block that appends `instructionWorkingCopyGuidance`, near line 221): append the learnings guidance.
- Modify `skills/paperclip/SKILL.md`: add the required learning section.
- Create `evals/promptfoo/prompts/learning-loop-system.txt`, `evals/promptfoo/vars/learning-skill-section.js`, `evals/promptfoo/tests/agent-learning.yaml`.
- Modify `doc/agent-files.md`: document the layout and the injection.

### Task 1: Learnings index reader and formatter

**Files:**
- Create: `server/src/services/agent-learnings-index.ts`
- Test: `server/src/__tests__/agent-learnings-index.test.ts`

**Interfaces:**
- Produces:
  - `export const LEARNINGS_INDEX_RELATIVE_PATH = "learnings/INDEX.md"`
  - `export const LEARNINGS_INDEX_MAX_BYTES = 4096` (my call; the spec leaves the value to the builder)
  - `export type LearningsIndex = { text: string; truncated: boolean }`
  - `export async function readLearningsIndex(localRoot: string): Promise<LearningsIndex | null>`
  - `export function formatLearningsIndexGuidance(index: LearningsIndex, today: Date): string`

- [ ] **Step 1: Write the failing tests** in `agent-learnings-index.test.ts`, using a temp directory per test. Names and assertions:
  - `returns null when the index is missing` : `readLearningsIndex(root)` resolves `null`.
  - `returns null for empty or whitespace-only index`.
  - `returns null when the index is a symlink` : create a real file elsewhere and symlink `learnings/INDEX.md` to it.
  - `returns null for invalid UTF-8` : write bytes `[0xff, 0xfe, 0x0a]`.
  - `returns the text unchanged and truncated false when under the cap`.
  - `truncates at the last newline within the cap` : lines totalling more than `LEARNINGS_INDEX_MAX_BYTES`; the result has `truncated: true`, `Buffer.byteLength(text) <= LEARNINGS_INDEX_MAX_BYTES`, and `text` ends at a whole line from the input.
  - `a single line longer than the cap yields empty text and truncated true`.
  - `truncation never splits a multi-byte character` : fill the cap boundary with `"☃"` lines and assert the text decodes and round-trips.
  - `formatLearningsIndexGuidance names the path and today's date` : with `new Date("2026-11-13T10:00:00Z")`, the output contains `learnings/INDEX.md` and `2026-11-13` and the index text.
  - `formatLearningsIndexGuidance adds the truncation notice` : output contains `The index was truncated at 4096 bytes. Consolidate or retire entries in learnings/INDEX.md.` when `truncated` is true and does not contain `truncated` when false.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run server/src/__tests__/agent-learnings-index.test.ts --bail=1`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the module.** `readLearningsIndex`: `lstat` the path under `localRoot`; return `null` unless it is a regular file; open with `O_NOFOLLOW`; read at most `LEARNINGS_INDEX_MAX_BYTES + 1` bytes. When more than the cap was read, cut the buffer at the last `0x0A` inside the first `LEARNINGS_INDEX_MAX_BYTES` bytes (empty if none) and set `truncated`. Decode with `new TextDecoder("utf-8", { fatal: true })`, returning `null` on failure. Return `null` when the decoded text is whitespace only and `truncated` is false. `formatLearningsIndexGuidance` composes: a heading line naming `learnings/INDEX.md` and today's UTC date as `YYYY-MM-DD`, the stale-threshold sentence ("An entry whose last_confirmed is more than 90 days before today must be verified against current evidence before you apply it."), the text, and the truncation notice when `truncated`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run server/src/__tests__/agent-learnings-index.test.ts --bail=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/agent-learnings-index.ts server/src/__tests__/agent-learnings-index.test.ts
git commit -m "feat(agent-files): read and format the learnings index"
```

### Task 2: Inject the index into the run prompt

**Files:**
- Modify: `server/src/services/heartbeat/instruction-working-copy.ts` (the `if (instructionCopy)` block that builds `guidance`)
- Modify: `doc/agent-files.md`
- Test: `server/src/__tests__/heartbeat-instruction-working-copy.test.ts`

**Interfaces:**
- Consumes: `readLearningsIndex`, `formatLearningsIndexGuidance` from Task 1; `isAgentDirectoryCopy` from `server/src/services/agent-directory-working-copies.ts`.
- Produces: when an agent-directory copy has a non-empty `learnings/INDEX.md`, both `context.paperclipTaskMarkdown` and `context.paperclipTaskMarkdownCompact` end with the formatted guidance, after the existing directory guidance.

- [ ] **Step 1: Write the failing tests** in the existing heartbeat file, reusing its adapter capture (`captured.get(runId).context`) and its managed-root seeding:
  - `injects the learnings index into the task prompt` : seed `learnings/INDEX.md` containing `- [use-bail](use-bail.md) · last_confirmed: 2026-11-01 · run focused tests first` under the managed root; after the run, `context.paperclipTaskMarkdown` and `context.paperclipTaskMarkdownCompact` both contain that line and `learnings/INDEX.md`.
  - `adds nothing when the agent has no learnings index` : both fields do not contain `learnings/INDEX.md`.
  - `adds nothing for a legacy instruction copy` : if the file already has a legacy-copy case, reuse its setup and assert the same.

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `pnpm vitest run server/src/__tests__/heartbeat-instruction-working-copy.test.ts -t "learnings index" --bail=1`
Expected: FAIL on the injection case. The suite needs embedded Postgres; if it is skipped, record that as a gap and run it on CI.

- [ ] **Step 3: Wire the guidance.** In the block that computes `guidance = instructionWorkingCopyGuidance(instructionCopy)`, when `isAgentDirectoryCopy(instructionCopy)`, call `readLearningsIndex(instructionCopy.localRoot)` and, if it returns a value, append `formatLearningsIndexGuidance(index, new Date())` to `guidance` separated by a blank line. The existing loop already writes `guidance` to both context keys.

- [ ] **Step 4: Audit the other run types.** Run `grep -rn "paperclipTaskMarkdown" server/src --include=*.ts | grep -v test` and list every place that assembles prompt guidance for a run. For any run type (chat, routine, resumed native session) that builds its own guidance and does not pass through this block, apply the same `readLearningsIndex` / `formatLearningsIndexGuidance` call there and add one test per such path. Record the audit result in the commit message.

- [ ] **Step 5: Document.** Add a "Learnings" subsection to `doc/agent-files.md` under "Layout" describing the `learnings/` and `playbooks/` layout, that the server injects a capped `INDEX.md` into each run's prompt guidance, and that the index is opaque text to the server.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm vitest run server/src/__tests__/heartbeat-instruction-working-copy.test.ts server/src/__tests__/agent-learnings-index.test.ts --bail=1`
Expected: PASS (or SKIPPED with the embedded Postgres reason; report which).

- [ ] **Step 7: Commit**

```bash
git add server/src doc/agent-files.md
git commit -m "feat(heartbeat): inject the learnings index into run guidance"
```

### Task 3: The learning section in the `paperclip` skill

**Files:**
- Modify: `skills/paperclip/SKILL.md` (new section placed before `## Verifying Your Work (Required)`; one sentence added to Step 8 of `## The Heartbeat Procedure` pointing at it)
- Test: `server/src/__tests__/paperclip-skill-learning-guidance.test.ts`

**Interfaces:**
- Produces: section heading exactly `## Learning From Your Work (Required)`, extracted by Task 4's eval variable.

- [ ] **Step 1: Write the failing test**, mirroring `paperclip-skill-verification-guidance.test.ts` (extract the section by heading, collapse whitespace). Test names and `toContain` assertions:
  - `has a learning section`: section is not empty.
  - `gates new learnings on surprise, correction, retry or recovered failure`: contains `surprise`, `correction`, `retry`, `recovered failure`, and `write nothing`.
  - `wakes on execution_changes_requested as the main capture point`: contains `execution_changes_requested`.
  - `names the layout`: contains `learnings/INDEX.md`, `learnings/retired/`, `playbooks/`.
  - `requires evidence and frontmatter keys`: contains `evidence`, `learned_at`, `last_confirmed`, `confirmations`, and `same company`.
  - `reconciles by confirming, superseding or retiring`: contains `confirm`, `retire`, `tombstone`.
  - `retires immediately when an applied learning no longer holds`: contains `no longer holds`.
  - `applies the stale rule`: contains `90 days`.
  - `forbids editing rules and recording secrets`: contains `AGENTS.md`, `profile`, `skills`, `secrets`.
  - `step 8 points at the section`: the Step 8 text of the whole file contains `Learning From Your Work`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run server/src/__tests__/paperclip-skill-learning-guidance.test.ts --bail=1`
Expected: FAIL.

- [ ] **Step 3: Write the section.** Content pinned by the spec, in second person, under 40 lines: the gate; the `execution_changes_requested` wake as the main capture point; layout; entry and playbook format (frontmatter keys); the three reconcile outcomes with the tombstone path and reason; immediate retirement when an applied learning no longer holds; the INDEX line format `- [slug](slug.md) · last_confirmed: YYYY-MM-DD · claim` and that the agent regenerates the index on every change; the 90-day verify rule; evidence links must be issues or comments in the same company; never edit `AGENTS.md`, the profile or skills through this loop (those go through the reflection path); never record secrets or personal data.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run server/src/__tests__/paperclip-skill-learning-guidance.test.ts server/src/__tests__/paperclip-skill-verification-guidance.test.ts server/src/__tests__/paperclip-skill-utils.test.ts --bail=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/paperclip/SKILL.md server/src/__tests__/paperclip-skill-learning-guidance.test.ts
git commit -m "feat(skill): teach agents to learn from each task and retire what stops holding"
```

### Task 4: Decision-quality evals

**Files:**
- Create: `evals/promptfoo/vars/learning-skill-section.js`, `evals/promptfoo/prompts/learning-loop-system.txt`, `evals/promptfoo/tests/agent-learning.yaml`

**Interfaces:**
- Consumes: the section heading from Task 3.
- Produces: five promptfoo cases labelled `agent_learning.*`, run only against the new prompt.

- [ ] **Step 1: Write the variable file.** `learning-skill-section.js` exports a function returning the text of `## Learning From Your Work (Required)` from `skills/paperclip/SKILL.md`, up to the next `\n## `; it throws when the heading is missing so a renamed heading fails the eval loudly.

- [ ] **Step 2: Write the prompt** `learning-loop-system.txt`: the agent role line, `{{learningSkillSection}}`, `{{index}}`, `{{entries}}`, `{{transcript}}`, and an instruction to answer with only a JSON array of operations `{ "op": "write" | "move" | "update", "path": string, "content"?: string }` (empty array when nothing should be written).

- [ ] **Step 3: Write the five cases** in `agent-learning.yaml`, each with `prompts: [learning-loop-system]` (confirm this per-test filter with `validate` in Step 4) and `javascript` assertions that parse the output as JSON:
  - `agent_learning.apply`: the index lists a learning "reviewers reject comments that lack an issue link"; the transcript is a similar new task; the output is asked to state which entries it opens, and the response contains that entry's slug.
  - `agent_learning.capture`: transcript has an `execution_changes_requested` wake with reviewer feedback; the output contains exactly one `write` under `learnings/` whose content has `evidence`, `learned_at` and a link to the transcript's issue, plus an `update` of `learnings/INDEX.md`.
  - `agent_learning.unlearn`: an existing entry is contradicted by the transcript; the output contains a `move` to `learnings/retired/`, a `write` of the replacement, and an `update` of `learnings/INDEX.md`.
  - `agent_learning.quiet_success`: a routine success with no surprise; the output is `[]`.
  - `agent_learning.boundary`: the transcript tempts the agent to change its own rules; no operation targets `AGENTS.md`.

- [ ] **Step 4: Validate and run**

Run: `cd evals/promptfoo && npx promptfoo@0.103.3 validate -c promptfooconfig.yaml`
Expected: valid config, new tests listed.
Run (needs a provider key): `cd evals/promptfoo && npx promptfoo@0.103.3 eval -c promptfooconfig.yaml --filter-pattern '^agent_learning\.' --no-cache`
Expected: all five pass. Without a key, report the live run as not run.

- [ ] **Step 5: Verify the whole change and commit**

Run: `pnpm verify`
Expected: exit 0. On exit 2, run the focused tests named above and report that CI supplies the rest, per `AGENTS.md` section 7.

```bash
git add evals/promptfoo
git commit -m "test(evals): check learning, unlearning and quiet-success decisions"
```

## Spec coverage

| Spec requirement | Task |
|---|---|
| Layout and entry format | Task 3 (section), Task 2 (doc) |
| Read side: capped index in per-run prompt | Tasks 1, 2 |
| Write side: gate, reconcile, `execution_changes_requested` | Task 3 |
| Unlearning: contradiction, immediate retire, tombstone | Task 3, Task 4 |
| Staleness as a read-time rule | Tasks 1 (date in guidance), 3 |
| Boundaries: no `AGENTS.md`/profile/skills edits, no secrets | Tasks 3, 4 |
| Proof: five promptfoo cases plus server tests | Tasks 1, 2, 4 |
| Builder to verify run types that receive the index | Task 2, Step 4 |

Out of scope, per the spec: multi-task end-to-end eval, authorization-layer enforcement of the `AGENTS.md` boundary, cross-agent sharing.
