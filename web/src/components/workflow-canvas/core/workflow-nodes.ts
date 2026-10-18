import type {
  AgentDefinition,
  AgentId,
  AgentOrchestrationTemplate,
  CollaborationNode,
  NodeRef,
  Project,
  WorkflowNodeId
} from "../../../types";

export interface WorkflowOuterNode {
  id: WorkflowNodeId;
  kind: "agent" | "collaboration";
  displayName: string;
  definition?: AgentDefinition;
  collaboration?: CollaborationNode;
}

/** v3 membership belongs to the scoped graph; legacy display lists may be empty. */
export function collaborationMemberRefs(
  orchestration: Pick<AgentOrchestrationTemplate, "schemaVersion" | "scopedWorkflow">,
  group: CollaborationNode
): NodeRef[] {
  if (orchestration.schemaVersion === 3) {
    return orchestration.scopedWorkflow?.groups.find((entry) => entry.id === group.id)?.workflow.nodes ?? [];
  }
  return group.memberAgentIds.map((agentId) => ({ kind: "agent", nodeId: agentId, agentId }));
}

/** Every configured worker remains in the registry, but a member is not routable. */
export function collaborationMemberIds(
  orchestration: Pick<AgentOrchestrationTemplate, "collaborations" | "schemaVersion">
): Set<AgentId> {
  if (orchestration.schemaVersion === 3) return new Set();
  return new Set(
    (orchestration.collaborations ?? []).flatMap((group) => group.memberAgentIds)
  );
}

export function collaborationForAgent(
  orchestration: Pick<AgentOrchestrationTemplate, "collaborations" | "schemaVersion">,
  agentId: AgentId
): CollaborationNode | undefined {
  if (orchestration.schemaVersion === 3) return undefined;
  return (orchestration.collaborations ?? []).find((group) =>
    group.memberAgentIds.includes(agentId)
  );
}

/**
 * Mirror the server's v2 projection. A group occupies the position of its
 * first registry member, which keeps legacy ordering stable while ensuring
 * members never become outer nodes.
 */
export function workflowOuterNodes(
  orchestration: Pick<AgentOrchestrationTemplate, "agents" | "collaborations" | "schemaVersion" | "scopedWorkflow">
): WorkflowOuterNode[] {
  if (orchestration.schemaVersion === 3 && orchestration.scopedWorkflow) {
    const definitions = new Map(orchestration.agents.map((entry) => [entry.name, entry]));
    const displays = new Map((orchestration.collaborations ?? []).map((entry) => [entry.id, entry]));
    return [
      ...orchestration.scopedWorkflow.rootAgentIds.map((id) => ({
        id, kind: "agent" as const, displayName: id, definition: definitions.get(id)
      })),
      ...orchestration.scopedWorkflow.groups.filter((group) => !group.parentGroupId).map((group) => ({
        id: group.id,
        kind: "collaboration" as const,
        displayName: displays.get(group.id)?.displayName ?? group.id,
        collaboration: displays.get(group.id)
      }))
    ];
  }
  const groups = orchestration.collaborations ?? [];
  const groupByMember = new Map<AgentId, CollaborationNode>();
  for (const group of groups) {
    for (const member of group.memberAgentIds) groupByMember.set(member, group);
  }
  const emittedGroups = new Set<string>();
  const result: WorkflowOuterNode[] = [];
  for (const definition of orchestration.agents) {
    if (definition.name === "main") {
      result.push({
        id: definition.name,
        kind: "agent",
        displayName: definition.name,
        definition
      });
      continue;
    }
    const group = groupByMember.get(definition.name);
    if (!group) {
      result.push({
        id: definition.name,
        kind: "agent",
        displayName: definition.name,
        definition
      });
      continue;
    }
    if (!emittedGroups.has(group.id)) {
      emittedGroups.add(group.id);
      result.push({
        id: group.id,
        kind: "collaboration",
        displayName: group.displayName,
        collaboration: group
      });
    }
  }
  // Invalid/unfinished drafts can contain a group whose members are unknown.
  // Keep the node visible so the Inspector can report and repair it.
  for (const group of groups) {
    if (emittedGroups.has(group.id)) continue;
    emittedGroups.add(group.id);
    result.push({
      id: group.id,
      kind: "collaboration",
      displayName: group.displayName,
      collaboration: group
    });
  }
  return result;
}

export function workflowOuterNodeIds(
  orchestration: Pick<AgentOrchestrationTemplate, "agents" | "collaborations" | "schemaVersion" | "scopedWorkflow">
): WorkflowNodeId[] {
  return workflowOuterNodes(orchestration).map((node) => node.id);
}

export function workflowNodeRef(
  orchestration: Pick<AgentOrchestrationTemplate, "agents" | "collaborations" | "schemaVersion" | "scopedWorkflow">,
  nodeId: WorkflowNodeId
): NodeRef | undefined {
  const node = workflowOuterNodes(orchestration).find((entry) => entry.id === nodeId);
  if (!node) return undefined;
  return node.kind === "collaboration"
    ? { kind: "collaboration", nodeId: node.id, groupId: node.id }
    : { kind: "agent", nodeId: node.id, agentId: node.id };
}

export function workflowNodeDisplayName(
  orchestration: Pick<AgentOrchestrationTemplate, "agents" | "collaborations" | "schemaVersion" | "scopedWorkflow">,
  nodeId: WorkflowNodeId
): string {
  const node = workflowOuterNodes(orchestration).find((entry) => entry.id === nodeId);
  return node?.displayName || nodeId;
}

export function syncMainOuterRoutes(orchestration: AgentOrchestrationTemplate): void {
  orchestration.routes = { ...orchestration.routes };
  orchestration.routes.main = workflowOuterNodeIds(orchestration)
    .filter((id) => id !== "main")
    .map((target) => ({ target, kind: "weak" as const }));
}

/** Groups stay immutable while any current run or its final PR is non-terminal. */
export function lockedCollaborationIds(
  project: Pick<Project, "orchestration" | "nodeRuns" | "groupRuns" | "pullRequests">
): Set<string> {
  const locked = new Set<string>();
  const pulls = new Map((project.pullRequests ?? []).map((pull) => [pull.id, pull]));
  for (const group of project.orchestration.collaborations ?? []) {
    const nodeRunIds = new Set((project.nodeRuns ?? [])
      .filter((run) => run.node.kind === "collaboration" && run.node.nodeId === group.id)
      .map((run) => run.id));
    const runs = (project.groupRuns ?? []).filter((run) => nodeRunIds.has(run.nodeRunId));
    const latest = runs.at(-1);
    if (!latest) continue;
    const terminal = latest.status === "completed" || latest.status === "failed" || latest.status === "cancelled";
    const finalPull = latest.finalPullRequestId ? pulls.get(latest.finalPullRequestId) : undefined;
    // Successful completion is only editable again after the authoritative
    // final PR fact says merged. A dangling PR id (or a completed run without
    // one) is deliberately fail-closed while the server reconciles facts.
    const finalDeliverySettled = latest.status === "completed"
      ? Boolean(latest.finalPullRequestId && finalPull?.status === "merged")
      : !latest.finalPullRequestId || Boolean(finalPull && ["merged", "closed"].includes(finalPull.status));
    if (!terminal || !finalDeliverySettled) locked.add(group.id);
  }
  return locked;
}
