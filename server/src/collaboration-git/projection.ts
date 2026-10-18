import type { ExecutionId } from "../types.js";
import type {
  GitHubPullRequestFact,
  GitHubRefFact,
  GitHubRepositoryFact,
  ReadonlyGitProjection
} from "./contracts.js";
import { GitInputError } from "./errors.js";

export interface ReadonlyProjectionInput {
  repository?: GitHubRepositoryFact;
  repositoryStatus?: "ready" | "waiting_for_github" | "failed";
  refs?: Array<GitHubRefFact & {
    base?: string;
    ownerExecutionId?: ExecutionId;
    lifecycleStatus?: string;
  }>;
  pullRequests?: GitHubPullRequestFact[];
  blockers?: readonly string[];
  observedAt?: string;
}

function credentialFreeHttps(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GitInputError(`${label} is invalid`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new GitInputError(`${label} must be credential-free HTTPS`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function iso(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new GitInputError(`${label} is invalid`);
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Credential-free UI/API projection. It deliberately contains no callable
 * mutation, clone URL, local path, operation callback, credential, or token.
 */
export function readonlyGitProjection(
  input: ReadonlyProjectionInput
): ReadonlyGitProjection {
  const repositoryUrl = input.repository
    ? credentialFreeHttps(input.repository.htmlUrl, "repository URL")
    : undefined;
  const pullRequests = (input.pullRequests ?? [])
    .map((pull) => {
      const htmlUrl = credentialFreeHttps(pull.htmlUrl, "pull request URL");
      return {
        id: pull.id,
        providerNumber: pull.providerNumber,
        htmlUrl,
        diffUrl: `${htmlUrl}/files`,
        head: pull.head,
        base: pull.base,
        ownerExecutionId: pull.ownerExecutionId,
        status: pull.status,
        ...(pull.mergeable !== undefined ? { mergeable: pull.mergeable } : {}),
        ...(pull.mergeCommitSha ? { mergeCommitSha: pull.mergeCommitSha } : {}),
        checks: pull.checks.map((check) => ({ ...check })),
        observedAt: iso(pull.observedAt, "pull request observedAt")
      };
    })
    .sort((left, right) => left.providerNumber - right.providerNumber);
  const commitShas = new Set<string>();
  for (const ref of input.refs ?? []) {
    if (ref.sha) commitShas.add(ref.sha);
  }
  for (const pull of pullRequests) {
    if (pull.mergeCommitSha) commitShas.add(pull.mergeCommitSha);
  }
  const observedValues = [
    input.observedAt,
    input.repository?.observedAt,
    ...(input.refs ?? []).map((item) => item.observedAt),
    ...pullRequests.map((item) => item.observedAt)
  ].filter((value): value is string => Boolean(value));
  const observedAt = observedValues.length > 0
    ? observedValues.sort((left, right) => left.localeCompare(right)).at(-1)!
    : new Date(0).toISOString();
  iso(observedAt, "projection observedAt");

  const projection: ReadonlyGitProjection = {
    ...(input.repository && repositoryUrl
      ? {
          repository: {
            owner: input.repository.owner,
            name: input.repository.name,
            htmlUrl: repositoryUrl,
            private: input.repository.private,
            defaultBranch: "main",
            status: input.repositoryStatus ?? "ready"
          }
        }
      : {}),
    branches: (input.refs ?? [])
      .map((ref) => ({
        name: ref.ref,
        ...(ref.sha ? { head: ref.sha } : {}),
        ...(ref.base ? { base: ref.base } : {}),
        ...(ref.ownerExecutionId ? { ownerExecutionId: ref.ownerExecutionId } : {}),
        status: ref.lifecycleStatus ?? ref.status,
        observedAt: iso(ref.observedAt, "branch observedAt")
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    pullRequests,
    commits: [...commitShas]
      .sort()
      .map((sha) => ({
        sha,
        ...(repositoryUrl ? { htmlUrl: `${repositoryUrl}/commit/${sha}` } : {})
      })),
    blockers: [...new Set(input.blockers ?? [])]
      .map((blocker) => blocker.trim())
      .filter(Boolean)
      .sort(),
    observedAt
  };
  return clone(projection);
}
