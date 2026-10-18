import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_ORCHESTRATION } from "../../../lib";
import type { ScopedWorkflowContract } from "../../../types";
import { workflowOuterNodeIds } from "./workflow-nodes";
import {
  addScopedAgentReference,
  addScopedGroup,
  addScopedRoute,
  removeScopedNode,
  scopedWorkflowError,
  upgradeLegacyGroups
} from "./scoped-workflow";

const agents = new Set(DEFAULT_AGENT_ORCHESTRATION.agents.map((item) => item.name));

describe("scoped Workflow browser contract", () => {
  it("keeps outer Agent identities when a group is created and allows a nested group", () => {
    const draft = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(draft);
    addScopedGroup(draft, { id: "research", displayName: "Research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"] });
    expect(draft.schemaVersion).toBe(3);
    expect(draft.scopedWorkflow?.rootAgentIds).toEqual(["main", "idea", "execution", "writing", "review"]);
    expect(workflowOuterNodeIds(draft)).toContain("idea");
    expect(workflowOuterNodeIds(draft)).toContain("research");
    expect(draft.scopedWorkflow?.groups[0]?.workflow.input.edges).toHaveLength(2);
    expect(scopedWorkflowError(draft.scopedWorkflow, agents)).toBeUndefined();

    addScopedGroup(draft, { id: "inner", displayName: "Inner", parentGroupId: "research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"] });
    expect(() => addScopedAgentReference(draft, "inner", "writing")).toThrow(/父组范围/);
    const parent = draft.scopedWorkflow!.groups[0]!;
    expect(parent.workflow.nodes).toContainEqual({ kind: "collaboration", nodeId: "inner", groupId: "inner" });
    expect(scopedWorkflowError(draft.scopedWorkflow, agents, false)).toBeUndefined();
    addScopedRoute(parent.workflow, "inner", "finish", "weak");
    addScopedRoute(parent.workflow, "input", "inner", "parallel");
    expect(scopedWorkflowError(draft.scopedWorkflow, agents)).toBeUndefined();
    expect(workflowOuterNodeIds(draft)).not.toContain("inner");
  });

  it("rejects mid-flow parallel and cross-scope routes without mutating the graph", () => {
    const draft = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(draft);
    addScopedGroup(draft, { id: "research", displayName: "Research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"] });
    const graph = draft.scopedWorkflow!.groups[0]!.workflow;
    const idea = graph.nodes.find((item) => item.kind === "agent" && item.agentId === "idea")!.nodeId;
    expect(() => addScopedRoute(graph, idea, "writing", "parallel")).toThrow(/不能连接|并行/);
    expect(() => addScopedRoute(graph, "input", "writing", "parallel")).toThrow(/本组/);
    expect(graph.input.edges).toHaveLength(2);
  });

  it("accepts a nested definition with distinct members and Main as a child Leader", () => {
    const contract: ScopedWorkflowContract = {
      schemaVersion: 1 as const,
      rootAgentIds: ["main", "review"],
      groups: [
        { id: "parent", leaderAgentId: "review", allowLeaderReconfiguration: false,
          workflow: { nodes: [{ kind: "collaboration" as const, nodeId: "child_ref", groupId: "child" }],
            input: { source: "input" as const, edges: [{ target: "child_ref", kind: "parallel" as const }] },
            routes: { child_ref: [{ target: "finish", kind: "strong" as const }] } } },
        { id: "child", parentGroupId: "parent", leaderAgentId: "main", allowLeaderReconfiguration: false,
          workflow: { nodes: [{ kind: "agent" as const, nodeId: "child_work", agentId: "idea" }],
            input: { source: "input" as const, edges: [{ target: "child_work", kind: "parallel" as const }] },
            routes: { child_work: [{ target: "finish", kind: "strong" as const }] } } }
      ]
    };
    expect(scopedWorkflowError(contract, agents)).toBeUndefined();
    contract.groups[1]!.workflow.nodes[0] = { kind: "agent", nodeId: "child_work", agentId: "missing" };
    expect(scopedWorkflowError(contract, agents)).toContain("无效 Agent");
  });

  it("removes only one reference and preserves the Agent identity and outer session placement", () => {
    const draft = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(draft);
    addScopedGroup(draft, { id: "research", displayName: "Research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"] });
    const extra = addScopedAgentReference(draft, "research", "writing");
    removeScopedNode(draft, "research", extra);
    expect(draft.agents.some((item) => item.name === "writing")).toBe(true);
    expect(draft.scopedWorkflow?.rootAgentIds).toContain("writing");
    expect(draft.scopedWorkflow?.groups[0]?.workflow.nodes.some((item) => item.nodeId === extra)).toBe(false);
    expect(scopedWorkflowError(draft.scopedWorkflow, agents)).toBeUndefined();
  });

  it("requires explicit Leader choice when upgrading legacy groups", () => {
    const draft = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    draft.collaborations = [{ id: "legacy", displayName: "Legacy", memberAgentIds: ["idea", "execution"], renamePolicy: "editable" }];
    expect(() => upgradeLegacyGroups(draft)).toThrow(/Leader/);
    upgradeLegacyGroups(draft, { legacy: "main" });
    expect(draft.scopedWorkflow?.groups[0]?.leaderAgentId).toBe("main");
  });

  it("accepts more than fifty distinct worker identities without a configuration cap", () => {
    const workerIds = Array.from({ length: 60 }, (_, index) => `agent_${index + 1}`);
    const contract = { schemaVersion: 1 as const, rootAgentIds: ["main", ...workerIds], groups: [] };
    expect(scopedWorkflowError(contract, new Set(contract.rootAgentIds))).toBeUndefined();
  });

  it("uses the same implicit Loop exit reachability as the authoritative server", () => {
    const draft = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(draft);
    addScopedGroup(draft, { id: "cycle", displayName: "Cycle", leaderAgentId: "main",
      memberAgentIds: ["idea", "execution", "writing"] });
    const graph = draft.scopedWorkflow!.groups[0]!.workflow;
    const [first, second, exit] = graph.nodes.map((node) => node.nodeId);
    graph.input.edges = [{ kind: "parallel", target: first! }];
    graph.routes = { [first!]: [{ kind: "strong", target: second! }],
      [second!]: [{ kind: "strong", target: first! }], [exit!]: [{ kind: "strong", target: "finish" }] };
    graph.loops = [{ id: "cycle", from: second!, to: first!, maxIterations: 2, exitTo: exit! }];
    expect(scopedWorkflowError(draft.scopedWorkflow, agents)).toBeUndefined();
  });
});
