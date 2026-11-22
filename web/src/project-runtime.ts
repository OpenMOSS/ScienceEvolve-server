import type { Project, ProjectRuntimeProjection } from "./types";
import { agentDisplayState, agentProgressState, runtimeDisplayState } from "../../server/src/internal/shared/project-runtime-status.js";

/** Apply one live revision to every Agent badge without mutating the saved workflow. */
export function applyLiveRuntimeSnapshot(project: Project, runtime: ProjectRuntimeProjection): Project {
  if (project.runtime === runtime) return project;
  if ((project.runtime?.stateRevision ?? -1) > runtime.stateRevision) return project;
  // A runtime event contains activity, but only the project snapshot carries its progress.
  if (runtime.status !== project.status || runtime.phase !== project.phase ||
    runtime.currentAgent !== project.currentAgent || runtime.waiting?.reason !== project.runtime?.waiting?.reason) return project;
  const next: Project = { ...project, activeInvocationId: runtime.activeInvocationId, runtime };
  next.agentProgress = Object.fromEntries(project.orchestration.agents.map(({ name }) => {
    const previous = project.agentProgress[name];
    return [name, { ...previous, runs: previous?.runs ?? 0,
      state: agentProgressState(agentDisplayState(next, name, runtimeDisplayState(previous?.state ?? "waiting"))) }];
  }));
  return next;
}

export function mergeProjectSnapshot(current: Project | undefined, snapshot: Project): Project {
  if (current?.id === snapshot.id) {
    const currentRevision = current.runtime?.stateRevision ?? current.collaboration?.stateRevision;
    const nextRevision = snapshot.runtime?.stateRevision ?? snapshot.collaboration?.stateRevision;
    if (currentRevision !== undefined && nextRevision !== undefined && currentRevision !== nextRevision) {
      return currentRevision > nextRevision ? current : snapshot;
    }
    if (current.updatedAt && snapshot.updatedAt && Date.parse(current.updatedAt) > Date.parse(snapshot.updatedAt)) return current;
  }
  return snapshot;
}
