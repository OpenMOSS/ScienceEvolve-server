import type {
  AgentId,
  AgentOrchestrationTemplateV2,
  AgentOrchestrationTemplateV3,
  NodeRef
} from "./types.js";
import { workflowOuterNodeRefs } from "./agent-orchestration.js";
import { normalizeAgentOrchestrationTemplate } from "./validation.js";

/** Explicit, opt-in migration of the old flat parallel group. It preserves
 * the old outer graph and supplies a direct parallel Input edge for every
 * member. The caller must select a non-business Leader for each group. */
export function upgradeLegacyFlatCollaborations(
  template: AgentOrchestrationTemplateV2,
  leaders: Readonly<Record<string, AgentId>>
): AgentOrchestrationTemplateV3 {
  const legacy = normalizeAgentOrchestrationTemplate(template);
  if (legacy.schemaVersion !== 2) throw new Error("只能迁移 v2 扁平协作组");
  const rootAgentIds = workflowOuterNodeRefs(legacy)
    .filter((ref): ref is Extract<NodeRef, { kind: "agent" }> => ref.kind === "agent")
    .map((ref) => ref.agentId);
  const reservedNodeIds = new Set([
    ...rootAgentIds,
    ...legacy.collaborations.map((group) => group.id)
  ]);
  const groups = legacy.collaborations.map((group, groupIndex) => {
    const leaderAgentId = leaders[group.id];
    if (!leaderAgentId) throw new Error(`迁移协作组 ${group.id} 前必须明确选择 Leader`);
    if (group.memberAgentIds.includes(leaderAgentId)) {
      throw new Error(`协作组 ${group.id} 的 Leader 不能兼任本组业务节点`);
    }
    const nodes = group.memberAgentIds.map((agentId, memberIndex) => {
      let nodeId = `g${groupIndex}a${memberIndex}`;
      while (reservedNodeIds.has(nodeId)) nodeId = `x${nodeId}`;
      reservedNodeIds.add(nodeId);
      return { kind: "agent" as const, nodeId, agentId };
    });
    return {
      id: group.id,
      leaderAgentId,
      decisionBy: "main" as const,
      allowLeaderReconfiguration: false,
      workflow: {
        nodes,
        input: {
          source: "input" as const,
          edges: nodes.map((node) => ({ target: node.nodeId, kind: "parallel" as const }))
        },
        routes: Object.fromEntries(nodes.map((node) => [
          node.nodeId,
          [{ target: "finish", kind: "strong" as const }]
        ]))
      }
    };
  });
  const migrated = normalizeAgentOrchestrationTemplate({
    ...legacy,
    schemaVersion: 3,
    scopedWorkflow: { schemaVersion: 1, rootAgentIds, groups }
  });
  if (migrated.schemaVersion !== 3) throw new Error("协作组迁移未生成 v3 配置");
  return migrated;
}
