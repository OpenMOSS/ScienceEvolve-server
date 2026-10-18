import type { DisplaySelection, HandoffRecord, Project } from "./types";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Adapt accepted Git turn results to the same read model as serial handoffs. */
export function acceptedGitHandoff(source: {
  git?: unknown; taskCompletions?: unknown; scopedAgentReports?: unknown; scopedExecutions?: unknown;
}): HandoffRecord | undefined {
  if (record(source.git).enabled !== true) return;
  const candidates: HandoffRecord[] = [];
  const add = (agent: unknown, invocationId: unknown, markdown: unknown, updatedAt: unknown) => {
    if (typeof agent !== "string" || !agent || typeof invocationId !== "string" || !invocationId ||
      typeof markdown !== "string" || !markdown.trim() || typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))) return;
    candidates.push({ agent, invocationId, markdown, excerpt: markdown.replace(/\s+/g, " ").trim().slice(0, 240), updatedAt });
  };
  for (const value of Object.values(record(source.taskCompletions))) {
    const completion = record(value);
    if (completion.status === "accepted") add(completion.agent, completion.invocationId, completion.summary, completion.acceptedAt);
  }
  const executions = Array.isArray(source.scopedExecutions) ? source.scopedExecutions.map(record) : [];
  for (const value of Array.isArray(source.scopedAgentReports) ? source.scopedAgentReports : []) {
    const report = record(value);
    const execution = executions.find(item => item.id === report.executionId && item.ownershipEpoch === report.ownershipEpoch && item.status === "completed");
    if (execution) add(execution.agentId, report.invocationId, report.output, report.recordedAt);
  }
  return candidates.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

/** Explicit display choices win; completed projects also expose their publications. */
export function projectResultSelection(project: Project): DisplaySelection | undefined {
  if (project.display) return project.display;
  if (project.status !== "completed" || project.orchestration.resultFormat?.none) return;
  const items = (project.artifacts ?? []).filter(artifact => artifact.agent && artifact.path &&
    !artifact.path.startsWith("/") && !/^[A-Za-z]:/.test(artifact.path) &&
    !artifact.path.replaceAll("\\", "/").split("/").some(segment => segment.startsWith(".")) &&
    (project.git?.enabled ? !!artifact.id && /^[a-f0-9]{40,64}$/.test(artifact.commitSha ?? "") : !!artifact.sha256)
  ).sort((left, right) => Number(right.agent === project.orchestration.termination.agent) - Number(left.agent === project.orchestration.termination.agent) ||
    (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")
  ).map(artifact => ({ agent: artifact.agent!, path: artifact.path, title: artifact.title || artifact.name,
    ...(project.git?.enabled ? { artifactId: artifact.id, commitSha: artifact.commitSha } : {}) }));
  return items[0] ? { primary: items[0], items: items.slice(1) } : undefined;
}
