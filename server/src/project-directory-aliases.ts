import path from "node:path";

/** Explicit deployment paths only; never infer a project or native session. */
export function validateProjectDirectoryAliases(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Project directory aliases must be an object");
  }
  const entries = Object.entries(value);
  for (const [projectId, directory] of entries) {
    if (!/^prj_[a-f0-9]{32}$/.test(projectId) || typeof directory !== "string" ||
        !path.isAbsolute(directory) || path.basename(directory) !== projectId ||
        path.normalize(directory) !== directory) {
      throw new Error("Project directory aliases require a project id and its normalized absolute directory");
    }
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}
