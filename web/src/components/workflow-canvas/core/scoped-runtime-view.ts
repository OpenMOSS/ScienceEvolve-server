import type { Project, ScopedCollaboration } from "../../../types";
import { currentScopedGroupRun, scopedGroupDisplayState, scopedNodeDisplayState } from "../../../scoped-runtime";
import { adaptWorkflowToCanvas } from "./canvas-adapter";
import { scopedCanvasPlanningOrchestration } from "./scoped-canvas-layout";
import type { WorkflowRuntimeState } from "./workflow-runtime";
import { runtimeDisplayState } from "../../../../../server/src/internal/shared/project-runtime-status.js";

export function scopedGroupName(project: Project, groupId: string): string {
  return project.orchestration.collaborations?.find((group) => group.id === groupId)?.displayName ?? groupId;
}

export function scopedReferenceDisplayState(project: Project, groupId: string, nodeId: string) {
  const ref = project.orchestration.scopedWorkflow?.groups.find((group) => group.id === groupId)?.workflow.nodes.find((node) => node.nodeId === nodeId);
  return ref?.kind === "collaboration" && currentScopedGroupRun(project, ref.groupId)
    ? scopedGroupDisplayState(project, ref.groupId) : scopedNodeDisplayState(project, groupId, nodeId);
}

/** Scope changes only replace the data supplied to the common runtime canvas.
 * Node reference IDs belong to a scope; Agent IDs still resolve configuration. */
export function buildScopedRuntimeView(project: Project, groupId: string) {
  const contract = project.orchestration.scopedWorkflow;
  const group = contract?.groups.find((entry) => entry.id === groupId);
  if (!group) return undefined;
  const model = adaptWorkflowToCanvas(scopedCanvasPlanningOrchestration(group.workflow));
  for (const node of model.nodes) {
    const ref = group.workflow.nodes.find((entry) => entry.nodeId === node.id);
    if (ref?.kind === "agent") {
      node.name = ref.agentId;
      node.template = project.orchestration.agents.find((agent) => agent.name === ref.agentId)?.template ?? "general";
    } else if (ref?.kind === "collaboration") {
      const child = contract!.groups.find((entry) => entry.id === ref.groupId);
      const display = project.orchestration.collaborations?.find((entry) => entry.id === ref.groupId);
      node.name = ref.groupId;
      node.collaboration = display ?? { id: ref.groupId, displayName: ref.groupId,
        memberAgentIds: child?.workflow.nodes.flatMap((entry) => entry.kind === "agent" ? [entry.agentId] : []) ?? [], renamePolicy: "editable" };
      node.displayName = node.collaboration.displayName;
      node.memberAgentIds = [...node.collaboration.memberAgentIds];
    }
  }
  const path: ScopedCollaboration[] = [];
  const visited = new Set<string>();
  let ancestor: ScopedCollaboration | undefined = group;
  while (ancestor && !visited.has(ancestor.id)) {
    visited.add(ancestor.id);
    path.unshift(ancestor);
    ancestor = contract?.groups.find((entry) => entry.id === ancestor!.parentGroupId);
  }
  const run = currentScopedGroupRun(project, groupId);
  const arrivals = (project.scopedArrivals ?? []).filter((arrival) => run && arrival.groupRunId === run.id)
    .sort((a, b) => a.sequence - b.sequence);
  const executions = (project.scopedExecutions ?? []).filter((execution) => run && execution.groupRunId === run.id);
  const latestExecutions = new Map<string, (typeof executions)[number]>();
  for (const execution of executions) {
    if ((latestExecutions.get(execution.arrivalRequestId)?.ownershipEpoch ?? 0) < execution.ownershipEpoch) {
      latestExecutions.set(execution.arrivalRequestId, execution);
    }
  }
  const arrivalById = new Map(arrivals.map((arrival) => [arrival.requestId, arrival]));
  const latestExecution = (requestId: string) => latestExecutions.get(requestId);
  const started = (arrival: (typeof arrivals)[number]) => Boolean(latestExecution(arrival.requestId)) ||
    !["queued", "waiting", "superseded", "skipped"].includes(arrival.status);
  const runtime: WorkflowRuntimeState = {
    nodeStates: Object.fromEntries(model.nodes.map((node) => [node.id, "waiting"])),
    nodeReasons: {}, executionCounts: {},
    edgeStates: Object.fromEntries(model.edges.map((edge) => [edge.id, "configured"])),
    recentInvocationPath: [], candidateEdgeIds: [], traversedEdgeIds: [], inferredEdgeIds: [], loopStates: {}
  };
  if (run) runtime.nodeStates.input = arrivals.length ? "completed" : scopedGroupDisplayState(project, groupId);
  if (run?.status === "completed") runtime.nodeStates.finish = "completed";
  for (const ref of group.workflow.nodes) {
    runtime.nodeStates[ref.nodeId] = scopedReferenceDisplayState(project, groupId, ref.nodeId);
    runtime.executionCounts[ref.nodeId] = new Set(arrivals.filter((arrival) => arrival.targetNodeId === ref.nodeId && started(arrival))
      .map((arrival) => arrival.requestId)).size;
    const issue = project.scopedGroupIssues?.filter((issue) => issue.groupRunId === run?.id &&
      arrivals.some((arrival) => arrival.requestId === issue.arrivalRequestId && arrival.targetNodeId === ref.nodeId)).at(-1);
    if (issue?.reason) runtime.nodeReasons[ref.nodeId] = issue.reason;
  }
  for (const loop of group.workflow.loops ?? []) {
    const counter = arrivals.map((arrival) => arrival.pathContext?.loops?.[loop.id]).filter((item) => item !== undefined).at(-1);
    runtime.loopStates[loop.id] = { id: loop.id, batch: counter?.batch ?? 0, iteration: counter?.iterations ?? 0,
      totalIterations: counter?.totalIterations ?? 0, maxIterations: loop.maxIterations,
      phase: !counter ? "idle" : counter.iterations >= loop.maxIterations ? "exhausted" : "iterating" };
  }
  for (const arrival of arrivals) {
    const source = arrival.sourceRunId === `input:${run?.id}` ? "input"
      : arrivalById.get(arrival.sourceRunId)?.targetNodeId;
    const edge = model.edges.find((entry) => entry.source === source && entry.target === arrival.targetNodeId);
    const state = runtime.nodeStates[arrival.targetNodeId] ?? "waiting";
    if (edge) {
      // Only actual arrivals mark paths; a configured route alone proves nothing.
      const edgeState = arrival.status === "running" && ["running", "retrying"].includes(state) ? "active"
        : started(arrival) ? "traversed" : arrival.status === "queued" ? "candidate" : "configured";
      if (runtime.edgeStates[edge.id] !== "active") runtime.edgeStates[edge.id] = edgeState;
    }
    if (!started(arrival)) continue;
    const execution = latestExecution(arrival.requestId);
    const activity = execution && project.runtime?.activities.find((entry) => entry.executionId === execution.id &&
      entry.ownershipEpoch === execution.ownershipEpoch && entry.leaseState !== "recovering");
    const report = execution && project.scopedAgentReports?.find((entry) => entry.executionId === execution.id && entry.ownershipEpoch === execution.ownershipEpoch);
    runtime.recentInvocationPath.push({ nodeId: arrival.targetNodeId, state: arrival.status === "running" ? state : runtimeDisplayState(arrival.status),
      invocationId: activity?.invocationId ?? report?.invocationId });
    if (activity && arrival.status === "running" && ["running", "retrying"].includes(state)) {
      runtime.currentNodeId = arrival.targetNodeId;
      runtime.currentInvocationId = activity.invocationId;
    }
  }
  runtime.currentNodeId ??= group.workflow.nodes.find((node) => ["running", "retrying"].includes(runtime.nodeStates[node.nodeId]!))?.nodeId;
  runtime.queuedNodeId = group.workflow.nodes.find((node) => runtime.nodeStates[node.nodeId] === "queued")?.nodeId;
  runtime.candidateEdgeIds = model.edges.filter((edge) => runtime.edgeStates[edge.id] === "candidate").map((edge) => edge.id);
  runtime.traversedEdgeIds = model.edges.filter((edge) => ["traversed", "active"].includes(runtime.edgeStates[edge.id]!)).map((edge) => edge.id);
  return { group, path, model, runtime, run };
}
