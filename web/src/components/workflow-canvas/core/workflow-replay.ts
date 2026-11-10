import type { AgentEvent, AgentOrchestrationTemplate, AgentsConfig, ProjectStatus } from "../../../types";
import { adaptWorkflowToCanvas } from "./canvas-adapter";
import type { CanvasModel } from "./canvas-model";
import { scopedCanvasPlanningOrchestration } from "./scoped-canvas-layout";
import type { RuntimeNodeState, WorkflowRuntimeState } from "./workflow-runtime";

export interface WorkflowReplayConfigurationHistory {
  revisions: Array<{ revision: number; ts: string; orchestration: AgentOrchestrationTemplate }>;
  configurations: Array<{ revision: number; ts: string; collaborationSeq: number; agents: AgentsConfig }>;
}
export interface WorkflowReplayEventPage { events: AgentEvent[]; hasMore: boolean; throughSeq: number }
export interface WorkflowReplayChange { title: string; content: string; reason: string; nodeId?: string; kind: "prompt" | "agent" | "edge" }
export interface WorkflowReplayFrame {
  event?: AgentEvent;
  revision: number;
  orchestration: AgentOrchestrationTemplate;
  agents: AgentsConfig;
  models: Record<string, CanvasModel>;
  scopes: Record<string, WorkflowRuntimeState>;
  status: ProjectStatus;
  cycle: number;
  change?: WorkflowReplayChange;
}
export const WORKFLOW_REPLAY_ROOT_SCOPE = "";

const text = (event: AgentEvent, ...keys: string[]) => {
  for (const key of keys) if (typeof event.data?.[key] === "string" && event.data[key]) return event.data[key] as string;
  return undefined;
};
const eventType = (event: AgentEvent) => (text(event, "sourceType") ?? event.type).toLowerCase().replaceAll("_", ".");

function modelsFor(orchestration: AgentOrchestrationTemplate): Record<string, CanvasModel> {
  const models: Record<string, CanvasModel> = { [WORKFLOW_REPLAY_ROOT_SCOPE]: adaptWorkflowToCanvas(orchestration, orchestration.canvas) };
  for (const group of orchestration.scopedWorkflow?.groups ?? []) {
    const model = adaptWorkflowToCanvas(scopedCanvasPlanningOrchestration(group.workflow));
    for (const node of model.nodes) {
      const ref = group.workflow.nodes.find(entry => entry.nodeId === node.id);
      if (ref?.kind === "agent") {
        node.name = ref.agentId;
        node.template = orchestration.agents.find(agent => agent.name === ref.agentId)?.template ?? "general";
      } else if (ref?.kind === "collaboration") {
        node.name = ref.groupId;
        node.collaboration = orchestration.collaborations?.find(entry => entry.id === ref.groupId) ?? {
          id: ref.groupId, displayName: ref.groupId, memberAgentIds: [], renamePolicy: "editable"
        };
        node.displayName = node.collaboration.displayName;
      }
    }
    models[group.id] = model;
  }
  return models;
}

function emptyRuntime(model: CanvasModel): WorkflowRuntimeState {
  return { nodeStates: Object.fromEntries(model.nodes.map(node => [node.id, "waiting"])), nodeReasons: {},
    edgeStates: Object.fromEntries(model.edges.map(edge => [edge.id, "configured"])), executionCounts: {},
    recentInvocationPath: [], candidateEdgeIds: [], traversedEdgeIds: [], inferredEdgeIds: [], loopStates: {} };
}

function nodeStatus(type: string, event: AgentEvent): RuntimeNodeState | undefined {
  const status = text(event, "status", "state", "outcome");
  if (type === "runtime.activity.closed" && !["failed", "interrupted", "stopped"].includes(status ?? "")) return undefined;
  if (status && ["waiting", "queued", "running", "completed", "retrying", "paused", "stopping", "stopped", "superseded", "failed", "interrupted", "skipped"].includes(status))
    return status as RuntimeNodeState;
  if (type === "retry.scheduled" || type.endsWith(".retrying")) return "retrying";
  if (type === "scoped.agent.claimed" || type === "agent.native.binding.opened") return "running";
  if (type === "scoped.agent.merged.route") return "completed";
  if (type.includes("failed")) return "failed";
  if (type.endsWith(".interrupted")) return "interrupted";
  if (type.endsWith(".cancelled") || type.endsWith(".stopped")) return "stopped";
  // A report and a stopped native process do not prove that integration completed.
  if (type.endsWith(".task.completed") || type.endsWith(".native.stopped")) return undefined;
  if (type.endsWith(".completed") || type.endsWith(".succeeded")) return "completed";
  if (type.endsWith(".started") || type.endsWith(".activated") || type.endsWith(".native.opened")) return "running";
  if (type.endsWith(".queued") || type.startsWith("scoped.arrival.") && type.endsWith(".created")) return "queued";
  return undefined;
}

export function configurationChange(before: AgentsConfig, after: AgentsConfig, event: Pick<AgentEvent, "message" | "data">): WorkflowReplayChange | undefined {
  const changes: string[] = [];
  let nodeId: string | undefined;
  let prompt = false;
  for (const [id, agent] of Object.entries(after)) {
    const previous = before[id];
    if (!previous) continue;
    for (const [field, label] of [["instructions", "Prompt"], ["model", "模型"], ["harness", "Harness"], ["skills", "Skills"],
      ["autoSkills", "自动 Skills"], ["mcpServers", "MCP / 工具"], ["experimentMcp", "实验工具"]] as const) {
      if (JSON.stringify(previous[field]) === JSON.stringify(agent[field])) continue;
      nodeId ??= id;
      prompt ||= field === "instructions";
      const value = typeof agent[field] === "string" ? agent[field] as string : JSON.stringify(agent[field]);
      changes.push(`${id} · ${label}：${value ?? "已移除"}`);
    }
  }
  return changes.length ? { title: "Agent 配置已调整", kind: prompt ? "prompt" : "agent", nodeId,
    content: changes.join("\n").slice(0, 1200), reason: (typeof event.data?.rationale === "string" ? event.data.rationale : undefined)
      ?? (typeof event.data?.reason === "string" ? event.data.reason : undefined) ?? event.message } : undefined;
}

/** Every frame depends only on facts at or before its event. No live Project state is read. */
export function buildWorkflowReplay(history: WorkflowReplayConfigurationHistory, input: readonly AgentEvent[]) {
  if (!history.revisions.length) throw new Error("缺少 Workflow 历史版本，无法还原执行画布。");
  const revisions = [...history.revisions].sort((a, b) => a.revision - b.revision);
  const configurations = [...history.configurations].sort((a, b) => a.collaborationSeq - b.collaborationSeq);
  const seenIds = new Set<string>(), seenSeqs = new Set<number>();
  const events = [...input].sort((a, b) => a.seq - b.seq).filter(event => {
    if (seenSeqs.has(event.seq) || event.eventId && seenIds.has(event.eventId)) return false;
    seenSeqs.add(event.seq); if (event.eventId) seenIds.add(event.eventId);
    if (!Number.isFinite(Date.parse(event.ts))) throw new Error(`执行事件 #${event.seq} 缺少有效时间，无法回顾。`);
    return true;
  });
  let revision = revisions[0]!;
  let models = modelsFor(revision.orchestration);
  let scopes = Object.fromEntries(Object.entries(models).map(([id, model]) => [id, emptyRuntime(model)]));
  let agents: AgentsConfig = {};
  let configurationIndex = -1;
  let status: ProjectStatus = "queued", cycle = 0;
  const frames: WorkflowReplayFrame[] = [];
  const notices = new Set<string>();
  const groupScopes = new Map<string, string>();
  const nodeRuns = new Map<string, { scope: string; node: string }>();
  const arrivals = new Map<string, { scope: string; node: string; source?: string }>();
  const executions = new Map<string, { scope: string; node: string }>();
  const executionKeys = new Set<string>();
  const invocationExecutions = new Map<string, string>();
  const save = (event?: AgentEvent, change?: WorkflowReplayChange) => {
    frames.push({ event, revision: revision.revision, orchestration: revision.orchestration, agents, models,
      scopes, status, cycle, change });
  };
  if (revision.revision !== 1) notices.add(`现存 Workflow 历史从 v${revision.revision} 开始。`);
  if (!configurations.length) notices.add("缺少历史 Agent 配置；回顾仅展示已记录的拓扑和执行状态。");
  if (events.length && !events.some(event => ["project.created", "project.accepted"].includes(eventType(event))))
    notices.add(`现存记录缺少项目起始事件；回顾从 ${events[0]!.ts} 的首条执行记录开始。`);
  save();

  for (const event of events) {
    const type = eventType(event);
    let changed = false;
    let change: WorkflowReplayChange | undefined;
    // Each frame owns its runtime objects; prior frames remain valid when seeking backwards.
    const updated = new Set<string>();
    scopes = { ...scopes };
    const writable = (scope: string) => {
      const runtime = scopes[scope];
      if (!runtime) return undefined;
      if (!updated.has(scope)) {
        scopes[scope] = { ...runtime, nodeStates: { ...runtime.nodeStates }, edgeStates: { ...runtime.edgeStates },
          nodeReasons: { ...runtime.nodeReasons }, executionCounts: { ...runtime.executionCounts },
          recentInvocationPath: runtime.recentInvocationPath.map(entry => ({ ...entry })), loopStates: { ...runtime.loopStates } };
        updated.add(scope);
      }
      return scopes[scope];
    };
    const setNode = (scope: string, node: string | undefined, next: RuntimeNodeState) => {
      if (!node || !models[scope]?.nodes.some(entry => entry.id === node)) return;
      const runtime = writable(scope)!;
      const previousState = runtime.nodeStates[node];
      const previousCall = [...runtime.recentInvocationPath].reverse().find(entry => entry.nodeId === node);
      const previousInvocation = previousCall?.invocationId;
      if (runtime.nodeStates[node] !== next) changed = true;
      runtime.nodeStates[node] = next;
      if (next === "running" || next === "completed") delete runtime.nodeReasons[node];
      const invocationId = event.invocationId ?? text(event, "invocationId");
      if (next === "running") {
        runtime.currentNodeId = node; runtime.currentInvocationId = invocationId;
        const executionId = event.executionId ?? text(event, "executionId");
        if (invocationId && executionId) invocationExecutions.set(invocationId, executionId);
        const key = `${scope}:${executionId ?? (invocationId ? invocationExecutions.get(invocationId) ?? invocationId : undefined) ?? event.nodeRunId ?? `${node}:${event.seq}`}`;
        const newExecution = !executionKeys.has(key);
        executionKeys.add(key);
        if (newExecution && (previousState !== "running" || invocationId && previousInvocation && previousInvocation !== invocationId)) {
          runtime.executionCounts[node] = (runtime.executionCounts[node] ?? 0) + 1;
          runtime.recentInvocationPath.push({ nodeId: node, invocationId, cycle, state: next });
          changed = true;
        } else if (previousCall && !previousCall.invocationId && invocationId) previousCall.invocationId = invocationId;
      } else {
        const call = [...runtime.recentInvocationPath].reverse().find(entry => entry.nodeId === node && (!invocationId || entry.invocationId === invocationId));
        if (call) call.state = next;
        if (runtime.currentNodeId === node) runtime.currentNodeId = Object.keys(runtime.nodeStates).find(id => runtime.nodeStates[id] === "running");
        if (["failed", "interrupted", "stopped"].includes(next)) runtime.nodeReasons[node] = text(event, "reason") ?? event.message;
        for (const edge of models[scope]!.edges) if (edge.target === node && runtime.edgeStates[edge.id] === "active") runtime.edgeStates[edge.id] = "traversed";
      }
      runtime.queuedNodeId = Object.keys(runtime.nodeStates).find(id => ["queued", "retrying"].includes(runtime.nodeStates[id]!));
    };
    const route = (scope: string, source: string | undefined, target: string | undefined) => {
      if (!source || !target) return;
      const edge = models[scope]?.edges.find(entry => entry.source === source && entry.target === target);
      if (!edge) return;
      const runtime = writable(scope)!;
      runtime.edgeStates[edge.id] = "active"; changed = true;
      if (source === "input") runtime.nodeStates.input = "completed";
    };

    const requestedRevision = event.workflowRevision;
    if (requestedRevision && requestedRevision > revision.revision) {
      const next = revisions.find(entry => entry.revision === requestedRevision);
      if (!next) throw new Error(`执行事件 #${event.seq} 引用的 Workflow v${requestedRevision} 已缺失。`);
      const previous = models;
      revision = next; models = modelsFor(next.orchestration);
      scopes = Object.fromEntries(Object.entries(models).map(([scope, model]) => {
        const runtime = emptyRuntime(model), prior = scopes[scope];
        if (prior) {
          for (const id of Object.keys(runtime.nodeStates)) runtime.nodeStates[id] = prior.nodeStates[id] ?? "waiting";
          for (const id of Object.keys(runtime.edgeStates)) runtime.edgeStates[id] = prior.edgeStates[id] ?? "configured";
          runtime.executionCounts = { ...prior.executionCounts }; runtime.nodeReasons = { ...prior.nodeReasons };
          runtime.recentInvocationPath = prior.recentInvocationPath.map(entry => ({ ...entry }));
          runtime.currentNodeId = prior.currentNodeId && runtime.nodeStates[prior.currentNodeId] ? prior.currentNodeId : undefined;
        }
        return [scope, runtime];
      }));
      updated.clear(); changed = true;
      const added = Object.values(models).flatMap(model => model.nodes.filter(node => !Object.values(previous).some(prior => prior.nodes.some(entry => entry.id === node.id))).map(node => node.name));
      const removed = Object.values(previous).flatMap(model => model.nodes.filter(node => !Object.values(models).some(nextModel => nextModel.nodes.some(entry => entry.id === node.id))).map(node => node.name));
      change = { kind: "edge", title: `Workflow v${revision.revision} 已应用`,
        content: [added.length ? `新增：${[...new Set(added)].join("、")}` : "", removed.length ? `移除：${[...new Set(removed)].join("、")}` : "", "拓扑与连接按历史版本更新"].filter(Boolean).join("\n"),
        reason: text(event, "rationale", "reason") ?? event.message };
    }
    const sourceSeq = typeof event.data?.collaborationSeq === "number" ? event.data.collaborationSeq : undefined;
    while (configurationIndex + 1 < configurations.length) {
      const next = configurations[configurationIndex + 1]!;
      if (sourceSeq !== undefined ? next.collaborationSeq > sourceSeq : Date.parse(next.ts) > Date.parse(event.ts)) break;
      change = configurationChange(agents, next.agents, event) ?? change;
      agents = next.agents; configurationIndex++; changed = true;
    }
    if (typeof event.data?.cycle === "number" && event.data.cycle !== cycle) { cycle = event.data.cycle; changed = true; }
    const groupRunId = event.groupRunId ?? text(event, "groupRunId");
    const groupId = text(event, "groupId");
    if (groupRunId && groupId) groupScopes.set(groupRunId, groupId);
    const scopeId = groupRunId ? groupScopes.get(groupRunId) : text(event, "routeScopeId");
    const nodeRunId = event.nodeRunId ?? text(event, "nodeRunId");
    const agent = event.agentId ?? event.agent ?? text(event, "agentId");
    const explicitNode = event.nodeId ?? text(event, "nodeId", "targetNodeId");
    let location: { scope: string; node: string } | undefined;
    if (scopeId && models[scopeId]) {
      const arrivalId = text(event, "arrivalRequestId");
      location = arrivalId ? arrivals.get(arrivalId) : undefined;
      const refs = models[scopeId]!.nodes.filter(node => node.name === agent);
      const node = explicitNode && models[scopeId]!.nodes.some(entry => entry.id === explicitNode) ? explicitNode : refs.length === 1 ? refs[0]!.id : undefined;
      location ??= node ? { scope: scopeId, node } : undefined;
      if (location && arrivalId) arrivals.set(arrivalId, { ...location, source: text(event, "sourceNodeId") ?? (text(event, "sourceRunId")?.startsWith("input:") ? "input" : arrivals.get(text(event, "sourceRunId") ?? "")?.node) });
    } else if (explicitNode && models[WORKFLOW_REPLAY_ROOT_SCOPE]!.nodes.some(node => node.id === explicitNode)) location = { scope: WORKFLOW_REPLAY_ROOT_SCOPE, node: explicitNode };
    else if (nodeRunId) location = nodeRuns.get(nodeRunId);
    else if (!groupRunId && agent && models[WORKFLOW_REPLAY_ROOT_SCOPE]!.nodes.some(node => node.id === agent)) location = { scope: WORKFLOW_REPLAY_ROOT_SCOPE, node: agent };
    const executionId = event.executionId ?? text(event, "executionId");
    location ??= executionId ? executions.get(executionId) : undefined;
    if (location?.scope === WORKFLOW_REPLAY_ROOT_SCOPE && nodeRunId) nodeRuns.set(nodeRunId, location);
    if (location && executionId) executions.set(executionId, location);

    if (type.startsWith("workflow.loop.") || text(event, "loopId")) {
      const loopId = text(event, "loopId");
      const scope = scopeId && models[scopeId] ? scopeId : WORKFLOW_REPLAY_ROOT_SCOPE;
      const definition = scope === WORKFLOW_REPLAY_ROOT_SCOPE ? revision.orchestration.loops?.find(loop => loop.id === loopId)
        : revision.orchestration.scopedWorkflow?.groups.find(group => group.id === scope)?.workflow.loops?.find(loop => loop.id === loopId);
      if (loopId && definition) {
        const runtime = writable(scope)!;
        const previous = runtime.loopStates[loopId];
        const count = (key: string, prior = 0) => typeof event.data?.[key] === "number" ? event.data[key] as number : prior;
        runtime.loopStates[loopId] = { id: loopId, batch: count("batch", previous?.batch), iteration: count("iterations", previous?.iteration),
          totalIterations: count("totalIterations", previous?.totalIterations), maxIterations: definition.maxIterations,
          phase: type.endsWith(".exhausted") || event.data?.loopExhausted === true ? "exhausted" : "iterating" };
        changed = true;
      }
    }

    if (type.startsWith("project.")) {
      const next = text(event, "status") ?? type.slice(8);
      if (["queued", "running", "paused", "interrupted", "failed", "completed", "cancelled", "stopped", "retrying"].includes(next)) {
        status = next as ProjectStatus; changed = true;
        if (next === "completed") setNode(WORKFLOW_REPLAY_ROOT_SCOPE, "finish", "completed");
        if (["paused", "interrupted", "cancelled", "stopped"].includes(next)) for (const [id, runtime] of Object.entries(scopes)) {
          for (const [node, state] of Object.entries(runtime.nodeStates)) if (["running", "retrying", "queued"].includes(state))
            setNode(id, node, next === "cancelled" ? "stopped" : next as RuntimeNodeState);
        }
      }
    } else if (type.startsWith("scoped.group.") || type.startsWith("group.") || event.type.startsWith("collaboration.group.")) {
      const scope = scopeId ?? groupId;
      if (scope && models[scope]) {
        const group = revision.orchestration.scopedWorkflow?.groups.find(entry => entry.id === scope);
        const parentScope = group?.parentGroupId ?? WORKFLOW_REPLAY_ROOT_SCOPE;
        const parentNode = models[parentScope]?.nodes.find(node => (node.collaboration?.id ?? node.id) === scope);
        const next = nodeStatus(type, event);
        if (next) {
          setNode(parentScope, parentNode?.id, next);
          if (type.endsWith(".activated")) for (const edge of models[scope]!.edges.filter(edge => edge.source === "input")) {
            setNode(scope, edge.target, "queued"); route(scope, "input", edge.target);
          }
          if (next === "completed") setNode(scope, "finish", "completed");
        }
      } else if (location) { const next = nodeStatus(type, event); if (next) setNode(location.scope, location.node, next); }
    } else if (/^(agent\.|runtime\.activity\.|invocation\.|node\.|execution\.|workflow\.node\.|collaboration\.execution\.|scoped\.(agent|arrival)\.|retry\.)/.test(type)) {
      const next = nodeStatus(type, event);
      if (location && next) {
        const memberLifecycle = !type.startsWith("node.") && !type.startsWith("workflow.node.")
          && models[location.scope]?.nodes.find(node => node.id === location.node)?.collaboration;
        if (!memberLifecycle || next === "running") setNode(location.scope, location.node, next);
        if (next === "running") { status = "running"; route(location.scope, text(event, "sourceAgent", "sourceNodeId") ?? arrivals.get(text(event, "arrivalRequestId") ?? "")?.source, location.node); }
      } else if (next && groupRunId && !scopeId) notices.add("部分组内事件缺少范围关联，仅回顾能定位的执行记录。");
      if (location && type === "node.completed") route(location.scope, location.node, text(event, "targetNodeId"));
      if (location && type === "scoped.agent.merged.route") {
        const target = text(event, "targetNodeId");
        route(location.scope, location.node, target);
        if (target) {
          setNode(location.scope, target, "queued");
          const requestId = text(event, "nextArrivalRequestId");
          if (requestId) arrivals.set(requestId, { scope: location.scope, node: target, source: location.node });
        }
      }
    } else if (type.startsWith("route.") || type.startsWith("main.assignment.") || type === "collaboration.route.emitted") {
      const scope = scopeId && models[scopeId] ? scopeId : WORKFLOW_REPLAY_ROOT_SCOPE;
      const target = text(event, "nextAgent", "targetNodeId", "targetAgent", "target");
      route(scope, text(event, "decisionSourceAgent", "sourceAgent", "sourceNodeId"), target === "end" ? "finish" : target);
    }
    for (const scope of updated) {
      const runtime = scopes[scope]!;
      runtime.candidateEdgeIds = Object.keys(runtime.edgeStates).filter(id => runtime.edgeStates[id] === "candidate");
      runtime.traversedEdgeIds = Object.keys(runtime.edgeStates).filter(id => ["traversed", "active"].includes(runtime.edgeStates[id]!));
    }
    if (changed) save(event, change);
  }
  return { frames, notices: [...notices] };
}

/** Idle time is compressed while simultaneous records keep one playback instant. */
export function workflowReplayTimes(frames: readonly WorkflowReplayFrame[], duration: number): number[] {
  const weights = frames.map((frame, index) => {
    if (index < 2) return 0;
    const previous = frames[index - 1]!.event!;
    const gap = Math.max(0, Date.parse(frame.event!.ts) - Date.parse(previous.ts));
    if (!gap && nodeStatus(eventType(frame.event!), frame.event!) === "running" && nodeStatus(eventType(previous), previous) === "running") return 0;
    return Math.min(2000, Math.max(180, gap));
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let elapsed = 0;
  return weights.map(weight => total ? (elapsed += weight) / total * duration : 0);
}
