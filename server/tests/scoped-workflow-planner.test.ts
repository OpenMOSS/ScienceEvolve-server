import { describe, expect, it } from "vitest";
import type { ScopedWorkflow } from "../src/scoped-workflow-contract.js";
import { planScopedInputFanOut, planScopedSuccessor } from "../src/scoped-workflow-planner.js";

const workflow: ScopedWorkflow = {
  nodes: ["a", "b", "c"].map((agentId) => ({ kind: "agent", nodeId: agentId, agentId })),
  input: { source: "input", edges: [
    { kind: "parallel", target: "a" }, { kind: "parallel", target: "b" }
  ] },
  routes: {
    a: [{ kind: "strong", target: "c" }],
    b: [{ kind: "weak", target: "c" }, { kind: "weak", target: "finish" }],
    c: [{ kind: "strong", target: "finish" }]
  }
};

describe("scoped workflow activation planner", () => {
  it("fans out every Input edge exactly once with replay-stable identities", () => {
    const first = planScopedInputFanOut(workflow, "group-run", 3);
    expect(first.map((plan) => plan.targetNodeId)).toEqual(["a", "b"]);
    expect(planScopedInputFanOut(workflow, "group-run", 3)).toEqual(first);
    expect(planScopedInputFanOut(workflow, "next-group-run", 3)[0]?.requestId).not.toBe(first[0]?.requestId);
    expect(planScopedInputFanOut(workflow, "group-run", 4)[0]?.requestId).not.toBe(first[0]?.requestId);
  });

  it("keeps separate valid arrivals at one Agent distinct without duplicating a replay", () => {
    const fromA = planScopedSuccessor(workflow, "group-run", 3, "a", "a-run");
    const fromB = planScopedSuccessor(workflow, "group-run", 3, "b", "b-run", "c");
    expect(fromA).toMatchObject({ kind: "activate", activation: { targetNodeId: "c" } });
    expect(fromB).toMatchObject({ kind: "activate", activation: { targetNodeId: "c" } });
    expect(fromA).not.toEqual(fromB);
    expect(planScopedSuccessor(workflow, "group-run", 3, "a", "a-run")).toEqual(fromA);
  });

  it("requires a selected weak edge and does not activate the unchosen path", () => {
    expect(() => planScopedSuccessor(workflow, "group-run", 3, "b", "b-run")).toThrow(/route decision/);
    expect(() => planScopedSuccessor(workflow, "group-run", 3, "b", "b-run", "outside")).toThrow(/route decision/);
    expect(planScopedSuccessor(workflow, "group-run", 3, "b", "b-run", "finish")).toMatchObject({ kind: "finish" });
  });

  it("rejects parallel routes from an ordinary node even if an unchecked object is supplied", () => {
    const invalid = structuredClone(workflow);
    invalid.routes.a = [{ kind: "parallel", target: "c" }] as never;
    expect(() => planScopedSuccessor(invalid, "group-run", 3, "a", "a-run")).toThrow(/route decision/);
  });
});
