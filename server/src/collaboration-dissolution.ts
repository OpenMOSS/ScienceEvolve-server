import { workflowOuterNodeIds } from "./agent-orchestration.js";
import type {
  AgentOrchestrationTemplate,
  CollaborationDissolutionPlan,
  CollaborationNode,
  WorkflowEdge
} from "./types.js";

function routesEqual(left: readonly WorkflowEdge[], right: readonly WorkflowEdge[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneRoutes(routes: readonly WorkflowEdge[] | undefined): WorkflowEdge[] {
  return (routes ?? []).map((edge) => ({ ...edge }));
}

function removeGroupCanvasState(
  orchestration: AgentOrchestrationTemplate,
  groupId: string
): void {
  const canvas = orchestration.canvas;
  if (!canvas) return;
  delete canvas.nodes[groupId];
  for (const edgeId of Object.keys(canvas.edges)) {
    if (edgeId.startsWith(`${groupId}->`) || edgeId.includes(`->${groupId}:`)) {
      delete canvas.edges[edgeId];
    }
  }
}

function restoreMemberPositions(
  orchestration: AgentOrchestrationTemplate,
  group: CollaborationNode,
  positions: CollaborationDissolutionPlan["memberCanvasNodes"]
): void {
  if (!orchestration.canvas) return;
  const anchor = orchestration.canvas.nodes[group.id] ?? { x: 490, y: 260 };
  group.memberAgentIds.forEach((memberId, index) => {
    orchestration.canvas!.nodes[memberId] = positions?.[memberId]
      ? { ...positions[memberId]! }
      : { x: anchor.x + (index % 2) * 245, y: anchor.y + Math.floor(index / 2) * 150 };
  });
}

function synchronizeMainRoutes(orchestration: AgentOrchestrationTemplate): void {
  orchestration.routes.main = workflowOuterNodeIds(orchestration)
    .filter((nodeId) => nodeId !== "main")
    .map((target) => ({ target, kind: "weak" as const }));
}

function validateDissolvedTopology(orchestration: AgentOrchestrationTemplate): void {
  const outerIds = workflowOuterNodeIds(orchestration);
  const outer = new Set(outerIds);
  for (const source of outerIds) {
    const edges = orchestration.routes[source] ?? [];
    if (source !== "main" && edges.length === 0) {
      throw new Error(`Dissolved Agent ${source} has no outgoing route`);
    }
    const strong = edges.filter((edge) => edge.kind === "strong");
    if (strong.length > 1 || (strong.length === 1 && edges.length > 1)) {
      throw new Error(`Dissolved Agent ${source} has an ambiguous strong route`);
    }
    for (const edge of edges) {
      if (edge.target === source) throw new Error(`Dissolved Agent ${source} cannot route to itself`);
      if (edge.target !== "finish" && !outer.has(edge.target)) {
        throw new Error(`Dissolved Agent ${source} routes to unknown node ${edge.target}`);
      }
      if (edge.target === "finish" && source !== orchestration.termination.agent) {
        throw new Error(`Only the termination Agent may route to finish`);
      }
    }
  }
  const reachable = new Set<string>();
  const pending = [orchestration.input.target];
  while (pending.length) {
    const node = pending.pop()!;
    if (reachable.has(node) || !outer.has(node)) continue;
    reachable.add(node);
    for (const edge of orchestration.routes[node] ?? []) {
      if (edge.target !== "finish") pending.push(edge.target);
    }
  }
  const unreachable = outerIds.filter((node) => node !== "main" && !reachable.has(node));
  if (unreachable.length) {
    throw new Error(`Dissolved topology contains unreachable Agents: ${unreachable.join(", ")}`);
  }
  const finishMemo = new Map<string, boolean>();
  const reachesFinish = (node: string, visiting = new Set<string>()): boolean => {
    const known = finishMemo.get(node);
    if (known !== undefined) return known;
    if (visiting.has(node)) return false;
    visiting.add(node);
    const result = (orchestration.routes[node] ?? []).some((edge) =>
      edge.target === "finish" || reachesFinish(edge.target, visiting)
    );
    visiting.delete(node);
    finishMemo.set(node, result);
    return result;
  };
  const trapped = outerIds.filter((node) => node !== "main" && !reachesFinish(node));
  if (trapped.length) {
    throw new Error(`Dissolved topology has no path to finish from: ${trapped.join(", ")}`);
  }
}

export function canRestoreCollaborationSnapshot(
  orchestration: AgentOrchestrationTemplate,
  group: CollaborationNode
): boolean {
  const snapshot = group.formationSnapshot;
  if (!snapshot) return false;
  for (const [source, expected] of Object.entries(snapshot.formedRoutes)) {
    if (!routesEqual(orchestration.routes[source] ?? [], expected)) return false;
  }
  for (const [source, routes] of Object.entries(orchestration.routes)) {
    if (routes.some((edge) => edge.target === group.id) && !(source in snapshot.formedRoutes)) {
      return false;
    }
  }
  if (Boolean(snapshot.inputTarget) !== (orchestration.input.target === group.id)) return false;
  if (Boolean(snapshot.terminationAgent) !== (orchestration.termination.agent === group.id)) return false;
  return true;
}

function restoreSnapshot(
  orchestration: AgentOrchestrationTemplate,
  group: CollaborationNode
): void {
  const snapshot = group.formationSnapshot!;
  for (const memberId of group.memberAgentIds) {
    orchestration.routes[memberId] = cloneRoutes(snapshot.memberRoutes[memberId]);
    orchestration.decisionPlans[memberId] = snapshot.memberDecisionPlans[memberId]
      ?? `结合 ${memberId} Agent 的结果和当前证据，选择下一步路径。`;
  }
  for (const [source, routes] of Object.entries(snapshot.inboundRoutes)) {
    orchestration.routes[source] = cloneRoutes(routes);
  }
  if (orchestration.input.target === group.id && snapshot.inputTarget) {
    orchestration.input.target = snapshot.inputTarget;
  }
  if (orchestration.termination.agent === group.id && snapshot.terminationAgent) {
    orchestration.termination.agent = snapshot.terminationAgent;
  }
  restoreMemberPositions(orchestration, group, snapshot.memberCanvasNodes);
}

function validateMember(
  group: CollaborationNode,
  value: string | undefined,
  label: string
): string {
  if (!value || !group.memberAgentIds.includes(value)) {
    throw new Error(`${label} must be one of the collaboration members`);
  }
  return value;
}

function applyGuidedPlan(
  orchestration: AgentOrchestrationTemplate,
  group: CollaborationNode,
  plan: CollaborationDissolutionPlan
): void {
  const memberSet = new Set(group.memberAgentIds);
  for (const [source, routes] of Object.entries(orchestration.routes)) {
    if (source === group.id || memberSet.has(source)) continue;
    if (!routes.some((edge) => edge.target === group.id)) continue;
    const target = validateMember(group, plan.incomingTargetBySource[source], `Incoming target for ${source}`);
    orchestration.routes[source] = routes
      .map((edge) => edge.target === group.id ? { ...edge, target } : { ...edge })
      .filter((edge, index, values) => values.findIndex((candidate) => candidate.target === edge.target) === index);
  }
  for (const memberId of group.memberAgentIds) {
    const routes = plan.memberRoutes[memberId];
    if (!routes) throw new Error(`Guided dissolution is missing routes for ${memberId}`);
    orchestration.routes[memberId] = cloneRoutes(routes);
    orchestration.decisionPlans[memberId] = group.formationSnapshot?.memberDecisionPlans[memberId]
      ?? `结合 ${memberId} Agent 的结果和当前证据，选择下一步路径。`;
  }
  if (orchestration.input.target === group.id) {
    orchestration.input.target = validateMember(group, plan.inputTarget, "Input target");
  }
  if (orchestration.termination.agent === group.id) {
    orchestration.termination.agent = validateMember(group, plan.terminationAgent, "Termination Agent");
  }
  restoreMemberPositions(orchestration, group, plan.memberCanvasNodes);
}

/**
 * Dissolving creates a new workflow topology. Runtime history, Git facts and
 * artifacts live outside this immutable workflow snapshot and are untouched.
 */
export function dissolveCollaborationGroup(
  orchestration: AgentOrchestrationTemplate,
  groupId: string,
  plan?: CollaborationDissolutionPlan
): void {
  const group = (orchestration.collaborations ?? []).find((entry) => entry.id === groupId);
  if (!group) throw new Error(`Unknown collaboration group: ${groupId}`);
  const exactRestore = canRestoreCollaborationSnapshot(orchestration, group);
  if (exactRestore) {
    restoreSnapshot(orchestration, group);
  } else {
    if (!plan) {
      throw new Error(
        `Collaboration group ${groupId} cannot be restored automatically; choose its incoming and member routes`
      );
    }
    applyGuidedPlan(orchestration, group, plan);
  }
  orchestration.collaborations = (orchestration.collaborations ?? [])
    .filter((entry) => entry.id !== groupId);
  delete orchestration.routes[groupId];
  delete orchestration.decisionPlans[groupId];
  removeGroupCanvasState(orchestration, groupId);
  synchronizeMainRoutes(orchestration);
  validateDissolvedTopology(orchestration);
}
