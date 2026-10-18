import { AGENT_TEMPLATES, type Project, type QueueSnapshot } from "./types";

interface ProjectListSnapshot {
  projects: Project[];
  tokenRefreshedAt: number;
}

const lists = new Map<string, ProjectListSnapshot>();
const queues = new Map<string, QueueSnapshot>();

function cacheKey(): string {
  const base = (import.meta.env.VITE_API_BASE || ".").replace(/\/$/, "");
  return `scienceevolve:project-list:v1:${new URL(`${base}/api/projects`, window.location.href).href}`;
}

const statuses = new Set(["draft", "queued", "running", "retrying", "interrupting", "interrupted", "pausing", "paused", "cancelling", "cancelled", "stopping", "stopped", "completed", "failed"]);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cache object");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid cache string");
  return value;
}
function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : string(value);
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid cache number");
  return value;
}
function optionalNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : number(value);
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid cache array");
  return value;
}

/** Explicit allowlist: never persist runtime configuration, prompts, or credentials.
 * The reconstructed Project is a display snapshot, not an editable configuration.
 */
function displayProject(value: unknown): Project {
  const p = object(value);
  const status = string(p.status);
  if (!statuses.has(status) || !string(p.id)) throw new Error("Invalid cached project");
  const progress = object(p.overallProgress);
  const orchestration = object(p.orchestration);
  const agents = array(orchestration.agents).map((value) => {
    const agent = object(value);
    const template = agent.template;
    if (template !== undefined && !AGENT_TEMPLATES.includes(template as typeof AGENT_TEMPLATES[number])) throw new Error("Invalid agent template");
    return { name: string(agent.name), template: template as typeof AGENT_TEMPLATES[number] | undefined };
  });
  const collaborations = array(orchestration.collaborations ?? []).map((value) => {
    const group = object(value);
    return { id: string(group.id), displayName: string(group.displayName),
      memberAgentIds: array(group.memberAgentIds).map(string), renamePolicy: "locked" as const };
  });
  const scoped = orchestration.schemaVersion === 3 && orchestration.scopedWorkflow
    ? object(orchestration.scopedWorkflow) : undefined;
  const usage = p.tokenUsage === undefined ? undefined : object(p.tokenUsage);
  const intervention = p.userIntervention === undefined ? undefined : object(p.userIntervention);
  if (intervention && intervention.status !== "pending" && intervention.status !== "answered") throw new Error("Invalid intervention");
  return {
    id: string(p.id), title: string(p.title), requirement: string(p.requirement),
    status: status as Project["status"], phase: string(p.phase), cycle: number(p.cycle), turn: 0,
    createdAt: optionalString(p.createdAt), updatedAt: optionalString(p.updatedAt), archivedAt: optionalString(p.archivedAt),
    currentAgent: optionalString(p.currentAgent), queuedAgent: optionalString(p.queuedAgent),
    queueDepth: optionalNumber(p.queueDepth), queuePosition: optionalNumber(p.queuePosition),
    overallProgress: { percent: number(progress.percent), label: string(progress.label), estimated: true,
      successfulCalls: number(progress.successfulCalls) },
    agents: {}, agentProgress: {},
    orchestration: {
      agents, collaborations, schemaVersion: scoped ? 3 : 2,
      scopedWorkflow: scoped ? { schemaVersion: 1,
        rootAgentIds: array(scoped.rootAgentIds).map(string),
        groups: array(scoped.groups).map((value) => {
          const group = object(value);
          return { id: string(group.id), parentGroupId: optionalString(group.parentGroupId),
            leaderAgentId: "", allowLeaderReconfiguration: false,
            workflow: { nodes: [], input: { source: "input", edges: [] }, routes: {} } };
        }) } : undefined,
      input: { source: "input", target: "" }, routes: {}, decisionPlans: {}, allowUserIntervention: false,
      termination: { agent: "", condition: "", decisionBy: "main", automatic: false }
    },
    tokenUsage: usage ? { totalTokens: number(usage.totalTokens), inputTokens: 0, cachedInputTokens: 0,
      outputTokens: 0, invocations: 0, byAgent: {} } : undefined,
    userIntervention: intervention ? { id: string(intervention.id), status: intervention.status as "pending" | "answered",
      requestedAt: string(intervention.requestedAt), message: string(intervention.message), rationale: "", successCriteria: [] } : undefined,
    git: p.git === undefined ? undefined : { enabled: object(p.git).enabled === true, status: "disabled" }
  };
}

export function readCachedProjectList(): ProjectListSnapshot | undefined {
  try {
    const key = cacheKey();
    const memory = lists.get(key);
    if (memory) return memory;
    const stored = object(JSON.parse(localStorage.getItem(key) ?? "null"));
    if (stored.version !== 1) return undefined;
    const snapshot = { projects: array(stored.projects).map(displayProject), tokenRefreshedAt: number(stored.tokenRefreshedAt) };
    lists.set(key, snapshot);
    return snapshot;
  } catch {
    return undefined;
  }
}

export function cacheProjectList(projects: Project[], tokenRefreshedAt: number): void {
  const key = cacheKey();
  lists.set(key, { projects, tokenRefreshedAt });
  try {
    localStorage.setItem(key, JSON.stringify({ version: 1, projects: projects.map(displayProject), tokenRefreshedAt }));
  } catch {
    // Disabled/full storage must not prevent navigation from reusing the memory snapshot.
  }
}

export function readCachedProjectQueue(): QueueSnapshot | undefined {
  return queues.get(cacheKey());
}

export function cacheProjectQueue(queue: QueueSnapshot): void {
  queues.set(cacheKey(), queue);
}

/** Reset ephemeral snapshots; persisted display summaries remain available. */
export function clearProjectListMemoryCache(): void {
  lists.clear();
  queues.clear();
}
