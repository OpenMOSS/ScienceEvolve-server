import type { Project, ProjectRuntimeProjection } from "./types";
import { agentDisplayState, agentProgressState, runtimeDisplayState } from "../../server/src/internal/shared/project-runtime-status.js";

/** Apply one live revision to every Agent badge without mutating the saved workflow. */
export function applyLiveRuntimeSnapshot(project: Project, runtime: ProjectRuntimeProjection): Project {
  if (project.runtime === runtime) return project;
  if ((project.runtime?.stateRevision ?? -1) > runtime.stateRevision) return project;
  const next: Project = { ...project, status: runtime.status, phase: runtime.phase,
    currentAgent: runtime.currentAgent,
    queuedAgent: runtime.status === "queued" ? runtime.currentAgent : undefined,
    activeInvocationId: runtime.activeInvocationId, runtime };
  next.agentProgress = Object.fromEntries(project.orchestration.agents.map(({ name }) => {
    const previous = project.agentProgress[name];
    return [name, { ...previous, runs: previous?.runs ?? 0,
      state: agentProgressState(agentDisplayState(next, name, runtimeDisplayState(previous?.state ?? "waiting"))) }];
  }));
  return next;
}

export function mergeProjectSnapshot(current: Project | undefined, snapshot: Project): Project {
  if (current?.id === snapshot.id && current.runtime && snapshot.runtime &&
    current.runtime.stateRevision > snapshot.runtime.stateRevision) return current;
  return snapshot;
}
