import { promises as fs } from "node:fs";
import path from "node:path";
import type { GitExecutionAuthority, RestrictedWorktreeClosingScope } from "./contracts.js";
import { GitInputError, GitPathViolationError } from "./errors.js";

const PROTECTED_TOP_LEVEL = new Set([".git", ".scienceevolve", ".agents", "runtime", "messages", "workflow", "memory.md"]);

/** Exact repo-relative files, never directories, glob patterns or Git
 * pathspecs. Reject alternate spellings before any descriptor/Git access. */
export function restrictedClosingPaths(execution: Pick<GitExecutionAuthority, "agentId">,
  scope: RestrictedWorktreeClosingScope): string[] {
  if (!["completed-leftovers", "bound-report-memory"].includes(scope.kind) ||
    !/^[0-9a-f]{40}$/i.test(scope.reportHeadSha) || !Array.isArray(scope.paths) ||
    !scope.paths.length || scope.paths.length > 1000) {
    throw new GitInputError("Restricted closing requires its immutable report and an explicit file manifest");
  }
  const memory = `agent-memory/${execution.agentId}/Memory.md`;
  const files = scope.paths.map(file => {
    if (typeof file !== "string" || !file || file.length > 4096 ||
      /[\\\x00-\x1f\x7f:*?\[\]]/.test(file) || file.startsWith("/") ||
      file.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
      PROTECTED_TOP_LEVEL.has(file.split("/")[0]!.toLowerCase()) ||
      file.startsWith("agent-memory/") && file !== memory) {
      throw new GitPathViolationError("Restricted closing path is not an exact owned business file");
    }
    return file;
  });
  if (new Set(files).size !== files.length || files.some(file => files.some(other => other !== file && other.startsWith(`${file}/`)))) {
    throw new GitPathViolationError("Restricted closing manifest contains duplicate or overlapping paths");
  }
  if (scope.kind === "bound-report-memory" && (files.length !== 1 || files[0] !== memory)) {
    throw new GitPathViolationError("Bound-report closing authorizes only the original Agent's Memory.md");
  }
  return [...files].sort();
}

/** Observation only. The writable broker must independently enforce the
 * exact manifest at each operation; this check alone grants no writes. */
export async function assertRestrictedClosingFiles(worktreePath: string, files: readonly string[]): Promise<void> {
  for (const file of files) {
    const parts = file.split("/");
    let current = worktreePath;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]!);
      const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!stat) break; // A deleted file or missing parent remains in the manifest.
      if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
        throw new GitPathViolationError("Restricted closing requires owned regular files without symlink or hard-link aliases");
      }
    }
  }
}

/** Git --raw -z with rename detection disabled enumerates both sides of a
 * rename. Validate modes too: a path match must not authorize a symlink or a
 * submodule. Zero modes represent ordinary additions/deletions. */
export function restrictedClosingDiffPaths(raw: string, authorizedPaths: readonly string[]): string[] {
  const paths = restrictedClosingDiffCandidatePaths(raw);
  if (paths.some(file => !authorizedPaths.includes(file))) throw new GitPathViolationError("Closing head changes a file outside the manager-authorized manifest");
  return paths;
}

/** Read-only discovery of tree-diff names. Callers must still validate exact
 * owned paths and stable filesystem/Git state; these names grant no writes. */
export function restrictedClosingDiffCandidatePaths(raw: string): string[] {
  const entries = raw.split("\0");
  if (entries.pop() !== "") throw new GitInputError("Incomplete restricted closing tree diff");
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 2) {
    const header = entries[index]!;
    const file = entries[index + 1];
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]{40} [0-9a-f]{40} ([AMDT])$/.exec(header);
    if (!match || !file || ![match[1], match[2]].every(mode => ["000000", "100644", "100755"].includes(mode!))) {
      throw new GitInputError("Restricted closing diff includes unsupported or incomplete file changes");
    }
    paths.push(file);
  }
  return [...new Set(paths)].sort();
}
