import { describe, expect, it } from "vitest";
import type { ScopedWorkflowContract } from "../src/scoped-workflow-contract.js";
import { scopedWorkerCapacity } from "../src/scoped-workflow-capacity.js";

describe("scoped worker capacity", () => {
  it("counts one Agent once across root and nested groups and caps the shared pool at ten", () => {
    expect(() => scopedWorkerCapacity(undefined)).toThrow(/missing/);
    const agents = Array.from({ length: 12 }, (_, index) => `agent_${index + 1}`);
    const contract: ScopedWorkflowContract = {
      schemaVersion: 1,
      rootAgentIds: ["main", agents[0]!],
      groups: [
        {
          id: "G", leaderAgentId: "main", allowLeaderReconfiguration: false,
          workflow: {
            nodes: agents.map((agentId, index) => ({
              kind: "agent" as const, nodeId: `G_${index}`, agentId
            })),
            input: { source: "input", edges: [] }, routes: {}
          }
        },
        {
          id: "H", parentGroupId: "G", leaderAgentId: "main", allowLeaderReconfiguration: false,
          workflow: {
            nodes: [{ kind: "agent", nodeId: "H_same_agent", agentId: agents[0]! }],
            input: { source: "input", edges: [] }, routes: {}
          }
        }
      ]
    };
    expect(scopedWorkerCapacity(contract)).toBe(10);
    contract.groups[0]!.workflow.nodes = contract.groups[0]!.workflow.nodes.slice(0, 2);
    expect(scopedWorkerCapacity(contract)).toBe(2);
    contract.groups = [];
    expect(scopedWorkerCapacity(contract)).toBe(1);
    contract.rootAgentIds = ["main"];
    expect(scopedWorkerCapacity(contract)).toBe(1);
  });
});
