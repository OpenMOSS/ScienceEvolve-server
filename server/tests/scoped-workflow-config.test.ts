import { describe, expect, it } from "vitest";
import { cloneAgentOrchestrationTemplate, workflowOuterNodeIds } from "../src/agent-orchestration.js";
import { normalizeAgentOrchestrationTemplate } from "../src/validation.js";
import { upgradeLegacyFlatCollaborations } from "../src/scoped-workflow-migration.js";
import type { AgentOrchestrationTemplateV2 } from "../src/types.js";

function v3Example() {
  const template = cloneAgentOrchestrationTemplate() as Record<string, unknown>;
  const agents = template.agents as Array<{ name: string }>;
  template.schemaVersion = 3;
  template.collaborations = [{ id: "G", displayName: "G", memberAgentIds: [], renamePolicy: "editable" }];
  template.scopedWorkflow = {
    schemaVersion: 1,
    rootAgentIds: agents.map((agent) => agent.name),
    groups: [{
      id: "G",
      leaderAgentId: "main",
      allowLeaderReconfiguration: false,
      workflow: {
        nodes: [
          { kind: "agent", nodeId: "G_idea", agentId: "idea" },
          { kind: "agent", nodeId: "G_execution", agentId: "execution" }
        ],
        input: { source: "input", edges: [{ kind: "parallel", target: "G_idea" }] },
        routes: {
          G_idea: [{ kind: "strong", target: "G_execution" }],
          G_execution: [{ kind: "strong", target: "finish" }]
        }
      }
    }]
  };
  (template.routes as Record<string, unknown>).G = [{ target: "main", kind: "strong" }];
  return template;
}

describe("v3 scoped workflow configuration", () => {
  it("keeps the outer Agent when the same identity is referenced inside a group", () => {
    const template = normalizeAgentOrchestrationTemplate(v3Example());
    expect(template.schemaVersion).toBe(3);
    expect(workflowOuterNodeIds(template)).toContain("idea");
    expect(workflowOuterNodeIds(template)).toContain("G");
    expect(template.routes.main.some((edge) => edge.target === "idea")).toBe(true);
    expect(template.routes.main.some((edge) => edge.target === "G")).toBe(true);
  });

  it("does not admit parallel edges in the outer graph", () => {
    const template = v3Example();
    (template.routes as Record<string, unknown>).idea = [{ target: "G", kind: "parallel" }];
    expect(() => normalizeAgentOrchestrationTemplate(template)).toThrow();
  });

  it("rejects a nested group omitted from the scoped registry", () => {
    const template = v3Example();
    (template.collaborations as Array<unknown>).push({ id: "H", displayName: "H", memberAgentIds: [], renamePolicy: "editable" });
    expect(() => normalizeAgentOrchestrationTemplate(template)).toThrow(/scopedWorkflow.groups 一致/);
  });

  it("preserves the v2 graph and its legacy member projection", () => {
    const template = cloneAgentOrchestrationTemplate();
    template.collaborations = [{ id: "G", displayName: "G", memberAgentIds: ["idea", "execution"], renamePolicy: "editable" }];
    template.routes.G = [{ target: "writing", kind: "strong" }];
    delete template.routes.idea;
    delete template.routes.execution;
    delete template.decisionPlans.idea;
    delete template.decisionPlans.execution;
    template.routes.main = [{ target: "G", kind: "weak" }, { target: "writing", kind: "weak" }, { target: "review", kind: "weak" }];
    template.input.target = "G";
    const normalized = normalizeAgentOrchestrationTemplate(template);
    expect(normalized.schemaVersion).toBe(2);
    expect(workflowOuterNodeIds(normalized)).not.toContain("idea");
    expect(workflowOuterNodeIds(normalized)).toContain("G");
  });

  it("migrates a flat group explicitly without adding formerly hidden members to the root", () => {
    const template = cloneAgentOrchestrationTemplate() as AgentOrchestrationTemplateV2;
    template.collaborations = [{ id: "G", displayName: "G", memberAgentIds: ["idea", "execution"], renamePolicy: "editable" }];
    template.routes.G = [{ target: "writing", kind: "strong" }];
    delete template.routes.idea;
    delete template.routes.execution;
    delete template.decisionPlans.idea;
    delete template.decisionPlans.execution;
    template.routes.main = [{ target: "G", kind: "weak" }, { target: "writing", kind: "weak" }, { target: "review", kind: "weak" }];
    template.input.target = "G";
    expect(() => upgradeLegacyFlatCollaborations(template, {})).toThrow(/明确选择 Leader/);
    expect(() => upgradeLegacyFlatCollaborations(template, { G: "idea" })).toThrow(/不能兼任/);
    const migrated = upgradeLegacyFlatCollaborations(template, { G: "main" });
    expect(migrated.scopedWorkflow.rootAgentIds).not.toContain("idea");
    expect(workflowOuterNodeIds(migrated)).toContain("G");
    expect(migrated.scopedWorkflow.groups[0]?.workflow.input.edges).toHaveLength(2);
    expect(template.schemaVersion).toBe(2);
  });
});
