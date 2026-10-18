import type { GitHubCredential, GitHubCredentialResolver } from "./contracts.js";
import { GitHubAuthorizationError } from "./errors.js";

/** The API and Git transport must resolve the same project-bound credential. */
export async function resolveGitHubCredential(
  resolver: GitHubCredentialResolver,
  signal?: AbortSignal
): Promise<GitHubCredential> {
  let credential: GitHubCredential;
  try {
    credential = await resolver(signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw new GitHubAuthorizationError(
      error instanceof GitHubAuthorizationError && error.publicData.status === 403 ? 403 : 401,
      "GitHub credential could not be resolved"
    );
  }
  signal?.throwIfAborted();
  if (typeof credential.token !== "string" || !credential.token || /[\0\r\n]/.test(credential.token) || credential.token.length > 8_192) {
    throw new GitHubAuthorizationError(401, "GitHub credential is unavailable");
  }
  const requested = [...new Set(credential.requestedScopes.map((scope) => scope.trim().toLowerCase()))];
  if (!requested.includes("repo") || requested.includes("workflow")) {
    throw new GitHubAuthorizationError(
      403,
      "OpenFARS GitHub authorization must request repo and must not request workflow"
    );
  }
  return { token: credential.token, requestedScopes: requested };
}
