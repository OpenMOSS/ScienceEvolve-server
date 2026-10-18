export interface ProjectOverview {
  total: number;
  archived: number;
  totalCycles: number;
  statusCounts: Record<"active" | "attention" | "stopping" | "terminal", number>;
}

function cacheKey(): string {
  const base = (import.meta.env.VITE_API_BASE || ".").replace(/\/$/, "");
  return `scienceevolve:project-overview:v1:${new URL(`${base}/api/projects`, window.location.href).href}`;
}

/** Persist aggregate numbers only; project configurations and credentials stay out of storage. */
export function readCachedProjectOverview(): ProjectOverview | undefined {
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey()) ?? "null");
    if (cached?.version !== 1) return undefined;
    const value = cached.overview;
    const counts = value?.statusCounts;
    const numbers = [value?.total, value?.archived, value?.totalCycles,
      counts?.active, counts?.attention, counts?.stopping, counts?.terminal];
    if (numbers.some((number) => !Number.isSafeInteger(number) || number < 0)) return undefined;
    if (counts.active + counts.attention + counts.stopping + counts.terminal !== value.total) return undefined;
    return { total: value.total, archived: value.archived, totalCycles: value.totalCycles,
      statusCounts: { active: counts.active, attention: counts.attention, stopping: counts.stopping, terminal: counts.terminal } };
  } catch {
    return undefined;
  }
}

export function cacheProjectOverview(overview: ProjectOverview): void {
  try {
    localStorage.setItem(cacheKey(), JSON.stringify({ version: 1, savedAt: Date.now(), overview }));
  } catch {
    // Storage can be disabled or full; fetching and rendering remain available.
  }
}
