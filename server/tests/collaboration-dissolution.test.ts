import { describe, expect, it } from "vitest";
import { dissolveCollaborationGroup } from "../src/collaboration-dissolution.js";
import type { AgentOrchestrationTemplate } from "../src/types.js";

function workflow(): AgentOrchestrationTemplate {
  return {
    schemaVersion: 2,
    agents: [{ name: "main" }, { name: "alpha" }, { name: "beta" }, { name: "review" }],
    collaborations: [{
      id: "group",
      displayName: "协作组",
      memberAgentIds: ["alpha", "beta"],
      renamePolicy: "editable",
      formationSnapshot: {
        schemaVersion: 1,
        workflowRevision: 1,
        memberRoutes: { alpha: [{ target: "beta", kind: "strong" }], beta: [{ target: "review", kind: "strong" }] },
        memberDecisionPlans: { alpha: "alpha", beta: "beta" },
        inboundRoutes: { main: [{ target: "alpha", kind: "weak" }, { target: "review", kind: "weak" }] },
        formedRoutes: { main: [{ target: "group", kind: "weak" }, { target: "review", kind: "weak" }], group: [{ target: "review", kind: "strong" }] },
        inputTarget: "alpha"
      }
    }],
    input: { source: "input", target: "group" },
    routes: { main: [{ target: "group", kind: "weak" }, { target: "review", kind: "weak" }], group: [{ target: "review", kind: "strong" }], review: [{ target: "finish", kind: "weak" }] },
    decisionPlans: { main: "main", group: "group", review: "review" },
    allowUserIntervention: true,
    termination: { agent: "review", condition: "done", decisionBy: "main", automatic: false }
  };
}

describe("server collaboration dissolution", () => {
  it("restores a formation snapshot without touching runtime history", () => {
    const orchestration = workflow();
    dissolveCollaborationGroup(orchestration, "group");
    expect(orchestration.collaborations).toEqual([]);
    expect(orchestration.input.target).toBe("alpha");
    expect(orchestration.routes.alpha).toEqual([{ target: "beta", kind: "strong" }]);
    expect(orchestration.routes.beta).toEqual([{ target: "review", kind: "strong" }]);
    expect(orchestration.routes.main).toEqual([
      { target: "alpha", kind: "weak" },
      { target: "beta", kind: "weak" },
      { target: "review", kind: "weak" }
    ]);
  });

  it("requires a guided plan when the grouped topology changed", () => {
    const orchestration = workflow();
    orchestration.routes.group = [{ target: "main", kind: "strong" }];
    expect(() => dissolveCollaborationGroup(orchestration, "group")).toThrow(/cannot be restored automatically/);
  });

  it("rejects a guided dissolution that leaves the restored members trapped", () => {
    const orchestration = workflow();
    delete orchestration.collaborations![0]!.formationSnapshot;
    expect(() => dissolveCollaborationGroup(orchestration, "group", {
      mode: "guided",
      incomingTargetBySource: { main: "alpha" },
      inputTarget: "alpha",
      memberRoutes: {
        alpha: [{ target: "beta", kind: "strong" }],
        beta: [{ target: "alpha", kind: "strong" }]
      }
    })).toThrow(/no path to finish|unreachable/);
  });
});
