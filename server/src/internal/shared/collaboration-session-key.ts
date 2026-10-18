import type { AgentRunRequest } from "../../types.js";

/** Legacy collaboration roles have distinct persisted native bindings. v3
 * keeps one Agent session through its changing Worker/Leader roles. Neither
 * policy allows the runtime to replace the Agent's retained memory. */
export function collaborationSessionKey(
  agentId: string,
  context: AgentRunRequest["executionContext"],
  scoped = false
): string {
  if (scoped) return agentId;
  if (!context) return `${agentId}::collaboration:unscoped`;
  const scope = ("executionId" in context ? context.executionId : undefined) ??
    ("routeScopeId" in context ? context.routeScopeId : undefined) ??
    ("groupRunId" in context ? context.groupRunId : undefined) ?? context.nodeRunId;
  return `${agentId}::collaboration:${context.role}:${scope}`;
}

/** Match the exact persisted namespace produced above, including legacy roles.
 * Agent names cannot contain the namespace separator. */
export function collaborationSessionBelongsToAgent(sessionKey: string, agentId: string): boolean {
  return sessionKey === agentId || sessionKey.startsWith(`${agentId}::collaboration:`);
}
