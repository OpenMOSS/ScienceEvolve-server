import type {
  AgentOrchestrationTemplate,
  CollaborationNode,
  NodeRef,
  ScopedCollaboration,
  ScopedWorkflow,
  ScopedWorkflowContract,
  WorkflowCanvasLayout,
  WorkflowEdge
} from "../../../types";
import { validateWorkflowLoops, workflowLoopMembers } from "../../../../../server/src/internal/shared/workflow-loop-validation.js";
import { workflowOuterNodes } from "./workflow-nodes";
import { canvasEdgeId } from "./canvas-layout";

/** Browser-side preflight mirrors the server's scoped contract. The server is
 * still authoritative at save/start and rejects forged or stale graphs. */
export function scopedWorkflowError(
  contract: ScopedWorkflowContract | undefined,
  agentIds: ReadonlySet<string>,
  strict = true
): string | undefined {
  if (!contract || contract.schemaVersion !== 1 || !Array.isArray(contract.rootAgentIds) || !Array.isArray(contract.groups)) {
    return "组内 Workflow 合同无效";
  }
  if (contract.rootAgentIds[0] !== "main" || new Set(contract.rootAgentIds).size !== contract.rootAgentIds.length) {
    return "根图必须以唯一 main Agent 开始";
  }
  if (contract.rootAgentIds.some((id) => !agentIds.has(id))) return "根图引用了不存在的 Agent";
  const groups = new Map<string, ScopedCollaboration>();
  for (const group of contract.groups) {
    if (groups.has(group.id)) return `协作组 ${group.id} 重复`;
    if (!agentIds.has(group.leaderAgentId)) return `${group.id} 的 Leader 不存在`;
    groups.set(group.id, group);
  }
  const usedNodes = new Set([...contract.rootAgentIds, ...contract.groups.filter((group) => !group.parentGroupId).map((group) => group.id)]);
  for (const group of contract.groups) {
    const seenParents = new Set([group.id]);
    let parentId = group.parentGroupId;
    while (parentId) {
      if (seenParents.has(parentId)) return `${group.id} 形成包含环`;
      seenParents.add(parentId);
      const parent = groups.get(parentId);
      if (!parent) return `${group.id} 的父组不存在`;
      parentId = parent.parentGroupId;
    }
    if (group.parentGroupId) {
      const parent = groups.get(group.parentGroupId)!;
      if (parent.workflow.nodes.filter((ref) => ref.kind === "collaboration" && ref.groupId === group.id).length !== 1) {
        return `子协作组 ${group.id} 必须在父组中恰好有一个节点引用`;
      }
      // Definition validation uses project identities; reconfiguration separately enforces scope authority.
    }
    const workflow = group.workflow;
    if (!workflow || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.input?.edges) || !workflow.routes) {
      return `${group.id} 的内部 Workflow 无效`;
    }
    const direct = new Map<string, NodeRef>();
    for (const ref of workflow.nodes) {
      if (direct.has(ref.nodeId) || usedNodes.has(ref.nodeId)) return `图节点 ${ref.nodeId} 重复`;
      usedNodes.add(ref.nodeId);
      direct.set(ref.nodeId, ref);
      if (ref.kind === "agent" && (!agentIds.has(ref.agentId) || ref.agentId === "main")) {
        return `${group.id} 的业务节点引用了无效 Agent`;
      }
      if (ref.kind === "collaboration" && groups.get(ref.groupId)?.parentGroupId !== group.id) {
        return `${group.id} 的子组节点 ${ref.nodeId} 不属于本组`;
      }
    }
    if (strict && !workflow.input.edges.length) return `${group.id} 的 Input 至少需要一条并行入口边`;
    const inputTargets = new Set<string>();
    for (const edge of workflow.input.edges) {
      if (edge.kind !== "parallel" || !direct.has(edge.target)) return `${group.id} 的并行入口 ${edge.target} 不属于本组`;
      if (inputTargets.has(edge.target)) return `${group.id} 的并行入口 ${edge.target} 重复`;
      inputTargets.add(edge.target);
    }
    let hasFinish = false;
    for (const [source, edges] of Object.entries(workflow.routes)) {
      if (!direct.has(source) || !Array.isArray(edges)) return `${group.id} 的路由源 ${source} 不属于本组`;
      if (edges.filter((edge) => edge.kind === "strong").length > 1 ||
        (edges.some((edge) => edge.kind === "strong") && edges.length > 1)) return `${group.id} 的 ${source} 强边必须为唯一出边`;
      const targets = new Set<string>();
      for (const edge of edges) {
        if (edge.kind !== "strong" && edge.kind !== "weak") return `${group.id} 只有 Input 可以发出并行边`;
        if (edge.target !== "finish" && !direct.has(edge.target)) return `${group.id} 的出边目标 ${edge.target} 不属于本组`;
        if (edge.target === source || targets.has(edge.target)) return `${group.id} 的 ${source} 存在无效或重复出边`;
        targets.add(edge.target);
        if (edge.target === "finish") hasFinish = true;
      }
    }
    if (strict && !hasFinish) return `${group.id} 的路径必须至少有一条通向 Finish 的边`;
    if (strict) {
      const reachable = new Set<string>();
      const pending = workflow.input.edges.map((edge) => edge.target);
      while (pending.length) {
        const current = pending.pop()!;
        if (!direct.has(current) || reachable.has(current)) continue;
        reachable.add(current);
        for (const edge of [...(workflow.routes[current] ?? []), ...(workflow.loops ?? [])
          .filter((loop) => loop.from === current).map((loop) => ({ target: loop.exitTo }))]) {
          if (edge.target !== "finish") pending.push(edge.target);
        }
      }
      for (const id of direct.keys()) {
        if (!reachable.has(id)) return `${group.id} 的图节点 ${id} 无法从 Input 到达`;
        if (!(workflow.routes[id]?.length)) return `${group.id} 的图节点 ${id} 缺少出边`;
      }
      const canFinish = new Set<string>();
      const reverse = new Map<string, string[]>();
      for (const [source, edges] of Object.entries(workflow.routes)) {
        for (const edge of [...edges, ...(workflow.loops ?? [])
          .filter((loop) => loop.from === source).map((loop) => ({ target: loop.exitTo }))]) {
          if (edge.target === "finish") canFinish.add(source);
          else reverse.set(edge.target, [...(reverse.get(edge.target) ?? []), source]);
        }
      }
      const finishQueue = [...canFinish];
      while (finishQueue.length) {
        for (const source of reverse.get(finishQueue.pop()!) ?? []) {
          if (!canFinish.has(source)) { canFinish.add(source); finishQueue.push(source); }
        }
      }
      for (const id of reachable) if (!canFinish.has(id)) return `${group.id} 的图节点 ${id} 没有通向 Finish 的路径`;
    }
    for (const loop of workflow.loops ?? []) {
      if (![loop.from, loop.to, loop.exitTo].every((id) => direct.has(id))) return `${group.id} 的 Loop 不能跨越组范围`;
      if (workflowLoopMembers(workflow, loop).some((id) => direct.get(id)?.kind !== "agent")) {
        return `${group.id} 的 Loop 仅支持普通 Agent，不能把子协作组当作 Loop Worker`;
      }
    }
    const loopIssue = validateWorkflowLoops({
      agents: workflow.nodes.map((ref) => ({ name: ref.nodeId })),
      routes: workflow.routes,
      loops: workflow.loops,
      termination: { agent: "finish" }
    })[0];
    if (loopIssue) return `${group.id} 的 Loop ${loopIssue.loopId}：${loopIssue.message}`;
  }
  for (const group of contract.groups) {
    for (const descendant of contract.groups) {
      let current: ScopedCollaboration | undefined = descendant;
      const seen = new Set<string>();
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        if (current.id === group.id) {
          if (descendant.workflow.nodes.some((ref) => ref.kind === "agent" && ref.agentId === group.leaderAgentId)) {
            return `${group.id} 的 Leader 不能兼任本组业务节点`;
          }
          break;
        }
        current = current.parentGroupId ? groups.get(current.parentGroupId) : undefined;
      }
    }
  }
  return undefined;
}

/** Explicit legacy conversion: old members remain hidden at root, preserving
 * the old outer graph. Every legacy group receives a chosen non-business Leader. */
export function upgradeLegacyGroups(
  draft: AgentOrchestrationTemplate,
  leaders: Readonly<Record<string, string>> = {}
): void {
  if (draft.schemaVersion === 3 && draft.scopedWorkflow) return;
  const rootAgentIds = workflowOuterNodes(draft).filter((node) => node.kind === "agent").map((node) => node.id);
  const reserved = new Set([...rootAgentIds, ...(draft.collaborations ?? []).map((group) => group.id)]);
  const groups: ScopedCollaboration[] = (draft.collaborations ?? []).map((group) => {
    const leaderAgentId = leaders[group.id];
    if (!leaderAgentId || group.memberAgentIds.includes(leaderAgentId)) {
      throw new Error(`请先为旧协作组 ${group.displayName} 指定非成员 Leader`);
    }
    const nodes = group.memberAgentIds.map((agentId) => ({
      kind: "agent" as const,
      nodeId: uniqueScopedNodeId(group.id, agentId, reserved),
      agentId
    }));
    return {
      id: group.id,
      leaderAgentId,
      decisionBy: "main",
      allowLeaderReconfiguration: false,
      workflow: {
        nodes,
        input: { source: "input", edges: nodes.map((ref) => ({ kind: "parallel", target: ref.nodeId })) },
        routes: Object.fromEntries(nodes.map((ref) => [ref.nodeId, [{ target: "finish", kind: "strong" }]])),
        canvas: defaultScopedCanvas(nodes.map((ref) => ref.nodeId), nodes.map((ref) => ref.nodeId))
      }
    };
  });
  draft.schemaVersion = 3;
  draft.scopedWorkflow = { schemaVersion: 1, rootAgentIds, groups };
}

export function addScopedGroup(
  draft: AgentOrchestrationTemplate,
  input: { id: string; displayName: string; parentGroupId?: string; leaderAgentId: string; memberAgentIds: string[] }
): void {
  if (!draft.scopedWorkflow || draft.schemaVersion !== 3) throw new Error("请先启用组内 Workflow");
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(input.id) || input.id.length > 64) {
    throw new Error("协作组 ID 只能包含字母、数字、下划线或连字符，且不能超过 64 字符");
  }
  if ((draft.collaborations ?? []).some((entry) => entry.id === input.id) || draft.agents.some((entry) => entry.name === input.id)) {
    throw new Error("协作组 ID 与已有节点重复");
  }
  if (input.memberAgentIds.length < 2 || new Set(input.memberAgentIds).size !== input.memberAgentIds.length) {
    throw new Error("协作组至少需要两个不同的业务 Agent");
  }
  if (input.memberAgentIds.includes(input.leaderAgentId)) throw new Error("Leader 不能兼任本组业务节点");
  const parent = input.parentGroupId
    ? draft.scopedWorkflow.groups.find((entry) => entry.id === input.parentGroupId)
    : undefined;
  if (input.parentGroupId && !parent) throw new Error("父协作组不存在");
  const allowed = parent
    ? new Set([...parent.workflow.nodes.filter((ref): ref is Extract<NodeRef, { kind: "agent" }> => ref.kind === "agent").map((ref) => ref.agentId), parent.leaderAgentId])
    : new Set(draft.agents.map((agent) => agent.name));
  if (![...input.memberAgentIds, input.leaderAgentId].every((id) => allowed.has(id))) {
    throw new Error("只能引用当前范围已有的 Agent");
  }
  const reserved = new Set([
    ...draft.scopedWorkflow.rootAgentIds,
    ...draft.scopedWorkflow.groups.map((group) => group.id),
    ...draft.scopedWorkflow.groups.flatMap((group) => group.workflow.nodes.map((ref) => ref.nodeId))
  ]);
  reserved.add(input.id);
  const nodes: NodeRef[] = input.memberAgentIds.map((agentId) => ({
    kind: "agent", nodeId: uniqueScopedNodeId(input.id, agentId, reserved), agentId
  }));
  const group: ScopedCollaboration = {
    id: input.id,
    ...(input.parentGroupId ? { parentGroupId: input.parentGroupId } : {}),
    leaderAgentId: input.leaderAgentId,
    decisionBy: "main",
    allowLeaderReconfiguration: false,
    workflow: {
      nodes,
      input: { source: "input", edges: nodes.map((ref) => ({ kind: "parallel", target: ref.nodeId })) },
      routes: Object.fromEntries(nodes.map((ref) => [ref.nodeId, [{ target: "finish", kind: "strong" }]])),
      canvas: defaultScopedCanvas(nodes.map((ref) => ref.nodeId), nodes.map((ref) => ref.nodeId))
    }
  };
  draft.scopedWorkflow.groups.push(group);
  const registry: CollaborationNode = {
    id: input.id,
    displayName: input.displayName,
    memberAgentIds: [...input.memberAgentIds],
    renamePolicy: "editable"
  };
  draft.collaborations = [...(draft.collaborations ?? []), registry];
  if (parent) {
    parent.workflow.nodes.push({ kind: "collaboration", nodeId: input.id, groupId: input.id });
    parent.workflow.routes[input.id] = [];
    parent.workflow.canvas = addCanvasNode(parent.workflow.canvas, input.id, parent.workflow.nodes.length);
  } else {
    draft.routes[input.id] = [];
    draft.decisionPlans[input.id] = `结合 ${input.displayName} 的集成结果选择下一步外层节点。`;
  }
}

export function addScopedAgentReference(draft: AgentOrchestrationTemplate, groupId: string, agentId: string): string {
  const contract = draft.scopedWorkflow;
  const group = contract?.groups.find((entry) => entry.id === groupId);
  if (!contract || !group || !draft.agents.some((entry) => entry.name === agentId)) throw new Error("Agent 或协作组不存在");
  if (agentId === "main" || group.leaderAgentId === agentId) throw new Error("Main 或本组 Leader 不能作为业务节点");
  if (group.parentGroupId) {
    const parent = contract.groups.find((entry) => entry.id === group.parentGroupId);
    if (!parent?.workflow.nodes.some((ref) => ref.kind === "agent" && ref.agentId === agentId)) {
      throw new Error("子组只能引用父组范围内已有的业务 Agent");
    }
  }
  const ancestors = new Set<string>();
  let current: ScopedCollaboration | undefined = group;
  while (current && !ancestors.has(current.id)) {
    ancestors.add(current.id);
    if (current.leaderAgentId === agentId) throw new Error(`${current.id} 的 Leader 不能兼任业务节点`);
    current = current.parentGroupId ? contract.groups.find((entry) => entry.id === current!.parentGroupId) : undefined;
  }
  const reserved = new Set([...contract.rootAgentIds, ...contract.groups.map((entry) => entry.id), ...contract.groups.flatMap((entry) => entry.workflow.nodes.map((ref) => ref.nodeId))]);
  const nodeId = uniqueScopedNodeId(groupId, agentId, reserved);
  group.workflow.nodes.push({ kind: "agent", nodeId, agentId });
  group.workflow.routes[nodeId] = [];
  group.workflow.canvas = addCanvasNode(group.workflow.canvas, nodeId, group.workflow.nodes.length);
  const registry = draft.collaborations?.find((entry) => entry.id === groupId);
  if (registry && !registry.memberAgentIds.includes(agentId)) registry.memberAgentIds.push(agentId);
  return nodeId;
}

export function removeScopedNode(draft: AgentOrchestrationTemplate, groupId: string, nodeId: string): void {
  const group = draft.scopedWorkflow?.groups.find((entry) => entry.id === groupId);
  const ref = group?.workflow.nodes.find((entry) => entry.nodeId === nodeId);
  if (!group || !ref) throw new Error("组内节点不存在");
  if (ref.kind === "collaboration") throw new Error("请先处理子协作组，不能仅删除它的父图引用");
  group.workflow.nodes = group.workflow.nodes.filter((entry) => entry.nodeId !== nodeId);
  group.workflow.input.edges = group.workflow.input.edges.filter((edge) => edge.target !== nodeId);
  delete group.workflow.routes[nodeId];
  for (const [source, edges] of Object.entries(group.workflow.routes)) {
    group.workflow.routes[source] = edges.filter((edge) => edge.target !== nodeId);
  }
  group.workflow.loops = group.workflow.loops?.filter((loop) => ![loop.from, loop.to, loop.exitTo].includes(nodeId));
  if (group.workflow.canvas) {
    delete group.workflow.canvas.nodes[nodeId];
    group.workflow.canvas.edges = Object.fromEntries(Object.entries(group.workflow.canvas.edges).filter(([id]) => !id.startsWith(`${nodeId}->`) && !id.includes(`->${nodeId}:`)));
  }
  const registry = draft.collaborations?.find((entry) => entry.id === groupId);
  if (registry && !group.workflow.nodes.some((entry) => entry.kind === "agent" && entry.agentId === ref.agentId)) {
    registry.memberAgentIds = registry.memberAgentIds.filter((id) => id !== ref.agentId);
  }
}

export function addScopedRoute(workflow: ScopedWorkflow, source: string, target: string, kind: "parallel" | "strong" | "weak"): void {
  const direct = new Set(workflow.nodes.map((entry) => entry.nodeId));
  if (source === "input") {
    if (kind !== "parallel" || !direct.has(target)) throw new Error("只有本组 Input 可以发出并行边，目标必须属于本组");
    if (workflow.input.edges.some((edge) => edge.target === target)) throw new Error("并行入口已存在");
    workflow.input.edges.push({ kind: "parallel", target });
    return;
  }
  if (!direct.has(source) || (target !== "finish" && !direct.has(target))) throw new Error("不能连接父组、祖先组或其他范围的节点");
  if (source === target || kind === "parallel") throw new Error("普通节点不能发出并行边或连接自身");
  const existing = workflow.routes[source] ?? [];
  if (existing.some((edge) => edge.target === target)) throw new Error("连线已存在");
  if (kind === "strong" && existing.length || existing.some((edge) => edge.kind === "strong")) {
    throw new Error("强边必须是唯一出边");
  }
  workflow.routes[source] = [...existing, { target, kind } as WorkflowEdge];
}

export function removeScopedRoute(workflow: ScopedWorkflow, source: string, target: string): void {
  if (source === "input") workflow.input.edges = workflow.input.edges.filter((edge) => edge.target !== target);
  else workflow.routes[source] = (workflow.routes[source] ?? []).filter((edge) => edge.target !== target);
  if (workflow.canvas) delete workflow.canvas.edges[canvasEdgeId(source, target)];
}

export function defaultScopedCanvas(nodeIds: string[], inputTargets: string[]): WorkflowCanvasLayout {
  const nodes: WorkflowCanvasLayout["nodes"] = {
    input: { x: 40, y: 300 },
    finish: { x: 1110, y: 300 }
  };
  nodeIds.forEach((id, index) => { nodes[id] = { x: 360 + Math.floor(index / 4) * 270, y: 55 + (index % 4) * 170 }; });
  const edges: WorkflowCanvasLayout["edges"] = {};
  for (const target of inputTargets) edges[canvasEdgeId("input", target)] = { sourcePort: "right", targetPort: "left", sourcePortPinned: false, targetPortPinned: false };
  for (const id of nodeIds) edges[canvasEdgeId(id, "finish")] = { sourcePort: "right", targetPort: "left", sourcePortPinned: false, targetPortPinned: false };
  return { schemaVersion: 1, nodes, edges, viewport: { x: 0, y: 0, zoom: 0.82 }, layoutMode: "free" };
}

function addCanvasNode(canvas: WorkflowCanvasLayout | undefined, id: string, index: number): WorkflowCanvasLayout {
  const result = canvas ?? defaultScopedCanvas([], []);
  result.nodes[id] = { x: 360 + Math.floor(index / 4) * 270, y: 55 + (index % 4) * 170 };
  return result;
}

function uniqueScopedNodeId(groupId: string, agentId: string, reserved: Set<string>): string {
  const stem = `${groupId.slice(0, 22)}_${agentId.slice(0, 22)}`;
  let id = stem;
  let suffix = 2;
  while (reserved.has(id)) id = `${stem}_${suffix++}`;
  reserved.add(id);
  return id;
}
