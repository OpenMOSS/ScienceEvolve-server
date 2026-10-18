import { describe, expect, it } from "vitest";
import type { AgentOrchestrationTemplate } from "../../../types";
import {
  buildGuidedDissolutionPlan,
  canRestoreCollaborationSnapshot,
  dissolveCollaborationInDraft
} from "./collaboration-dissolution";

function exactFixture(): AgentOrchestrationTemplate {
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
        memberDecisionPlans: { alpha: "alpha plan", beta: "beta plan" },
        inboundRoutes: { main: [{ target: "alpha", kind: "weak" }, { target: "review", kind: "weak" }] },
        formedRoutes: { main: [{ target: "group", kind: "weak" }, { target: "review", kind: "weak" }], group: [{ target: "review", kind: "strong" }] },
        inputTarget: "alpha",
        memberCanvasNodes: { alpha: { x: 100, y: 100 }, beta: { x: 350, y: 100 } }
      }
    }],
    input: { source: "input", target: "group" },
    routes: { main: [{ target: "group", kind: "weak" }, { target: "review", kind: "weak" }], group: [{ target: "review", kind: "strong" }], review: [{ target: "finish", kind: "weak" }] },
    decisionPlans: { main: "main", group: "group", review: "review" },
    allowUserIntervention: true,
    termination: { agent: "review", condition: "done", decisionBy: "main", automatic: false },
    canvas: { schemaVersion: 1, nodes: { group: { x: 220, y: 100 }, review: { x: 600, y: 100 } }, edges: {}, viewport: { x: 0, y: 0, zoom: 1 }, layoutMode: "free" }
  };
}

describe("collaboration dissolution", () => {
  it("losslessly restores a newly formed group", () => {
    const orchestration = exactFixture();
    const group = orchestration.collaborations![0]!;
    expect(canRestoreCollaborationSnapshot(orchestration, group)).toBe(true);
    dissolveCollaborationInDraft(orchestration, group.id);
    expect(orchestration.collaborations).toEqual([]);
    expect(orchestration.input.target).toBe("alpha");
    expect(orchestration.routes.alpha).toEqual([{ target: "beta", kind: "strong" }]);
    expect(orchestration.routes.beta).toEqual([{ target: "review", kind: "strong" }]);
    expect(orchestration.routes.group).toBeUndefined();
    expect(orchestration.canvas?.nodes).toMatchObject({ alpha: { x: 100, y: 100 }, beta: { x: 350, y: 100 } });
  });

  it("builds an explicit entry-to-exit plan for a legacy group", () => {
    const orchestration = exactFixture();
    const group = orchestration.collaborations![0]!;
    delete group.formationSnapshot;
    const plan = buildGuidedDissolutionPlan(orchestration, group, "alpha", "beta");
    dissolveCollaborationInDraft(orchestration, group.id, plan);
    expect(orchestration.input.target).toBe("alpha");
    expect(orchestration.routes.alpha).toEqual([{ target: "beta", kind: "strong" }]);
    expect(orchestration.routes.beta).toEqual([{ target: "review", kind: "strong" }]);
  });

  it("requires guided confirmation when input ownership changed after formation", () => {
    const orchestration = exactFixture();
    const group = orchestration.collaborations![0]!;
    orchestration.input.target = "review";
    expect(canRestoreCollaborationSnapshot(orchestration, group)).toBe(false);
  });

  it("rejects a guided topology that traps members in a cycle", () => {
    const orchestration = exactFixture();
    const group = orchestration.collaborations![0]!;
    delete group.formationSnapshot;
    const plan = buildGuidedDissolutionPlan(orchestration, group, "alpha", "beta");
    plan.memberRoutes.beta = [{ target: "alpha", kind: "strong" }];
    expect(() => dissolveCollaborationInDraft(orchestration, group.id, plan)).toThrow(/无法到达 finish|不可达/);
  });
});
