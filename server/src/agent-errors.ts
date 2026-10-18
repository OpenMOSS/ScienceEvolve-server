/** Harness-neutral orchestration errors retained for existing retry semantics. */
export class AgentInterruptedError extends Error {
  override name = "AgentInterruptedError";
}

export class AgentTimeoutError extends Error {
  override name = "AgentTimeoutError";
}

export type AgentApiErrorKind = "provider" | "authentication";

export class AgentApiError extends Error {
  override name = "AgentApiError";

  constructor(
    readonly kind: AgentApiErrorKind,
    message: string
  ) {
    super(message);
  }
}

export class AgentAuthenticationError extends AgentApiError {
  override name = "AgentAuthenticationError";

  constructor(message: string) {
    super("authentication", message);
  }
}

/** A deterministic local request/schema problem; retrying cannot help. */
export class AgentRequestConfigurationError extends Error {
  override name = "AgentRequestConfigurationError";
}
