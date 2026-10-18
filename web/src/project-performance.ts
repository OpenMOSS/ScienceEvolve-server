import { useEffect, useMemo, useState } from "react";
import { normalizeInvocationPerformance } from "./lib";
import type { AgentEvent, InvocationPerformance, ProjectPerformance, ProjectStatus } from "./types";

function observedAt(value: InvocationPerformance): number {
  return Date.parse(value.completedAt ?? value.firstTokenAt ?? value.startedAt) || 0;
}

/** Keep measured results across empty live snapshots and request/Agent changes.
 * Active speed is deliberately resolved from the current live snapshot only. */
export function mergePerformanceResults(previous: ProjectPerformance | undefined, snapshot: ProjectPerformance | undefined,
  samples: readonly InvocationPerformance[] = []): ProjectPerformance {
  const records = new Map<string, InvocationPerformance>();
  for (const source of [previous, snapshot]) {
    for (const value of [...(source?.history ?? []), ...Object.values(source?.byAgent ?? {}), ...(source?.latest ? [source.latest] : [])]) {
      merge(value);
    }
  }
  for (const value of samples) merge(value);
  function merge(value: InvocationPerformance) {
    const key = `${value.invocationId}:${value.attempt}:${value.startedAt}`;
    const existing = records.get(key);
    if (existing?.status !== undefined && existing.status !== "active" && value.status === "active") return;
    records.set(key, { ...existing, ...value });
  }
  const ordered = [...records.values()].sort((a, b) => observedAt(a) - observedAt(b));
  const lastMeasurements = new Map<string, InvocationPerformance>();
  for (const value of ordered) {
    const prior = lastMeasurements.get(`${value.agent}:latency`);
    if (value.firstTokenLatencyMs !== undefined && (!prior ||
      (value.firstTokenAt ?? value.startedAt) >= (prior.firstTokenAt ?? prior.startedAt))) {
      lastMeasurements.set(`${value.agent}:latency`, value);
    }
    if (value.averageTokensPerSecond !== undefined) lastMeasurements.set(`${value.agent}:average`, value);
  }
  const history = [...new Set([...lastMeasurements.values(), ...ordered.slice(-100)])].sort((a, b) => observedAt(a) - observedAt(b));
  const aggregate = !previous?.aggregate || (snapshot?.aggregate && snapshot.aggregate.updatedAt >= previous.aggregate.updatedAt)
    ? snapshot?.aggregate : previous.aggregate;
  const aggregateByAgent = { ...previous?.aggregateByAgent };
  for (const [agent, value] of Object.entries(snapshot?.aggregateByAgent ?? {})) {
    if (!aggregateByAgent[agent] || value.updatedAt >= aggregateByAgent[agent]!.updatedAt) aggregateByAgent[agent] = value;
  }
  return { byAgent: Object.fromEntries(history.map((value) => [value.agent, value])), history,
    latest: history.at(-1), ...(aggregate ? { aggregate } : {}), aggregateByAgent };
}

export function resolvePerformanceMetrics(results: ProjectPerformance | undefined, live: InvocationPerformance | undefined,
  status: ProjectStatus, agent?: string) {
  const records = [...(results?.history ?? []), ...Object.values(results?.byAgent ?? {}),
    ...(results?.latest ? [results.latest] : []), ...(live ? [live] : [])].filter((value) => !agent || value.agent === agent);
  const latestToken = records.filter((value) => value.firstTokenLatencyMs !== undefined)
    .sort((a, b) => (Date.parse(a.firstTokenAt ?? a.completedAt ?? a.startedAt) || 0) -
      (Date.parse(b.firstTokenAt ?? b.completedAt ?? b.startedAt) || 0)).at(-1);
  const latestAverage = records.filter((value) => value.averageTokensPerSecond !== undefined)
    .sort((a, b) => observedAt(a) - observedAt(b)).at(-1);
  const aggregate = agent ? results?.aggregateByAgent?.[agent] : results?.aggregate;
  const average = aggregate?.averageTokensPerSecond !== undefined ? aggregate : latestAverage;
  const settled = live && records.some((value) => value.invocationId === live.invocationId && value.attempt === live.attempt &&
    value.status !== "active" && observedAt(value) >= (Date.parse(live.startedAt) || 0));
  const current = status === "running" && live?.status === "active" && live.requestActive !== false &&
    (!agent || live.agent === agent) && !settled ? live : undefined;
  return { current, latestToken, average };
}

export function useProjectPerformance(projectId: string, snapshot: ProjectPerformance | undefined,
  events: readonly AgentEvent[], live: InvocationPerformance | undefined) {
  const [retained, setRetained] = useState<{ projectId: string; results: ProjectPerformance }>();
  const samples = useMemo(() => [
    ...events.flatMap((event) => {
      if (event.projectId && event.projectId !== projectId) return [];
      const performance = normalizeInvocationPerformance(event.data?.performance);
      return performance ? [performance] : [];
    }), ...(live ? [live] : [])
  ], [projectId, events, live]);
  useEffect(() => {
    setRetained((previous) => ({ projectId,
      results: mergePerformanceResults(previous?.projectId === projectId ? previous.results : undefined, snapshot, samples) }));
  }, [projectId, snapshot, samples]);
  return useMemo(() => mergePerformanceResults(retained?.projectId === projectId ? retained.results : undefined, snapshot, samples),
    [retained, projectId, snapshot, samples]);
}
