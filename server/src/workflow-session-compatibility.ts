import { DEFAULT_HARNESS_ID } from "./harness-runtime/registry.js";
import { CollaborationStateError } from "./collaboration-state/errors.js";
import { collaborationSessionBelongsToAgent } from "./internal/shared/collaboration-session-key.js";
import type { ProjectState } from "./types.js";

/** Ephemeral retained runtime facts; never serialize this into a proposal or
 * treat it as evidence that a native process is open or stopped. */
export type WorkflowSessionState = Pick<ProjectState, "agents" | "agentSessions" | "agentSessionIds" | "archivedAgentSessions">;

/** Actual Sessions identify their Harness even if a projected configuration
 * lags. Legacy IDs retain the original configured Harness as before. */
export function boundWorkflowHarnesses(state: WorkflowSessionState, agentId: string): string[] {
  const keys = new Set([...Object.keys(state.agentSessions ?? {}), ...Object.keys(state.agentSessionIds ?? {})]);
  const harnesses = new Set<string>();
  for (const key of keys) {
    if (!collaborationSessionBelongsToAgent(key, agentId)) continue;
    const session = state.agentSessions?.[key];
    if (session?.harnessId) harnesses.add(session.harnessId);
    else if (session || state.agentSessionIds?.[key]) {
      const legacyId = state.agentSessionIds?.[key];
      const archived = legacyId ? state.archivedAgentSessions?.find(entry => entry.agentId === agentId &&
        entry.sessions[key]?.legacyId === legacyId) : undefined;
      const original = archived?.harnessId ?? (state.agents[agentId] ? state.agents[agentId].harness ?? DEFAULT_HARNESS_ID : undefined);
      if (original) harnesses.add(original);
    }
  }
  return [...harnesses].sort();
}

/** Recheck immediately before acceptance, including after asynchronous
 * validation. Never mutate a Session or prevent other compatible edits. */
export function assertWorkflowSessionHarnesses(state: WorkflowSessionState, agents: ProjectState["agents"]): void {
  for (const [name, config] of Object.entries(agents)) {
    const harnesses = boundWorkflowHarnesses(state, name);
    if (harnesses.some(harness => harness !== (config.harness ?? DEFAULT_HARNESS_ID))) throw new CollaborationStateError("UNSAFE_CONFIGURATION",
      `Agent ${name} 的现有 session 属于原 Harness ${harnesses.join("、")}；不能换 Harness 或自动重建 session，请保留 Harness，或显式新建不同名称的 Agent 实体；原 Session 继续保留`);
  }
}
