import type {
  AgentOrchestrationTemplate,
  CollaborationDissolutionPlan,
  CollaborationNode,
  WorkflowEdge
} from "../../../types";
import { syncMainOuterRoutes, workflowOuterNodeIds } from "./workflow-nodes";

function cloneRoutes(routes: readonly WorkflowEdge[] | undefined): WorkflowEdge[] {
  return (routes ?? []).map((edge) => ({ ...edge }));
}

function routesEqual(left: readonly WorkflowEdge[], right: readonly WorkflowEdge[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function canRestoreCollaborationSnapshot(
  orchestration: AgentOrchestrationTemplate,
  group: CollaborationNode
): boolean {
  const snapshot = group.formationSnapshot;
  if (!snapshot) return false;
  if (Object.entries(snapshot.formedRoutes).some(([source, expected]) =>
    !routesEqual(orchestration.routes[source] ?? [], expected)
  )) return false;
  if (Object.entries(orchestration.routes).some(([source, routes]) =>
    routes.some((edge) => edge.target === group.id) && !(source in snapshot.formedRoutes)
  )) return false;
  if (Boolean(snapshot.inputTarget) !== (orchestration.input.target === group.id)) return false;
  if (Boolean(snapshot.terminationAgent) !== (orchestration.termination.agent === group.id)) return false;
  return true;
}

function clearGroupCanvas(orchestration: AgentOrchestrationTemplate, groupId: string): void {
  if (!orchestration.canvas) return;
  delete orchestration.canvas.nodes[groupId];
  for (const edgeId of Object.keys(orchestration.canvas.edges)) {
    if (edgeId.startsWith(`${groupId}->`) || edgeId.includes(`->${groupId}:`)) {
      delete orchestration.canvas.edges[edgeId];
    }
  }
}

function restorePositions(
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

function validateDissolvedTopology(orchestration: AgentOrchestrationTemplate): void {
  const outerIds = workflowOuterNodeIds(orchestration);
  const outer = new Set(outerIds);
  for (const source of outerIds) {
    const edges = orchestration.routes[source] ?? [];
    if (source !== "main" && edges.length === 0) throw new Error(`${source} 没有解散后的出边`);
    const strong = edges.filter((edge) => edge.kind === "strong");
    if (strong.length > 1 || (strong.length === 1 && edges.length > 1)) {
      throw new Error(`${source} 的强边配置不合法`);
    }
    for (const edge of edges) {
      if (edge.target === source) throw new Error(`${source} 不能指向自身`);
      if (edge.target !== "finish" && !outer.has(edge.target)) throw new Error(`${source} 指向了不存在的节点 ${edge.target}`);
      if (edge.target === "finish" && source !== orchestration.termination.agent) {
        throw new Error("只有终止 Agent 可以连接 finish");
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
  if (unreachable.length) throw new Error(`以下 Agent 不可达：${unreachable.join("、")}`);
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
  if (trapped.length) throw new Error(`以下 Agent 无法到达 finish：${trapped.join("、")}`);
}

export function buildGuidedDissolutionPlan(
  orchestration: AgentOrchestrationTemplate,
  group: CollaborationNode,
  entryAgentId: string,
  exitAgentId: string
): CollaborationDissolutionPlan {
  if (!group.memberAgentIds.includes(entryAgentId) || !group.memberAgentIds.includes(exitAgentId)) {
    throw new Error("入口和出口必须是协作组成员");
  }
  if (group.memberAgentIds.length > 1 && entryAgentId === exitAgentId) {
    throw new Error("入口和出口需要选择不同的 Agent");
  }
  const ordered = [
    entryAgentId,
    ...group.memberAgentIds.filter((member) => member !== entryAgentId && member !== exitAgentId),
    ...(exitAgentId === entryAgentId ? [] : [exitAgentId])
  ];
  const memberRoutes = Object.fromEntries(ordered.map((member, index) => {
    const next = ordered[index + 1];
    if (next) return [member, [{ target: next, kind: "strong" as const }]];
    return [member, cloneRoutes(orchestration.routes[group.id])];
  }));
  const incomingTargetBySource = Object.fromEntries(Object.entries(orchestration.routes)
    .filter(([source, routes]) => source !== group.id && routes.some((edge) => edge.target === group.id))
    .map(([source]) => [source, entryAgentId]));
  const anchor = orchestration.canvas?.nodes[group.id];
  const memberCanvasNodes = anchor
    ? Object.fromEntries(ordered.map((member, index) => [member, {
        x: anchor.x + (index % 2) * 245,
        y: anchor.y + Math.floor(index / 2) * 150
      }]))
    : undefined;
  return {
    mode: "guided",
    incomingTargetBySource,
    memberRoutes,
    ...(orchestration.input.target === group.id ? { inputTarget: entryAgentId } : {}),
    ...(orchestration.termination.agent === group.id ? { terminationAgent: exitAgentId } : {}),
    ...(memberCanvasNodes ? { memberCanvasNodes } : {})
  };
}

export function dissolveCollaborationInDraft(
  orchestration: AgentOrchestrationTemplate,
  groupId: string,
  plan?: CollaborationDissolutionPlan
): void {
  const group = (orchestration.collaborations ?? []).find((entry) => entry.id === groupId);
  if (!group) throw new Error(`找不到协作组 ${groupId}`);
  const snapshot = group.formationSnapshot;
  if (snapshot && canRestoreCollaborationSnapshot(orchestration, group)) {
    for (const memberId of group.memberAgentIds) {
      orchestration.routes[memberId] = cloneRoutes(snapshot.memberRoutes[memberId]);
      orchestration.decisionPlans[memberId] = snapshot.memberDecisionPlans[memberId]
        ?? `结合 ${memberId} Agent 的结果和当前证据，选择下一步路径。`;
    }
    for (const [source, routes] of Object.entries(snapshot.inboundRoutes)) {
      orchestration.routes[source] = cloneRoutes(routes);
    }
    if (orchestration.input.target === groupId && snapshot.inputTarget) {
      orchestration.input.target = snapshot.inputTarget;
    }
    if (orchestration.termination.agent === groupId && snapshot.terminationAgent) {
      orchestration.termination.agent = snapshot.terminationAgent;
    }
    restorePositions(orchestration, group, snapshot.memberCanvasNodes);
  } else {
    if (!plan) throw new Error("当前协作组需要先选择解散后的入口和出口 Agent");
    for (const [source, routes] of Object.entries(orchestration.routes)) {
      if (source === groupId || !routes.some((edge) => edge.target === groupId)) continue;
      const target = plan.incomingTargetBySource[source];
      if (!target || !group.memberAgentIds.includes(target)) throw new Error(`${source} 缺少有效的解散后入口`);
      orchestration.routes[source] = routes.map((edge) => edge.target === groupId ? { ...edge, target } : { ...edge });
    }
    for (const memberId of group.memberAgentIds) {
      if (!plan.memberRoutes[memberId]) throw new Error(`${memberId} 缺少解散后的路由`);
      orchestration.routes[memberId] = cloneRoutes(plan.memberRoutes[memberId]);
      orchestration.decisionPlans[memberId] = snapshot?.memberDecisionPlans[memberId]
        ?? `结合 ${memberId} Agent 的结果和当前证据，选择下一步路径。`;
    }
    if (orchestration.input.target === groupId) orchestration.input.target = plan.inputTarget!;
    if (orchestration.termination.agent === groupId) orchestration.termination.agent = plan.terminationAgent!;
    restorePositions(orchestration, group, plan.memberCanvasNodes);
  }
  orchestration.collaborations = (orchestration.collaborations ?? []).filter((entry) => entry.id !== groupId);
  delete orchestration.routes[groupId];
  delete orchestration.decisionPlans[groupId];
  clearGroupCanvas(orchestration, groupId);
  syncMainOuterRoutes(orchestration);
  validateDissolvedTopology(orchestration);
}

export function dissolutionPlanError(
  orchestration: AgentOrchestrationTemplate,
  group: CollaborationNode,
  plan: CollaborationDissolutionPlan
): string | undefined {
  try {
    dissolveCollaborationInDraft(structuredClone(orchestration), group.id, structuredClone(plan));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "解散后的拓扑不合法";
  }
}
