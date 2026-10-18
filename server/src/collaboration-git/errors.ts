export type CollaborationGitErrorCode =
  | "GIT_INVALID_INPUT"
  | "GIT_PATH_VIOLATION"
  | "GIT_OWNERSHIP_STALE"
  | "GIT_COMMAND_FAILED"
  | "GIT_OPERATION_RESULT_AVAILABLE"
  | "GIT_CONFLICT"
  | "GITHUB_WAITING_FOR_AUTHORIZATION"
  | "GITHUB_PROVIDER_FAILED"
  | "GITHUB_RESULT_UNCERTAIN"
  | "OPERATION_PAYLOAD_MISMATCH"
  | "OPERATION_STORE_VIOLATION";

export class CollaborationGitError extends Error {
  constructor(
    readonly code: CollaborationGitErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly publicData: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CollaborationGitError";
  }
}

export class GitInputError extends CollaborationGitError {
  constructor(message: string, publicData: Readonly<Record<string, unknown>> = {}) {
    super("GIT_INVALID_INPUT", message, false, publicData);
    this.name = "GitInputError";
  }
}

export class GitPathViolationError extends CollaborationGitError {
  constructor(message: string) {
    super("GIT_PATH_VIOLATION", message, false);
    this.name = "GitPathViolationError";
  }
}

export class GitOwnershipStaleError extends CollaborationGitError {
  constructor(executionId: string, ownershipEpoch: number, options?: ErrorOptions) {
    super(
      "GIT_OWNERSHIP_STALE",
      `Execution ${executionId} no longer owns Git writes at epoch ${ownershipEpoch}`,
      false,
      { executionId, ownershipEpoch },
      options
    );
    this.name = "GitOwnershipStaleError";
  }
}

export class GitCommandError extends CollaborationGitError {
  constructor(
    readonly exitCode: number | null,
    message: string,
    publicData: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions
  ) {
    super("GIT_COMMAND_FAILED", message, true, publicData, options);
    this.name = "GitCommandError";
  }
}

export class GitConflictError extends CollaborationGitError {
  constructor(
    readonly conflictPaths: readonly string[],
    publicData: Readonly<Record<string, unknown>> = {}
  ) {
    super(
      "GIT_CONFLICT",
      "Git integration requires resolution by the owning execution",
      false,
      { ...publicData, conflictPaths: [...conflictPaths] }
    );
    this.name = "GitConflictError";
  }
}

export class GitHubAuthorizationError extends CollaborationGitError {
  readonly projectStatus = "waiting_for_github" as const;

  constructor(status: 401 | 403, message = "GitHub authorization is unavailable") {
    super(
      "GITHUB_WAITING_FOR_AUTHORIZATION",
      message,
      true,
      { provider: "github", status }
    );
    this.name = "GitHubAuthorizationError";
  }
}

export class GitHubProviderError extends CollaborationGitError {
  constructor(
    message: string,
    retryable: boolean,
    publicData: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions
  ) {
    super("GITHUB_PROVIDER_FAILED", message, retryable, publicData, options);
    this.name = "GitHubProviderError";
  }
}

export class GitHubUncertainResultError extends CollaborationGitError {
  constructor(
    operationId: string,
    message = "The GitHub mutation result is uncertain and must be reconciled before retry",
    options?: ErrorOptions
  ) {
    super(
      "GITHUB_RESULT_UNCERTAIN",
      message,
      true,
      { operationId, reconcileRequired: true },
      options
    );
    this.name = "GitHubUncertainResultError";
  }
}

export class OperationPayloadMismatchError extends CollaborationGitError {
  constructor(operationId: string) {
    super(
      "OPERATION_PAYLOAD_MISMATCH",
      `Operation ${operationId} was replayed with a different payload`,
      false,
      { operationId }
    );
    this.name = "OperationPayloadMismatchError";
  }
}

export class OperationStoreViolationError extends CollaborationGitError {
  constructor(message: string) {
    super("OPERATION_STORE_VIOLATION", message, false);
    this.name = "OperationStoreViolationError";
  }
}

/** The journal confirms the remote result, separately from this callback's
 * interrupted local work or result transport. Never authorize an automatic retry. */
export class GitOperationResultAvailableError extends CollaborationGitError {
  constructor(operationId: string, status: "completed" | "remote_success_local_pending", localStage: string, options?: ErrorOptions) {
    super("GIT_OPERATION_RESULT_AVAILABLE",
      `The original Git operation has a confirmed remote result (${status}, ${localStage}). Read git_get_operation for ${operationId} before deciding any further action.`,
      status === "remote_success_local_pending", { operationId, status, localStage,
        reconcileRequired: status === "remote_success_local_pending" }, options);
    this.name = "GitOperationResultAvailableError";
  }
}
