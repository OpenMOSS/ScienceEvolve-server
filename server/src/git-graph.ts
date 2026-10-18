import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import type { ProjectState, PullRequestRecord } from "./types.js";

const execFileAsync = promisify(execFile);

export const GIT_GRAPH_EMPTY_REASONS = [
  "git_disabled",
  "repository_uninitialized",
  "repository_initializing",
  "repository_failed",
  "before_first_assignment",
  "branch_without_commits",
  "commits_without_pull_request"
] as const;

export type GitGraphEmptyReason = (typeof GIT_GRAPH_EMPTY_REASONS)[number];

export interface GitGraphPullRequest {
  id: string;
  number: number;
  status: PullRequestRecord["status"];
  htmlUrl: string;
  role: "head" | "merge";
}

export interface GitGraphChangedFile {
  path: string;
  status: string;
}

export interface GitGraphCommit {
  sha: string;
  parents: string[];
  subject: string;
  body?: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committerName: string;
  committerEmail: string;
  committedAt: string;
  refs: string[];
  trailers: Record<string, string>;
  agentId?: string;
  taskId?: string;
  executionId?: string;
  groupRunId?: string;
  pullRequests: GitGraphPullRequest[];
  changedFiles: GitGraphChangedFile[];
  htmlUrl?: string;
  system: boolean;
}

export interface GitGraphPage {
  commits: GitGraphCommit[];
  refs: Array<{ name: string; sha: string }>;
  emptyReason?: GitGraphEmptyReason;
  nextCursor?: string;
  repositoryUrl?: string;
  githubActor?: string;
  observedAt: string;
}

const INITIALIZING_GIT_STATUSES = new Set([
  "authorizing",
  "creating_repository",
  "initializing_local",
  "pushing_main",
  "waiting_for_github"
]);

function repositoryReason(project: ProjectState): GitGraphEmptyReason {
  if (!project.git?.enabled || project.git.status === "disabled") return "git_disabled";
  if (project.git.status === "failed") return "repository_failed";
  if (INITIALIZING_GIT_STATUSES.has(project.git.status)) return "repository_initializing";
  return "repository_uninitialized";
}

function emptyPage(project: ProjectState, emptyReason: GitGraphEmptyReason): GitGraphPage {
  return {
    commits: [],
    refs: [],
    emptyReason,
    ...(project.git?.repository?.htmlUrl
      ? { repositoryUrl: project.git.repository.htmlUrl }
      : {}),
    ...(project.git?.account?.login ? { githubActor: project.git.account.login } : {}),
    observedAt: new Date().toISOString()
  };
}

function graphExplanation(
  project: ProjectState,
  commits: readonly GitGraphCommit[]
): GitGraphEmptyReason | undefined {
  const repositoryState = repositoryReason(project);
  if (repositoryState === "git_disabled" ||
      repositoryState === "repository_initializing" ||
      repositoryState === "repository_failed") {
    return repositoryState;
  }
  if (!commits.length) return "repository_uninitialized";

  const assignmentStarted = (project.tasks ?? []).some((task) => Boolean(task.assigneeAgentId)) ||
    (project.executions ?? []).length > 0 ||
    (project.git?.branches ?? []).some((branch) => Boolean(branch.ownerExecutionId));
  if (!assignmentStarted) return "before_first_assignment";

  const businessCommits = commits.filter((commit) =>
    Boolean(commit.agentId || commit.taskId || commit.executionId || commit.groupRunId)
  );
  if (!businessCommits.length) return "branch_without_commits";
  if (!(project.pullRequests?.length ?? 0)) return "commits_without_pull_request";
  return undefined;
}

function isMissingRepository(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    timeout: 20_000
  });
  return result.stdout;
}

function trailers(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^(OpenFARS-[A-Za-z-]+):\s*(.+)$/);
    if (match) result[match[1]!] = match[2]!.trim().slice(0, 2_000);
  }
  return result;
}

function refLabel(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
  if (ref.startsWith("refs/tags/")) return `tag:${ref.slice("refs/tags/".length)}`;
  return ref;
}

function pullRequestsForCommit(
  project: ProjectState,
  sha: string
): GitGraphPullRequest[] {
  const result: GitGraphPullRequest[] = [];
  for (const pull of project.pullRequests ?? []) {
    if (pull.headSha === sha) result.push({
      id: pull.id,
      number: pull.providerNumber,
      status: pull.status,
      htmlUrl: pull.htmlUrl,
      role: "head"
    });
    if (pull.mergeCommitSha === sha) result.push({
      id: pull.id,
      number: pull.providerNumber,
      status: pull.status,
      htmlUrl: pull.htmlUrl,
      role: "merge"
    });
  }
  return result;
}

/** Read only from the server-owned repository path; no client path or ref is accepted. */
export async function readProjectGitGraph(
  project: ProjectState,
  options: { limit: number; cursor?: string; includeTechnical?: boolean }
): Promise<GitGraphPage> {
  const repositoryPath = project.git?.repository?.localPath;
  if (!project.git?.enabled || !repositoryPath) return emptyPage(project, repositoryReason(project));
  const repository = project.git.repository;
  if (!repository) return emptyPage(project, repositoryReason(project));
  let resolved: string;
  let stat;
  try {
    resolved = await fs.realpath(repositoryPath);
    stat = await fs.stat(resolved);
  } catch (error) {
    if (isMissingRepository(error)) return emptyPage(project, repositoryReason(project));
    throw error;
  }
  if (!stat.isDirectory()) throw new Error("Project Git repository path is not a directory");
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit)));
  const offset = options.cursor ? Number.parseInt(options.cursor, 10) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid Git graph cursor");

  const refOutput = await git(resolved, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)",
    "refs/heads",
    "refs/remotes",
    "refs/tags"
  ]);
  const refs = refOutput.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf("\t");
    if (separator <= 0) return [];
    const name = refLabel(line.slice(0, separator));
    if (name === "origin/HEAD") return [];
    return [{ name, sha: line.slice(separator + 1).trim() }];
  });
  const refsBySha = new Map<string, string[]>();
  for (const ref of refs) refsBySha.set(ref.sha, [...(refsBySha.get(ref.sha) ?? []), ref.name]);

  const rawLimit = options.includeTechnical ? limit + 1 : Math.min(601, limit * 3 + 1);
  let output = "";
  try {
    output = await git(resolved, [
      "log",
      "--all",
      "--topo-order",
      "--date-order",
      `--skip=${offset}`,
      `-n${rawLimit}`,
      "--no-renames",
      "--name-status",
      "--pretty=format:%x1e%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%b%x00"
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("does not have any commits") && !message.includes("unknown revision")) throw error;
  }

  const parsed = output.split("\x1e").slice(1).flatMap((rawRecord): GitGraphCommit[] => {
    const record = rawRecord.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    const fields = record.split("\0");
    if (fields.length < 9) return [];
    const [sha, parentText, authorName, authorEmail, authoredAt, committerName, committerEmail, committedAt, subject, body = "", changedFileText = ""] = fields;
    if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) return [];
    const parsedTrailers = trailers(body);
    const authorAgent = authorName.match(/^OpenFARS Agent (.+)$/)?.[1];
    const associatedPullRequests = pullRequestsForCommit(project, sha);
    const associatedPull = associatedPullRequests[0]
      ? (project.pullRequests ?? []).find((pull) => pull.id === associatedPullRequests[0]!.id)
      : undefined;
    const associatedExecution = associatedPull
      ? (project.executions ?? []).find((execution) => execution.id === associatedPull.ownerExecutionId)
      : undefined;
    const commit: GitGraphCommit = {
      sha,
      parents: parentText ? parentText.split(" ").filter(Boolean) : [],
      subject: subject || "（无提交说明）",
      ...(body.trim() ? { body: body.trim().slice(0, 20_000) } : {}),
      authorName: authorName || "Unknown",
      authorEmail: authorEmail || "",
      authoredAt: authoredAt || committedAt || project.updatedAt,
      committerName: committerName || "Unknown",
      committerEmail: committerEmail || "",
      committedAt: committedAt || authoredAt || project.updatedAt,
      refs: (refsBySha.get(sha) ?? []).sort(),
      trailers: parsedTrailers,
      ...(parsedTrailers["OpenFARS-Agent"] || authorAgent || associatedExecution?.agentId
        ? { agentId: parsedTrailers["OpenFARS-Agent"] ?? authorAgent ?? associatedExecution?.agentId }
        : {}),
      ...(parsedTrailers["OpenFARS-Task"] || associatedExecution?.taskId
        ? { taskId: parsedTrailers["OpenFARS-Task"] ?? associatedExecution?.taskId }
        : {}),
      ...(parsedTrailers["OpenFARS-Execution"] || associatedExecution?.id
        ? { executionId: parsedTrailers["OpenFARS-Execution"] ?? associatedExecution?.id }
        : {}),
      ...(parsedTrailers["OpenFARS-Group"] || associatedExecution?.groupRunId
        ? { groupRunId: parsedTrailers["OpenFARS-Group"] ?? associatedExecution?.groupRunId }
        : {}),
      pullRequests: associatedPullRequests,
      changedFiles: changedFileText.split(/\r?\n/).flatMap((line) => {
        const match = line.trim().match(/^([^\t]+)\t(.+)$/);
        if (!match) return [];
        return [{ status: match[1]!.slice(0, 16), path: match[2]!.slice(0, 1_000) }];
      }).slice(0, 300),
      ...(repository.htmlUrl
        ? { htmlUrl: `${repository.htmlUrl.replace(/\/+$/, "")}/commit/${sha}` }
        : {}),
      system: authorName === "OpenFARS Git Service" && (
        subject.startsWith("Update management memory") ||
        (refsBySha.get(sha) ?? []).some((ref) => ref === "management/memory" || ref.endsWith("/management/memory"))
      )
    };
    return [commit];
  });
  const visible = options.includeTechnical ? parsed : parsed.filter((commit) => !commit.system);
  const commits = visible.slice(0, limit);
  const lastCommit = commits.at(-1);
  const consumed = lastCommit
    ? parsed.findIndex((commit) => commit.sha === lastCommit.sha) + 1
    : parsed.length;
  const hasMore = consumed < parsed.length || parsed.length >= rawLimit;
  const emptyReason = offset === 0
    ? graphExplanation(project, parsed.filter((commit) => !commit.system))
    : undefined;
  return {
    commits,
    refs,
    ...(emptyReason ? { emptyReason } : {}),
    ...(hasMore ? { nextCursor: String(offset + Math.max(1, consumed)) } : {}),
    ...(repository.htmlUrl ? { repositoryUrl: repository.htmlUrl } : {}),
    ...(project.git.account?.login ? { githubActor: project.git.account.login } : {}),
    observedAt: new Date().toISOString()
  };
}
