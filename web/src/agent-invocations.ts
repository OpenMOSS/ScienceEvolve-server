import type { AgentEvent, AgentName, Project } from "./types";

export interface AgentInvocation {
  id: string;
  seq: number;
  role: AgentName;
  invocationId: string;
  invocationIds: string[];
  ts: string;
  cycle?: number;
  mainInvocation?: number;
  executionId?: string;
  groupRunId?: string;
  kind?: "management" | "delivery" | "integration";
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (...values: unknown[]): string | undefined =>
  values.find((value): value is string => typeof value === "string" && Boolean(value));
const typeOf = (value: string) => value.toLowerCase().replaceAll("_", ".");
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) :
    typeof value === "string" && /^\d+$/.test(value) ? Math.max(1, Number(value)) : undefined;

function isStart(event: AgentEvent): boolean {
  const type = typeOf(event.type);
  const source = typeOf(String(event.data?.sourceType ?? ""));
  return ["agent.started", "agent.run.started", "invocation.started", "collaboration.execution.started"].includes(type) ||
    ["agent.native.binding.opened", "scoped.agent.native.opened", "scoped.final.native.opened"].includes(source) ||
    source === "runtime.activity.started" && event.data?.kind === "turn";
}

/** A logical task identity keeps parallel paths distinct while retaining retries. */
export function buildAgentInvocations(events: readonly AgentEvent[], project?: Pick<Project, "executions" | "scopedExecutions">): AgentInvocation[] {
  const executions = new Map((project?.executions ?? []).map(execution => [execution.id, execution]));
  const scoped = new Map((project?.scopedExecutions ?? []).map(execution => [execution.id, execution]));
  const details = (event: AgentEvent) => {
    const data = record(event.data);
    const binding = record(data.binding);
    const context = record(data.executionContext ?? binding.executionContext);
    const executionId = string(event.executionId, data.executionId, context.executionId);
    const execution = executionId ? executions.get(executionId) : undefined;
    const member = executionId ? scoped.get(executionId) : undefined;
    const role = string(event.agent, event.agentId, data.agentId, binding.agentId, execution?.agentId, member?.agentId);
    const invocationId = string(event.invocationId, data.invocationId, binding.invocationId);
    const groupRunId = string(event.groupRunId, data.groupRunId, context.groupRunId, execution?.groupRunId, member?.groupRunId);
    const taskId = string(event.taskId, data.taskId, context.taskId, execution?.taskId);
    const source = typeOf(String(data.sourceType ?? ""));
    const kind: AgentInvocation["kind"] = source.startsWith("scoped.final.") || executionId?.startsWith("group-final-") ? "integration" :
      context.role === "leader" || context.role === "scoped-leader" || context.role === "scoped-main" ? "management" :
        groupRunId || executionId ? "delivery" : undefined;
    const logicalId = taskId ? `task:${role}:${taskId}` : executionId ? `execution:${executionId}` :
      typeof context.routeScopeId === "string" ? `route:${role}:${context.routeScopeId}` :
        groupRunId && invocationId ? `management:${invocationId}` : undefined;
    return { role, invocationId, executionId, groupRunId, kind, logicalId,
      cycle: number(data.cycle), mainInvocation: number(data.mainInvocation) };
  };
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  // A later native binding enriches an earlier launch record for the same ID.
  const metadata = new Map<string, ReturnType<typeof details>>();
  for (const event of ordered.filter(isStart)) {
    const item = details(event);
    if (!item.invocationId) continue;
    const previous = metadata.get(item.invocationId);
    metadata.set(item.invocationId, { ...previous, ...Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)) } as ReturnType<typeof details>);
  }
  const calls: AgentInvocation[] = [];
  const byIdentity = new Map<string, number>();
  const openByRole = new Map<AgentName, number>();
  const continuing = new Set<AgentName>();
  for (const event of ordered) {
    const type = typeOf(event.type);
    const own = details(event);
    const item = { ...own, ...(own.invocationId ? metadata.get(own.invocationId) : {}) };
    const { role, invocationId, logicalId } = item;
    if (["agent.completed", "agent.run.completed", "invocation.completed", "agent.finished",
      "agent.failed", "agent.run.failed", "invocation.failed", "agent.interrupted", "agent.run.interrupted"].includes(type)) {
      const index = invocationId ? byIdentity.get(`invocation:${invocationId}`) : undefined;
      const agent = role ?? (index === undefined ? undefined : calls[index]?.role);
      if (agent && !logicalId) {
        if (type.includes("failed") || type.includes("interrupted")) continuing.add(agent);
        else continuing.delete(agent);
      }
      continue;
    }
    if (role && !logicalId && (type === "retry.scheduled" || type === "agent.retrying" ||
      type === "project.status" && /recover|retry|interrupt/i.test(event.message))) {
      continuing.add(role); continue;
    }
    if (!isStart(event) || !role) continue;
    const identity = logicalId ?? `invocation:${invocationId ?? `${role}:${event.seq}`}`;
    let index = invocationId ? byIdentity.get(`invocation:${invocationId}`) : undefined;
    index ??= byIdentity.get(identity);
    if (index === undefined && !logicalId && continuing.has(role)) index = openByRole.get(role);
    if (index === undefined) {
      index = calls.length;
      calls.push({ id: identity, seq: event.seq, role,
        invocationId: invocationId ?? `event-${event.seq}`, invocationIds: [], ts: event.ts });
      if (!logicalId) { openByRole.set(role, index); continuing.delete(role); }
    }
    byIdentity.set(identity, index);
    if (invocationId) byIdentity.set(`invocation:${invocationId}`, index);
    const call = calls[index]!;
    calls[index] = { ...call,
      invocationIds: invocationId && !call.invocationIds.includes(invocationId) ? [...call.invocationIds, invocationId] : call.invocationIds,
      cycle: item.cycle ?? call.cycle, mainInvocation: item.mainInvocation ?? call.mainInvocation,
      executionId: item.executionId ?? call.executionId, groupRunId: item.groupRunId ?? call.groupRunId,
      kind: item.kind ?? call.kind };
  }
  return calls;
}

export function isAgentInvocationActive(call: AgentInvocation, project: Project, calls: readonly AgentInvocation[] = [call]): boolean {
  if ((project.runtime?.status ?? project.status) !== "running") return false;
  if (project.runtime) return project.runtime.activities.some(activity => activity.kind === "turn" &&
    activity.leaseState === "current" && activity.agentId === call.role &&
    (call.invocationIds.includes(activity.invocationId) || Boolean(call.executionId && activity.executionId === call.executionId)));
  return project.currentAgent === call.role && (project.activeInvocationId
    ? call.invocationIds.includes(project.activeInvocationId)
    : calls.filter(item => item.role === call.role).at(-1)?.id === call.id);
}
