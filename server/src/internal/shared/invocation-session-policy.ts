export type SharedInvocationKind = "main" | "worker";

export interface InvocationSessionPolicy {
  durableSession: boolean;
  /** Codex goals persist outside an ephemeral Worker turn and must be disabled there. */
  disableCodexGoals: boolean;
}

/** Derive persistence-related behavior once, before a Harness translates it. */
export function deriveInvocationSessionPolicy(
  kind: SharedInvocationKind,
  sessionPersistence: boolean
): InvocationSessionPolicy {
  const durableSession = kind === "main" || sessionPersistence;
  return {
    durableSession,
    disableCodexGoals: kind === "worker" && !sessionPersistence
  };
}
