import { agentDisplayState, projectLifecycleState, runtimeDisplayState } from "../../../../../server/src/internal/shared/project-runtime-status.js";
import { currentScopedGroupRun, scopedGroupDisplayState } from "../../../scoped-runtime";
import type { AgentEvent, AgentName, Project } from "../../../types";
import { businessWorkflowEdges } from "./canvas-layout";
import { CANVAS_FINISH_NODE_ID, CANVAS_INPUT_NODE_ID } from "./canvas-model";
import {
  collaborationForAgent,
  workflowOuterNodeIds
} from "./workflow-nodes";

export type RuntimeNodeState =
  | "waiting" | "queued" | "running" | "completed"
  | "retrying" | "paused" | "stopping" | "stopped"
  | "superseded" | "failed" | "interrupted" | "skipped";

export type RuntimeEdgeState =
  | "configured" | "candidate" | "traversed" | "active" | "rejected";

export interface WorkflowLoopRuntimeState {
  id: string;
  batch: number;
  iteration: number;
  totalIterations: number;
  maxIterations: number;
  phase: "idle" | "iterating" | "exhausted";
}

export interface WorkflowRuntimeState {
  nodeStates: Record<string, RuntimeNodeState>;
  /** Latest human-readable failure/interruption diagnostic per node. */
  nodeReasons: Record<string, string>;
  edgeStates: Record<string, RuntimeEdgeState>;
  /** Business executions, not technical invocation/retry counts. */
  executionCounts: Record<string, number>;
  currentInvocationId?: string;
  recentInvocationPath: Array<{
    invocationId?: string;
    nodeId: string;
    cycle?: number;
    state: RuntimeNodeState;
  }>;
  currentNodeId?: string;
  queuedNodeId?: string;
  candidateEdgeIds: string[];
  traversedEdgeIds: string[];
  inferredEdgeIds: string[];
  loopStates: Record<string, WorkflowLoopRuntimeState>;
}

function normalizedType(event: AgentEvent): string {
  return event.type.toLowerCase().replaceAll("_", ".");
}

function stringData(event: AgentEvent, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = event.data?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numberData(event: AgentEvent, key: string): number | undefined {
  const value = event.data?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.floor(value));
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return undefined;
}

function cycleData(event: AgentEvent): number | undefined {
  return numberData(event, "cycle");
}

function nodeId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === "user" || value === "input") return CANVAS_INPUT_NODE_ID;
  if (value === "end" || value === "finish") return CANVAS_FINISH_NODE_ID;
  return value;
}

function configuredEdges(project: Project): Array<{
  id: string;
  source: string;
  target: string;
  loopId?: string;
  loopRole?: "member" | "return" | "exit";
}> {
  return businessWorkflowEdges(project.orchestration, project.orchestration.canvas).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    loopId: edge.loop?.id,
    loopRole: edge.loop?.role
  }));
}

function findEdge(
  edges: readonly { id: string; source: string; target: string }[],
  source: string | undefined,
  target: string | undefined
): { id: string; inferred: boolean } | undefined {
  if (!source || !target) return undefined;
  const exact = edges.find((edge) => edge.source === source && edge.target === target);
  if (exact) return { id: exact.id, inferred: false };
  return undefined;
}

function setNodeState(
  states: Record<string, RuntimeNodeState>,
  id: string | undefined,
  state: RuntimeNodeState
): void {
  if (!id || !(id in states)) return;
  // Timeline events are processed in sequence order.  The latest event is
  // authoritative: a successful retry must be able to replace an earlier
  // failed state, and an interruption must not permanently outrank a later
  // resumed/completed invocation.
  states[id] = state;
}

/**
 * Derive one read-only runtime overlay from the immutable workflow snapshot
 * and timeline.  It never changes orchestration nodes, routes or coordinates.
 */
export function buildWorkflowRuntimeState(
  project: Project,
  timelineEvents: readonly AgentEvent[]
): WorkflowRuntimeState {
  const outerNodeIds = workflowOuterNodeIds(project.orchestration);
  const outerNodeIdSet = new Set(outerNodeIds);
  const nodeIds = [CANVAS_INPUT_NODE_ID, ...outerNodeIds, CANVAS_FINISH_NODE_ID];
  const states = Object.fromEntries(nodeIds.map((id) => [id, "waiting" as RuntimeNodeState]));
  const reasons: Record<string, string> = {};
  const edges = configuredEdges(project);
  const edgeStates = Object.fromEntries(edges.map((edge) => [edge.id, "configured" as RuntimeEdgeState]));
  const initialTarget = nodeId(project.orchestration.input.target);
  const counts: Record<string, number> = {};
  const recent: WorkflowRuntimeState["recentInvocationPath"] = [];
  const seenExecutions = new Set<string>();
  const seenInvocations = new Set<string>();
  const seenEventSeqs = new Set<number>();
  const lastStartSeq = new Map<string, number>();
  const lastQueueSeq = new Map<string, number>();
  const lastTerminalSeq = new Map<string, number>();
  const traversed = new Set<string>();
  const candidate = new Set<string>();
  const inferred = new Set<string>();
  const rejected = new Set<string>();
  const loopStates: Record<string, WorkflowLoopRuntimeState> = Object.fromEntries((project.orchestration.loops ?? []).map((loop) => [
    loop.id,
    {
      id: loop.id,
      batch: Math.max(0, Math.floor(project.loopBatches?.[loop.id] ?? 0)),
      iteration: Math.max(0, Math.floor(project.loopIterations?.[loop.id] ?? 0)),
      totalIterations: Math.max(0, Math.floor(project.loopTotalIterations?.[loop.id] ?? 0)),
      maxIterations: loop.maxIterations,
      phase: "idle"
    }
  ]));
  let currentInvocationId: string | undefined;
  let currentNodeId: string | undefined;
  let queuedNodeId: string | undefined;
  let previousActualNode: string | undefined;
  let terminationCompleted = false;
  let projectCompletedInTimeline = project.status === "completed";
  const nodeRunById = new Map((project.nodeRuns ?? []).map((run) => [run.id, run]));
  const groupRunById = new Map((project.groupRuns ?? []).map((run) => [run.id, run]));

  const groupNodeIds = new Set([
    ...(project.orchestration.collaborations ?? []).map((group) => group.id),
    ...(project.orchestration.scopedWorkflow?.groups ?? []).filter((group) => !group.parentGroupId).map((group) => group.id)
  ]);
  const eventNode = (event: AgentEvent): { id?: string; mappedMember: boolean } => {
    const type = normalizedType(event);
    const memberLifecycle = type.startsWith("agent.") || type.startsWith("invocation.") || type.startsWith("session.") || type === "retry.scheduled" || type === "error";
    const explicitNodeId = nodeId(event.nodeId ?? stringData(event, "nodeId", "node_id"));
    if (explicitNodeId && outerNodeIdSet.has(explicitNodeId)) {
      return { id: explicitNodeId, mappedMember: memberLifecycle && groupNodeIds.has(explicitNodeId) };
    }
    const linkedNodeRun = nodeRunById.get(
      event.nodeRunId ?? stringData(event, "nodeRunId", "node_run_id") ?? ""
    );
    if (linkedNodeRun) return { id: linkedNodeRun.node.nodeId, mappedMember: memberLifecycle && linkedNodeRun.node.kind === "collaboration" };
    const linkedGroupRun = groupRunById.get(
      event.groupRunId ?? stringData(event, "groupRunId", "group_run_id") ?? ""
    );
    if (linkedGroupRun) {
      const groupNode = (project.nodeRuns ?? []).find((run) => run.id === linkedGroupRun.nodeRunId);
      if (groupNode) return { id: groupNode.node.nodeId, mappedMember: true };
    }
    const rawAgent = event.agentId ?? event.agent ?? stringData(event, "agentId", "agent_id");
    if (!rawAgent) return { mappedMember: false };
    if (outerNodeIdSet.has(rawAgent)) return { id: rawAgent, mappedMember: false };
    const group = collaborationForAgent(project.orchestration, rawAgent);
    return group ? { id: group.id, mappedMember: true } : { mappedMember: false };
  };

  // Seed the snapshot before replaying events; a stale running badge must not override a later completion.
  for (const [id, progress] of Object.entries(project.agentProgress ?? {})) {
    if (!outerNodeIdSet.has(id)) continue;
    if (progress?.state) setNodeState(states, id, runtimeDisplayState(progress.state));
    if (typeof progress?.executions === "number" && Number.isFinite(progress.executions)) {
      counts[id] = Math.max(counts[id] ?? 0, Math.max(0, Math.floor(progress.executions)));
    } else if (typeof progress?.runs === "number" && Number.isFinite(progress.runs)) {
      // Backward-compatible baseline for snapshots created before the server
      // exposed business execution counts.
      counts[id] = Math.max(counts[id] ?? 0, Math.max(0, Math.floor(progress.runs)));
    }
  }

  const sorted = [...timelineEvents].sort((left, right) => left.seq - right.seq);
  const explicitAgentStartIds = new Set(
    sorted
      .filter((event) => {
        const type = normalizedType(event);
        return type === "agent.started" || type === "agent.run.started";
      })
      .map((event) => stringData(event, "invocationId", "invocation_id"))
      .filter((value): value is string => Boolean(value))
  );

  const reasonFor = (event: AgentEvent): string | undefined =>
    stringData(event, "error", "reason", "diagnostic", "message") ??
    (event.message?.trim() || undefined);

  const setReason = (id: string | undefined, event: AgentEvent, overwrite = true): void => {
    if (!id) return;
    const reason = reasonFor(event);
    if (reason && (overwrite || !reasons[id])) reasons[id] = reason.slice(0, 500);
  };

  const rejectSiblingCandidates = (source: string | undefined, selectedTarget: string | undefined): void => {
    if (!source) return;
    for (const edge of edges) {
      if (edge.source !== source || edge.target === selectedTarget || !candidate.has(edge.id)) continue;
      candidate.delete(edge.id);
      rejected.add(edge.id);
      edgeStates[edge.id] = "rejected";
    }
  };

  const markCandidate = (source: string | undefined, target: string | undefined): void => {
    const edge = findEdge(edges, source, target);
    if (!edge || traversed.has(edge.id)) return;
    rejected.delete(edge.id);
    candidate.add(edge.id);
    edgeStates[edge.id] = "candidate";
  };

  const markTransition = (
    source: string | undefined,
    target: string | undefined,
    mode: "active" | "traversed",
    inferredSource = false
  ): void => {
    if (!source || !target || target === CANVAS_INPUT_NODE_ID) return;
    const edge = findEdge(edges, source, target);
    if (!edge) return;
    // The finish node is a presentation terminus, not proof that the project
    // completed. Keep the edge active until the configured termination Agent
    // has a real completion event and the project status confirms completion.
    if (target === CANVAS_FINISH_NODE_ID) {
      edgeStates[edge.id] = "active";
      candidate.delete(edge.id);
      rejected.delete(edge.id);
      if (inferredSource) inferred.add(edge.id);
      return;
    }
    edgeStates[edge.id] = mode;
    traversed.add(edge.id);
    candidate.delete(edge.id);
    rejected.delete(edge.id);
    if (inferredSource) inferred.add(edge.id);
    rejectSiblingCandidates(source, target);
  };

  const markIncoming = (
    source: string | undefined,
    target: string | undefined,
    mode: "active" | "traversed",
    inferredSource = false
  ): void => {
    // Older bootstrap/event payloads often omit sourceAgent on the first
    // worker invocation.  The immutable input contract is the authoritative
    // fallback for that first hop; only subsequent missing sources use the
    // adjacent actual invocation as a low-confidence inference.
    const actualSource = source
      ?? previousActualNode
      ?? (target === initialTarget ? CANVAS_INPUT_NODE_ID : undefined);
    markTransition(
      actualSource,
      target,
      mode,
      !source || inferredSource
    );
  };

  const candidateTargets = (event: AgentEvent): string[] => {
    const values = event.data?.candidateAgents ?? event.data?.candidates;
    const list = Array.isArray(values)
      ? values.filter((value): value is string => typeof value === "string")
      : [];
    const direct = stringData(event, "targetAgent", "target", "to", "nextAgent", "next_agent");
    return [...new Set([...list, ...(direct ? [direct] : [])])]
      // Keep the user sentinel distinct until the caller can decide whether
      // this is a real workflow transition. Mapping it to the input node too
      // early would make `nextAgent: "user"` look like a candidate input edge.
      .filter((value) => value !== "user")
      .map(nodeId)
      .filter((value): value is string => Boolean(value));
  };

  for (const event of sorted) {
    if (seenEventSeqs.has(event.seq)) continue;
    seenEventSeqs.add(event.seq);
    const type = normalizedType(event);
    const resolvedEventNode = eventNode(event);
    const eventAgent = resolvedEventNode.id;
    const invocationId = stringData(event, "invocationId", "invocation_id")
      ?? (eventAgent ? `${eventAgent}:${event.seq}` : undefined);
    const source = nodeId(stringData(event, "sourceAgent", "source", "from", "source_agent"));
    const target = nodeId(stringData(event, "targetAgent", "target", "to", "nextAgent", "next_agent"));

    if (
      type === "workflow.loop.batch.started"
      || type === "workflow.loop.iteration"
      || type === "workflow.loop.exhausted"
    ) {
      const loopId = stringData(event, "loopId", "loop_id");
      const configuredLoop = project.orchestration.loops?.find((loop) => loop.id === loopId);
      if (!loopId || !configuredLoop) continue;
      const previous = loopStates[loopId];
      loopStates[loopId] = {
        id: loopId,
        batch: numberData(event, "batch") ?? previous?.batch ?? 0,
        iteration: numberData(event, "iterations") ?? previous?.iteration ?? 0,
        totalIterations: numberData(event, "totalIterations") ?? previous?.totalIterations ?? 0,
        maxIterations: numberData(event, "maxIterations") ?? configuredLoop.maxIterations,
        phase: type === "workflow.loop.exhausted" ? "exhausted" : "iterating"
      };
      const returnEdge = edges.find((edge) => edge.loopId === loopId && edge.loopRole === "return");
      const exitEdge = edges.find((edge) => edge.loopId === loopId && edge.loopRole === "exit");
      if (type === "workflow.loop.iteration") {
        if (returnEdge) edgeStates[returnEdge.id] = "active";
        if (exitEdge) edgeStates[exitEdge.id] = "configured";
      } else if (type === "workflow.loop.exhausted") {
        if (returnEdge) edgeStates[returnEdge.id] = "traversed";
        if (exitEdge) edgeStates[exitEdge.id] = "active";
      }
      continue;
    }

    if (type === "agent.execution.started") {
      if (!eventAgent) continue;
      const executionId = stringData(event, "executionId", "execution_id")
        ?? `${eventAgent}:${event.seq}`;
      if (seenExecutions.has(executionId)) continue;
      seenExecutions.add(executionId);
      const executionNumber = numberData(event, "executionNumber");
      counts[eventAgent] = Math.max(
        (counts[eventAgent] ?? 0) + 1,
        executionNumber ?? 0
      );
      setNodeState(states, eventAgent, "running");
      currentNodeId = eventAgent;
      currentInvocationId = stringData(event, "invocationId", "invocation_id");
      queuedNodeId = queuedNodeId === eventAgent ? undefined : queuedNodeId;
      markIncoming(source, eventAgent, "active");
      continue;
    }

    if (type === "agent.queued" || type === "route.queued" || type === "main.assignment.queued") {
      const targets = type === "main.assignment.queued"
        ? candidateTargets(event)
        : [target ?? eventAgent].filter((value): value is string => Boolean(value));
      const queueTarget = target ?? (type === "main.assignment.queued" ? undefined : eventAgent);
      queuedNodeId = queueTarget === CANVAS_FINISH_NODE_ID ? undefined : queueTarget;
      if (queueTarget) {
        setNodeState(states, queueTarget, "queued");
        lastQueueSeq.set(queueTarget, event.seq);
      }
      for (const candidateTarget of targets) {
        markCandidate(source ?? previousActualNode, candidateTarget);
      }
      continue;
    }

    if (type === "main.assignment.committed" || type === "route.traversed" || type === "route.started") {
      const next = target ?? eventAgent;
      const decisionSource = nodeId(stringData(event, "decisionSourceAgent", "sourceAgent", "source", "from")) ?? source ?? previousActualNode;
      if (next === "user") continue;
      markIncoming(decisionSource, next, type === "route.traversed" ? "traversed" : "active");
      if (next === CANVAS_FINISH_NODE_ID) queuedNodeId = undefined;
      continue;
    }

    if (type === "invocation.started" && invocationId && explicitAgentStartIds.has(invocationId)) {
      // The durable invocation envelope is followed by the richer
      // agent.started event. Count the latter once and avoid a phantom call.
      continue;
    }

    if (type === "agent.started" || type === "agent.run.started" || type === "invocation.started") {
      if (!eventAgent || !invocationId || seenInvocations.has(invocationId)) continue;
      seenInvocations.add(invocationId);
      setNodeState(states, eventAgent, "running");
      lastStartSeq.set(eventAgent, event.seq);
      currentNodeId = eventAgent;
      currentInvocationId = stringData(event, "invocationId", "invocation_id");
      queuedNodeId = queuedNodeId === eventAgent ? undefined : queuedNodeId;
      markIncoming(source, eventAgent, "active");
      recent.push({ invocationId: currentInvocationId, nodeId: eventAgent, cycle: cycleData(event), state: "running" });
      previousActualNode = eventAgent;
      continue;
    }

    if (type === "retry.scheduled" || type === "agent.retrying") {
      if (resolvedEventNode.mappedMember) { setReason(eventAgent, event, false); continue; }
      const retryNode = eventAgent ?? target;
      setNodeState(states, retryNode, "retrying");
      setReason(retryNode, event, false);
      const retryInvocation = stringData(event, "invocationId", "invocation_id");
      const retryCall = [...recent].reverse().find((call) =>
        call.nodeId === retryNode && (!retryInvocation || call.invocationId === retryInvocation)
      );
      if (retryCall) retryCall.state = "retrying";
      queuedNodeId = retryNode;
      if (retryNode) lastQueueSeq.set(retryNode, event.seq);
      continue;
    }
    if (type === "agent.failed" || type === "agent.run.failed" || type === "invocation.failed" || type === "error") {
      if (resolvedEventNode.mappedMember) {
        setReason(eventAgent, event, false);
        continue;
      }
      setNodeState(states, eventAgent, "failed");
      setReason(eventAgent, event);
      const failedInvocation = stringData(event, "invocationId", "invocation_id");
      const failedCall = [...recent].reverse().find((call) =>
        call.nodeId === eventAgent && (!failedInvocation || call.invocationId === failedInvocation)
      );
      if (failedCall) failedCall.state = "failed";
      if (eventAgent) lastTerminalSeq.set(eventAgent, event.seq);
      continue;
    }
    if (type === "agent.interrupted" || type === "agent.run.interrupted" || type === "session.resume.failed") {
      if (resolvedEventNode.mappedMember) {
        setReason(eventAgent, event, false);
        continue;
      }
      setNodeState(states, eventAgent, "interrupted");
      setReason(eventAgent, event);
      const interruptedInvocation = stringData(event, "invocationId", "invocation_id");
      const interruptedCall = [...recent].reverse().find((call) =>
        call.nodeId === eventAgent && (!interruptedInvocation || call.invocationId === interruptedInvocation)
      );
      if (interruptedCall) interruptedCall.state = "interrupted";
      if (eventAgent) lastTerminalSeq.set(eventAgent, event.seq);
      continue;
    }
    if (type === "session.replaced") {
      if (resolvedEventNode.mappedMember) { setReason(eventAgent, event, false); continue; }
      setNodeState(states, eventAgent, "interrupted");
      setReason(eventAgent, event);
      continue;
    }
    if (type === "project.completed") {
      projectCompletedInTimeline = true;
      continue;
    }
    if (type === "project.status") {
      const status = stringData(event, "status")?.toLowerCase();
      if (status === "completed") projectCompletedInTimeline = true;
      continue;
    }
    if (type === "agent.completed" || type === "agent.run.completed" || type === "invocation.completed" || type === "agent.finished") {
      // A member finishing one task never completes the collaboration node.
      // GroupRun/NodeRun is the authoritative outer lifecycle.
      if (resolvedEventNode.mappedMember) continue;
      const completed = eventAgent;
      if (completed && completed in states) setNodeState(states, completed, "completed");
      if (completed) lastTerminalSeq.set(completed, event.seq);
      const eventInvocation = stringData(event, "invocationId", "invocation_id");
      const recentCall = [...recent].reverse().find((call) =>
        call.state === "running" &&
        (eventInvocation ? call.invocationId === eventInvocation : call.nodeId === completed)
      );
      if (recentCall) recentCall.state = "completed";
      if (completed === project.orchestration.termination.agent) terminationCompleted = true;
      if (currentNodeId === completed) {
        currentNodeId = undefined;
        if (!eventInvocation || currentInvocationId === eventInvocation) currentInvocationId = undefined;
      }
      // A completed invocation turns its active incoming edge into a stable
      // traversed edge while preserving a later repeated invocation.
      for (const edge of edges) {
        if (edge.target === completed && edgeStates[edge.id] === "active") {
          edgeStates[edge.id] = "traversed";
          traversed.add(edge.id);
        }
      }
      continue;
    }
  }

  if (project.currentAgent && ["running", "pausing", "cancelling"].includes(project.status)
    && (lastStartSeq.get(project.currentAgent) ?? -1) >= (lastTerminalSeq.get(project.currentAgent) ?? -1)) {
    currentNodeId = project.currentAgent;
    setNodeState(states, project.currentAgent, "running");
  }
  if (project.queuedAgent && ["queued", "retrying", "paused", "interrupted"].includes(project.status)) {
    queuedNodeId = project.queuedAgent;
    const startedAfterQueue = (lastStartSeq.get(project.queuedAgent) ?? -1) > (lastQueueSeq.get(project.queuedAgent) ?? -1);
    if (!startedAfterQueue) {
      setNodeState(states, project.queuedAgent, project.status === "retrying" ? "retrying" : "queued");
    }
  }

  const runtimeStatus = runtimeDisplayState;
  // Durable snapshot state wins over a partial/replayed SSE window. This is
  // also what restores every member execution after a browser refresh.
  for (const run of project.nodeRuns ?? []) {
    if (!outerNodeIdSet.has(run.node.nodeId)) continue;
    setNodeState(states, run.node.nodeId, runtimeStatus(run.status));
    if (run.failureReason) reasons[run.node.nodeId] = run.failureReason;
  }
  for (const groupRun of project.groupRuns ?? []) {
    if (project.orchestration.schemaVersion === 3) continue;
    const run = nodeRunById.get(groupRun.nodeRunId);
    const id = run?.node.nodeId;
    if (!id || !outerNodeIdSet.has(id)) continue;
    setNodeState(states, id, runtimeStatus(groupRun.status));
    if (groupRun.failureReason) reasons[id] = groupRun.failureReason;
    counts[id] = Math.max(
      counts[id] ?? 0,
      new Set((project.executions ?? [])
        .filter((execution) => execution.groupRunId === groupRun.id)
        .map((execution) => execution.id)).size
    );
  }
  // v3 has an arrival-keyed runtime contract. Legacy flat GroupRun and
  // execution arrays are deliberately ignored here so a completed scoped
  // group cannot regress to waiting/zero executions in the outer canvas.
  if (project.orchestration.schemaVersion === 3) {
    const scopedExecutions = project.scopedExecutions ?? [];
    for (const groupRun of project.scopedGroupRuns ?? []) {
      const node = (project.nodeRuns ?? []).find((run) => run.activationRequestId === groupRun.activationRequestId);
      const id = node?.node.nodeId ?? groupRun.groupId;
      if (!outerNodeIdSet.has(id)) continue;
      if (currentScopedGroupRun(project, groupRun.groupId)?.id !== groupRun.id) continue;
      const scopedState = scopedGroupDisplayState(project, groupRun.groupId);
      setNodeState(states, id, scopedState);
      counts[id] = Math.max(counts[id] ?? 0,
        new Set(scopedExecutions.filter((execution) => execution.groupRunId === groupRun.id).map((execution) => execution.id)).size);
      if (scopedState === "failed") reasons[id] = reasons[id] ?? `组运行 ${groupRun.id} 失败`;
    }
  }
  const activeNodeRun = nodeRunById.get(project.activeNodeRunId ?? "");
  if (activeNodeRun && outerNodeIdSet.has(activeNodeRun.node.nodeId) &&
    !(project.orchestration.schemaVersion === 3 && activeNodeRun.node.kind === "collaboration")) {
    currentNodeId = activeNodeRun.node.nodeId;
    if (!["completed", "failed", "cancelled"].includes(activeNodeRun.status)) {
      setNodeState(states, currentNodeId, runtimeStatus(activeNodeRun.status));
    }
  }
  for (const definition of project.orchestration.agents) {
    if (!outerNodeIdSet.has(definition.name)) continue;
    const state = states[definition.name] ?? "waiting";
    setNodeState(states, definition.name, project.runtime
      ? agentDisplayState(project, definition.name, state) : projectLifecycleState(project, state));
  }
  for (const id of outerNodeIds) setNodeState(states, id, projectLifecycleState(project, states[id]!));
  if (currentNodeId && !["running", "stopping"].includes(states[currentNodeId]!)) currentNodeId = undefined;
  if ((project.status === "completed" || projectCompletedInTimeline) && terminationCompleted) {
    const terminationAgent = project.orchestration.termination.agent;
    const finishEdge = findEdge(edges, terminationAgent, CANVAS_FINISH_NODE_ID);
    if (finishEdge) {
      edgeStates[finishEdge.id] = "traversed";
      traversed.add(finishEdge.id);
    }
    states[CANVAS_FINISH_NODE_ID] = "completed";
  }

  return {
    nodeStates: states,
    nodeReasons: reasons,
    edgeStates,
    executionCounts: counts,
    currentInvocationId,
    recentInvocationPath: recent,
    currentNodeId,
    queuedNodeId,
    candidateEdgeIds: [...candidate],
    traversedEdgeIds: [...traversed],
    inferredEdgeIds: [...inferred],
    loopStates
  };
}

export function runtimeNodeLabel(state: RuntimeNodeState | undefined): string {
  return ({
    waiting: "待执行",
    queued: "排队中",
    running: "运行中",
    completed: "已完成",
    retrying: "等待重试",
    paused: "已暂停",
    stopping: "正在停止",
    stopped: "已停止",
    superseded: "已重新分配",
    failed: "异常",
    interrupted: "待恢复",
    skipped: "已跳过"
  } as Record<RuntimeNodeState, string>)[state ?? "waiting"];
}

export function isRuntimeAgent(value: string | undefined, project: Project): value is AgentName {
  return Boolean(value && project.orchestration.agents.some((agent) => agent.name === value));
}
