import type { CollaborationGitOperationStore, GitHubCredentialResolver } from "./contracts.js";
import { CollaborationGitFacade } from "./facade.js";
import { GitHubUserProvider } from "./github-provider.js";
import { LocalCollaborationGitService, type LocalGitServiceOptions } from "./local-git.js";
import { gitCredentialHelperResolver } from "./credential-helper.js";
import { ExecFileGitCommandRunner } from "./command-runner.js";

export interface CollaborationGitFactoryOptions {
  projectId: string;
  projectRoot: string;
  operationStore: CollaborationGitOperationStore;
  /** Only scoped v3 projects opt in; legacy projects keep execution worktrees. */
  worktreeMode?: "execution" | "agent";
  initialTree?: LocalGitServiceOptions["initialTree"];
  credentialResolver?: GitHubCredentialResolver;
  expectedIdentity?: { id: number; login: string };
  fetch?: typeof globalThis.fetch;
  now?: () => string;
}

/** Production composition boundary; tests may inject fetch or credentials. */
export function createCollaborationGitFacade(
  options: CollaborationGitFactoryOptions
): CollaborationGitFacade {
  const credentialResolver = options.credentialResolver ?? gitCredentialHelperResolver();
  const localGit = new LocalCollaborationGitService({
    projectId: options.projectId,
    projectRoot: options.projectRoot,
    operationStore: options.operationStore,
    runner: new ExecFileGitCommandRunner({ credentialResolver }),
    ...(options.worktreeMode ? { worktreeMode: options.worktreeMode } : {}),
    ...(options.initialTree ? { initialTree: options.initialTree } : {}),
    ...(options.now ? { now: options.now } : {})
  });
  const provider = new GitHubUserProvider({
    credentialResolver,
    ...(options.expectedIdentity ? { expectedIdentity: options.expectedIdentity } : {}),
    operationStore: options.operationStore,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {})
  });
  return new CollaborationGitFacade({ localGit, provider, operationStore: options.operationStore });
}
