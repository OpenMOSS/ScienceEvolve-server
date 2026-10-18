import { isDeepStrictEqual } from "node:util";
import { DEFAULT_HARNESS_ID } from "./harness-runtime/registry.js";
import { validateSessionRef } from "./harness-runtime/session-ref.js";
import { collaborationSessionBelongsToAgent } from "./internal/shared/collaboration-session-key.js";
import type { ArchivedWorkflowAgentSessions, ProjectState } from "./types.js";

/** Configuration retirement records existing bindings. It neither opens nor
 * stops a native process, and never moves or deletes the original files. */
export function archiveRemovedWorkflowAgentSessions(state: ProjectState, nextAgents: ProjectState["agents"], workflowRevision: number): void {
  const archived = [...(state.archivedAgentSessions ?? [])];
  for (const [agentId, config] of Object.entries(state.agents)) {
    if (nextAgents[agentId]) continue;
    const sessions: ArchivedWorkflowAgentSessions["sessions"] = {};
    const keys = new Set([...Object.keys(state.agentSessions ?? {}), ...Object.keys(state.agentSessionIds ?? {})]);
    for (const key of [...keys].sort()) {
      if (!collaborationSessionBelongsToAgent(key, agentId)) continue;
      const session = state.agentSessions?.[key], legacyId = state.agentSessionIds?.[key];
      if (!session && !legacyId) continue;
      sessions[key] = { ...(session ? { session: structuredClone(session) } : {}), ...(legacyId ? { legacyId } : {}) };
    }
    const definition = state.orchestration.agents.find(agent => agent.name === agentId);
    if (!Object.keys(sessions).length && !definition) continue;
    const entry: ArchivedWorkflowAgentSessions = { agentId, harnessId: config.harness ?? DEFAULT_HARNESS_ID,
      workflowRevision, sessions, ...(definition ? { definition: structuredClone(definition) } : {}),
      ...(state.agentSessionMeta?.[agentId] ? { meta: structuredClone(state.agentSessionMeta[agentId]) } : {}) };
    if (!archived.some(previous => isDeepStrictEqual(previous, entry))) archived.push(entry);
  }
  if (archived.length) state.archivedAgentSessions = archived;
}

export function removedWorkflowAgentTaskReason(state: ProjectState, nextAgents: ProjectState["agents"]): string | undefined {
  const agent = [state.activeAgentExecution?.agent, state.currentAgent, state.queuedAgent].find(id => id && !nextAgents[id]);
  return agent ? `等待显式处理被删除 Agent ${agent} 的原未结束任务或排队调用；保留原任务、会话和预算` : undefined;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function validArchivedWorkflowAgentSessions(value: unknown): value is ArchivedWorkflowAgentSessions[] {
  if (!Array.isArray(value)) return false;
  return value.every(entry => {
    if (!record(entry) || typeof entry.agentId !== "string" ||
      !/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u.test(entry.agentId) || ["input", "finish", "user"].includes(entry.agentId) ||
      typeof entry.harnessId !== "string" || !entry.harnessId.trim() || typeof entry.workflowRevision !== "number" ||
      !Number.isSafeInteger(entry.workflowRevision) || entry.workflowRevision < 1 || !record(entry.sessions)) return false;
    if (!Object.keys(entry.sessions).length && (!record(entry.definition) || entry.definition.name !== entry.agentId)) return false;
    for (const [key, binding] of Object.entries(entry.sessions)) {
      const scoped = /^(.+)::collaboration:(leader|delivery|final-integration):(.+)$/.exec(key);
      if (key !== entry.agentId && !(scoped && scoped[1] === entry.agentId && scoped[3].trim())) return false;
      if (!record(binding) || binding.session === undefined && binding.legacyId === undefined ||
        binding.session !== undefined && !validateSessionRef(binding.session).valid ||
        binding.legacyId !== undefined && (typeof binding.legacyId !== "string" || !binding.legacyId.trim())) return false;
    }
    if (entry.definition !== undefined && (!record(entry.definition) || entry.definition.name !== entry.agentId)) return false;
    if (entry.meta !== undefined) {
      if (!record(entry.meta)) return false;
      for (const key of ["generation", "contextSeq", "resumeFailureCount"]) {
        const field = entry.meta[key];
        if (field !== undefined && (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0)) return false;
      }
    }
    return true;
  });
}

/** A retired key is readable only when its exact original binding was kept. */
export function archivedWorkflowSessionMatches(archive: ArchivedWorkflowAgentSessions[] | undefined, key: string, session: unknown, legacyId?: string): boolean {
  return !!archive?.some(entry => {
    const binding = entry.sessions[key];
    return binding && (session === undefined || isDeepStrictEqual(binding.session, session)) &&
      (legacyId === undefined || binding.legacyId === legacyId);
  });
}
