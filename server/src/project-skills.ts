import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentConfigMap } from "./types.js";
import { materializeVersion, projectNameSchema, textFilesSchema } from "./project-files.js";

const definition = z.object({
  files: textFilesSchema.superRefine((files, ctx) => {
    if (!files["SKILL.md"]?.trim()) ctx.addIssue({ code: "custom", message: "A project Skill requires non-empty SKILL.md" });
  })
}).strict();

export const skillDefinitionsSchema = z.record(projectNameSchema, definition)
  .superRefine((skills, ctx) => {
    if (Object.keys(skills).length > 50 || Buffer.byteLength(JSON.stringify(skills), "utf8") > 1_048_576) {
      ctx.addIssue({ code: "custom", message: "Project Skills support at most 50 definitions and 1 MiB of content" });
    }
  });
export type ProjectSkillDefinitions = z.infer<typeof skillDefinitionsSchema>;

export function skillRevision(skill: ProjectSkillDefinitions[string]): string {
  return createHash("sha256").update(JSON.stringify(Object.entries(skill.files).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
}

export function validateProjectSkillReferences(agents: AgentConfigMap, skills: ProjectSkillDefinitions): void {
  for (const [agent, config] of Object.entries(agents)) {
    for (const selected of [...config.skills, ...config.autoSkills]) {
      if (selected.startsWith("project:") && !Object.hasOwn(skills, selected.slice(8))) {
        throw new Error(`${agent} references undefined project Skill: ${selected}`);
      }
    }
  }
}

export function changedProjectSkills(before: ProjectSkillDefinitions = {}, after: ProjectSkillDefinitions = {}): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) =>
    !Object.hasOwn(before, name) || !Object.hasOwn(after, name) || skillRevision(before[name]) !== skillRevision(after[name]));
}

/** State owns the contents; version directories are materialized without changing active revisions. */
export async function materializeProjectSkills(projectDir: string, input: ProjectSkillDefinitions = {}): Promise<Record<string, string>> {
  const definitions = skillDefinitionsSchema.parse(input);
  const result: Record<string, string> = {};
  for (const [name, skill] of Object.entries(definitions)) {
    const destination = await materializeVersion(projectDir, "skills", name, skillRevision(skill), skill.files);
    result[`project:${name}`] = path.join(destination, "SKILL.md");
  }
  return result;
}
