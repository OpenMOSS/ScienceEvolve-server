import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const projectNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const relativeFileSchema = z.string().min(1).max(240).refine((file) =>
  !/[\\:\x00-\x1f]/.test(file) && file.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
"Project files must use relative POSIX paths without traversal");
export const textFilesSchema = z.record(relativeFileSchema, z.string().max(500_000)).superRefine((files, ctx) => {
  if (Object.keys(files).length > 100) ctx.addIssue({ code: "custom", message: "A project bundle supports at most 100 files" });
  for (const file of Object.keys(files)) {
    const parts = file.split("/");
    if (parts.slice(0, -1).some((_, index) => Object.hasOwn(files, parts.slice(0, index + 1).join("/")))) {
      ctx.addIssue({ code: "custom", message: "Project file and directory paths conflict" });
    }
  }
});

/** Materialize and verify a committed or candidate version without replacing any prior version. */
export async function materializeVersion(projectDir: string, kind: "skills" | "mcp", name: string, revision: string, files: Record<string, string>): Promise<string> {
  const label = kind === "skills" ? "Project Skill" : "Project MCP";
  const root = path.join(projectDir, kind);
  const revisionRoot = path.join(root, revision);
  const destination = path.join(revisionRoot, `project-${name}`);
  for (const directory of [root, revisionRoot]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(directory)).isDirectory()) throw new Error(`${label} storage must use regular directories`);
  }
  let exists = false;
  try { await fs.lstat(destination); exists = true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!exists) {
    const staging = await fs.mkdtemp(path.join(revisionRoot, ".stage-"));
    try {
      for (const [file, contents] of Object.entries(files)) {
        const target = path.join(staging, file);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, contents, { flag: "wx", mode: file.startsWith("scripts/") ? 0o700 : 0o600 });
      }
      await fs.rename(staging, destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
      });
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
  const found: string[] = [];
  async function verify(directory: string, relative = ""): Promise<void> {
    if (!(await fs.lstat(directory)).isDirectory()) throw new Error(`${label} revision is not a regular directory`);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await verify(target, file);
      else if (entry.isFile() && Object.hasOwn(files, file) && await fs.readFile(target, "utf8") === files[file]) found.push(file);
      else throw new Error(`${label} revision was modified outside apply_workflow: ${name}`);
    }
  }
  await verify(destination);
  if (found.length !== Object.keys(files).length) throw new Error(`${label} revision is incomplete: ${name}`);
  return destination;
}
