import { createHash } from "node:crypto";
import path from "node:path";
import type { ControlAction } from "../types.js";
import type { GitCommandResult } from "./contracts.js";
import { GitInputError, GitPathViolationError } from "./errors.js";

export type GitInspectionRequest = Extract<ControlAction, { tool: "git_log" | "git_show" | "git_diff" }>;
export type InspectionCommand = (args: readonly string[], acceptedExitCodes?: readonly number[]) => Promise<GitCommandResult>;

export function parseGitInspectionRequest(tool: string, args: Record<string, unknown>, mcp = false): GitInspectionRequest {
  const fields: Record<string, string[]> = { git_log: ["revision", "offset", "limit"],
    git_show: ["commit", "offset", "maxBytes", "expectedVersion"],
    git_diff: ["mode", "from", "to", "expectedHead", "offset", "maxBytes", "expectedVersion"] };
  const allowed = fields[tool];
  if (!allowed || Object.keys(args).some(key => !allowed.includes(key) && key !== "tool" && !(mcp && key === "callId"))) {
    throw new GitInputError("Unexpected Git inspection field");
  }
  for (const key of ["revision", "commit", "from", "to", "expectedHead"]) {
    if (args[key] !== undefined) completeCommitSha(args[key] as string);
  }
  for (const [key, min, max] of [["offset", 0, Number.MAX_SAFE_INTEGER], ["limit", 1, 100], ["maxBytes", 4, 262144]] as const) {
    if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || Number(args[key]) < min || Number(args[key]) > max)) throw new GitInputError(`Invalid ${key}`);
  }
  if (args.expectedVersion !== undefined && (typeof args.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(args.expectedVersion))) {
    throw new GitInputError("expectedVersion must be the exact returned Git output version");
  }
  if (tool === "git_show" && args.commit === undefined) throw new GitInputError("commit is required");
  if (tool === "git_diff" && (!["workspace", "staged", "revisions"].includes(String(args.mode)) ||
    (args.mode === "revisions" ? args.from === undefined || args.to === undefined : args.from !== undefined || args.to !== undefined))) {
    throw new GitInputError("Choose a diff mode; revisions requires two explicit commits");
  }
  return { tool, ...Object.fromEntries(allowed.filter(key => args[key] !== undefined).map(key => [key, args[key]])) } as GitInspectionRequest;
}

export function completeCommitSha(value: string): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) {
    throw new GitInputError("Choose a complete commit SHA from the authorized Git history");
  }
  return value.toLowerCase();
}

/** Every project workspace file can be versioned; Git's own metadata and
 * paths escaping the current worktree remain outside file authority. */
export function assertBusinessGitPaths(paths: readonly string[], agentId: string): void {
  for (const file of paths) {
    const parts = file.split("/");
    if (!file || file.includes("\\") || file.includes("\0") || path.posix.isAbsolute(file) ||
      parts.some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
      throw new GitPathViolationError(`Git change includes a path outside this task's business authority: ${file}`);
    }
  }
}

export function gitOutputPage(value: string, offset = 0, maxBytes = 65536, expectedVersion?: string) {
  const bytes = Buffer.from(value, "utf8");
  const version = createHash("sha256").update(bytes).digest("hex");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > 262144) throw new GitInputError("Invalid Git output page");
  if (expectedVersion !== undefined && expectedVersion !== version) throw new GitInputError("Git output version changed; read a new snapshot");
  if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) throw new GitInputError("Git output offset splits a UTF-8 character; use nextOffset");
  let end = Math.min(bytes.length, offset + maxBytes);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return { content: bytes.subarray(offset, end).toString("utf8"), encoding: "utf8", offset,
    nextOffset: end, totalBytes: bytes.length, eof: end === bytes.length, truncated: end !== bytes.length || offset !== 0, version };
}

export async function authorizedCommit(run: InspectionCommand, sha: string, head: string): Promise<string> {
  const commit = completeCommitSha(sha);
  await run(["cat-file", "-e", `${commit}^{commit}`]);
  const ancestry = await run(["merge-base", "--is-ancestor", commit, head], [0, 1]);
  if (ancestry.code !== 0) throw new GitInputError("Commit is outside the current authorized branch history");
  return commit;
}

export async function inspectGit(input: { run: InspectionCommand; request: GitInspectionRequest;
  head: string; agentId: string; projectId: string; executionId: string; branch: string;
  directBase: string; directBaseHead: string; activationBase?: string }) {
  const { run, request, head } = input;
  const source = { projectId: input.projectId, executionId: input.executionId, branch: input.branch,
    head, directBase: input.directBase, directBaseHead: input.directBaseHead, activationBase: input.activationBase };
  if (request.tool === "git_log") {
    const revision = request.revision === undefined ? head : await authorizedCommit(run, request.revision, head);
    const offset = request.offset ?? 0, limit = request.limit ?? 50;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new GitInputError("Invalid Git history page");
    }
    const raw = await run(["log", "--date-order", `--skip=${offset}`, `-n${limit + 1}`,
      "--format=%H%x00%P%x00%an%x00%aI%x00%s%x00", revision, "--"]);
    const fields = raw.stdout.split("\0"), commits = [];
    for (let i = 0; i + 4 < fields.length; i += 5) {
      const sha = fields[i]!.trim();
      if (!sha) break;
      commits.push({ sha: completeCommitSha(sha), parents: fields[i + 1]!.split(" ").filter(Boolean),
        author: fields[i + 2], authoredAt: fields[i + 3], subject: fields[i + 4] });
    }
    const eof = commits.length <= limit;
    return { ...source, revision, offset, commits: commits.slice(0, limit), eof,
      nextOffset: offset + Math.min(commits.length, limit), observedAt: new Date().toISOString() };
  }
  if (request.tool === "git_show") {
    const commit = await authorizedCommit(run, request.commit, head);
    const metadata = (await run(["show", "-s", "--format=%H%x00%P%x00%an%x00%aI%x00%B", commit, "--"])).stdout.split("\0");
    const parents = metadata[1]!.split(" ").filter(Boolean);
    const options = parents[0] ? ["diff", parents[0], commit] : ["show", "--format=", commit];
    const files = (await run([...options, "--no-renames", "--name-only", "-z", "--"])).stdout.split("\0").filter(Boolean);
    assertBusinessGitPaths(files, input.agentId);
    const patch = (await run([...options, "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", "--"])).stdout;
    return { ...source, commit, parents, author: metadata[2], authoredAt: metadata[3], subject: metadata[4]!.split("\n")[0], message: metadata[4]!.trimEnd(),
      patchRelativeTo: parents[0] ?? null, files, ...gitOutputPage(patch, request.offset, request.maxBytes, request.expectedVersion) };
  }
  if (!["workspace", "staged", "revisions"].includes(request.mode)) throw new GitInputError("Choose workspace, staged or revisions diff");
  if (request.expectedHead !== undefined && completeCommitSha(request.expectedHead) !== head) throw new GitInputError("Git HEAD changed");
  const args = ["diff"];
  let from: string | undefined, to: string | undefined;
  if (request.mode === "revisions") {
    if (!request.from || !request.to) throw new GitInputError("Revision diff requires two complete commit SHAs");
    from = await authorizedCommit(run, request.from, head); to = await authorizedCommit(run, request.to, head);
    args.push(from, to);
  } else {
    if (request.from !== undefined || request.to !== undefined) throw new GitInputError("Revision arguments require mode=revisions");
    if (request.mode === "staged") args.push("--cached", head);
  }
  const files = (await run([...args, "--no-renames", "--name-only", "-z", "--"])).stdout.split("\0").filter(Boolean);
  assertBusinessGitPaths(files, input.agentId);
  const patch = (await run([...args, "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", "--"])).stdout;
  return { ...source, mode: request.mode, from: from ?? (request.mode === "staged" ? head : "index"),
    to: to ?? (request.mode === "staged" ? "index" : "workspace"), files,
    ...gitOutputPage(patch, request.offset, request.maxBytes, request.expectedVersion) };
}
