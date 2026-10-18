import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  materializeProjectSkills,
  skillDefinitionsSchema,
  validateProjectSkillReferences
} from "../src/project-skills.js";
import { createProjectSchema, mergeAgentConfigs } from "../src/validation.js";
import {
  mainAgentOrchestrationDocument,
  parseAgentOrchestrationProposal
} from "../src/agent-orchestration-reconfiguration.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })));
});
async function temporary(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-project-skills-"));
  roots.push(root);
  return root;
}
const skill = (version: string) => ({ files: {
  "SKILL.md": `---\nname: task-check\ndescription: Check task evidence\n---\n${version}`,
  "scripts/check.py": `print('${version}')\n`
} });

it.each(["../outside", "/absolute", "nested/../outside", "C:/escape", "nested\\escape", "a//b", "a/./b"])(
  "rejects unsafe project Skill path %s before writing",
  (file) => {
    expect(() => skillDefinitionsSchema.parse({
      test: { files: { "SKILL.md": "content", [file]: "bad" } }
    })).toThrow();
  }
);

it("rejects missing SKILL.md, conflicting paths, and unresolved selections", () => {
  for (const files of [
    { "scripts/a.py": "print(1)" },
    { "SKILL.md": " " },
    { "SKILL.md": "ok", scripts: "x", "scripts/a.py": "x" }
  ]) {
    expect(() => skillDefinitionsSchema.parse({ test: { files } })).toThrow();
  }
  const parsed = createProjectSchema.parse({
    title: "test",
    requirement: "test",
    agents: { main: { skills: ["project:missing"] } }
  });
  const agents = mergeAgentConfigs(parsed.agents, parsed.orchestration);
  expect(() => validateProjectSkillReferences(agents, {}))
    .toThrow("undefined project Skill");
});

it("keeps immutable versions per project and detects out-of-band changes", async () => {
  const root = await temporary();
  const one = await materializeProjectSkills(path.join(root, "prj_one"), { task: skill("one") });
  const two = await materializeProjectSkills(path.join(root, "prj_one"), { task: skill("two") });
  const other = await materializeProjectSkills(path.join(root, "prj_two"), { task: skill("one") });
  expect(new Set([one["project:task"], two["project:task"], other["project:task"]]).size).toBe(3);
  expect(await fs.readFile(one["project:task"], "utf8")).toContain("one");
  expect(await fs.readFile(two["project:task"], "utf8")).toContain("two");
  await fs.writeFile(two["project:task"], "uncommitted");
  await expect(materializeProjectSkills(path.join(root, "prj_one"), { task: skill("two") }))
    .rejects.toThrow("modified outside apply_workflow");
  expect(await fs.readFile(other["project:task"], "utf8")).toContain("one");
});

it("does not write through a symlink replacing project Skill storage", async () => {
  const root = await temporary();
  const outside = await temporary();
  await fs.symlink(outside, path.join(root, "skills"));
  await expect(materializeProjectSkills(root, { task: skill("one") }))
    .rejects.toThrow("regular directories");
  expect(await fs.readdir(outside)).toEqual([]);
});

it("keeps accepted Skills immutable while allowing append-only definitions", () => {
  const parsed = createProjectSchema.parse({
    title: "test",
    requirement: "test",
    skillDefinitions: { task: skill("one") },
    agents: { main: { skills: ["project:task"] } }
  });
  parsed.orchestration.allowMainReconfiguration = true;
  const agents = mergeAgentConfigs(parsed.agents, parsed.orchestration);
  const original = parsed.skillDefinitions!;
  const document = mainAgentOrchestrationDocument(
    "prj_test",
    parsed.orchestration,
    agents,
    original
  );
  document.skillDefinitions.task = skill("two");
  expect(() => parseAgentOrchestrationProposal(
    JSON.stringify(document),
    "prj_test",
    parsed.orchestration,
    agents,
    { skillDefinitions: original }
  )).toThrow("immutable");
  document.skillDefinitions = {
    "task-v2": skill("two")
  };
  const proposal = parseAgentOrchestrationProposal(
    JSON.stringify(document),
    "prj_test",
    parsed.orchestration,
    agents,
    { skillDefinitions: original }
  );
  expect(proposal.skillDefinitions).toEqual({ ...original, "task-v2": skill("two") });
  document.skillDefinitions = {};
  document.agents.main.instructions = "preserve old resources";
  expect(parseAgentOrchestrationProposal(
    JSON.stringify(document),
    "prj_test",
    parsed.orchestration,
    agents,
    { skillDefinitions: original }
  ).skillDefinitions).toEqual(original);
});
