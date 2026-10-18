import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_ORCHESTRATION } from "../../../lib";
import type { WorkflowEdgeMap } from "../../../types";
import { reconcileLoopTopology } from "./workflow-loop-editor";

describe("automatic canvas Loop topology", () => {
  it("creates an explicit Loop only when a new strong route closes a valid cycle", () => {
    const before = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    before.routes.idea = [{ target: "execution", kind: "strong" }];
    before.routes.execution = [];
    const after = structuredClone(before);
    after.routes.execution = [{ target: "idea", kind: "strong" }];

    const result = reconcileLoopTopology(before, after, { source: "execution", target: "idea" });
    expect(result.error).toBeUndefined();
    expect(result.created).toMatchObject({
      from: "execution", to: "idea", maxIterations: 3, exitTo: "main"
    });
    expect(after.loops).toEqual(result.loops);
  });

  it("removes the Loop metadata when its strong cycle is broken", () => {
    const before = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    before.routes.idea = [{ target: "execution", kind: "strong" }];
    before.routes.execution = [{ target: "idea", kind: "strong" }];
    before.loops = [{ id: "drafting", from: "execution", to: "idea", maxIterations: 5, exitTo: "main" }];
    const after = structuredClone(before);
    after.routes.execution = [];

    const result = reconcileLoopTopology(before, after);
    expect(result).toMatchObject({ loops: [], removed: ["drafting"] });
    expect(after.loops).toEqual([]);
  });

  it("rejects a cycle whose return source is the termination Agent", () => {
    const before = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    before.routes.idea = [{ target: "review", kind: "strong" }];
    before.routes.review = [];
    const after = structuredClone(before);
    after.routes.review = [{ target: "idea", kind: "strong" }];

    const result = reconcileLoopTopology(before, after, { source: "review", target: "idea" });
    expect(result.error).toMatch(/termination Agent/);
  });

  it("rejects a cycle through a legacy branching strong path", () => {
    const before = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    before.routes.idea = [
      { target: "execution", kind: "strong" },
      { target: "writing", kind: "strong" }
    ];
    before.routes.execution = [];
    const after = structuredClone(before);
    after.routes.execution = [{ target: "idea", kind: "strong" }];

    const result = reconcileLoopTopology(before, after, { source: "execution", target: "idea" });
    expect(result.error).toMatch(/sole strong route/);
  });

  it("does not guess a batch boundary for a legacy cycle without loops metadata", () => {
    const before = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    before.routes.idea = [{ target: "execution", kind: "strong" }];
    before.routes.execution = [{ target: "idea", kind: "strong" }];
    before.loops = [];
    const after = structuredClone(before);

    expect(reconcileLoopTopology(before, after).loops).toEqual([]);
  });

  it("uses the scoped graph's outside node as the Loop exit", () => {
    const before = {
      agents: [{ name: "first" }, { name: "second" }, { name: "after" }],
      routes: { first: [{ target: "second", kind: "strong" }], second: [], after: [{ target: "finish", kind: "strong" }] } as WorkflowEdgeMap,
      loops: [], termination: { agent: "finish" }
    };
    const after = structuredClone(before);
    after.routes.second = [{ target: "first", kind: "strong" }];
    const result = reconcileLoopTopology(before, after, { source: "second", target: "first" }, {
      exitTo: (members, topology) => topology.agents.find((agent) => !members.includes(agent.name))?.name
    });
    expect(result.error).toBeUndefined();
    expect(result.created).toMatchObject({ from: "second", to: "first", exitTo: "after" });
  });

  it("rejects a scoped cycle with no outside node for its exit", () => {
    const before = {
      agents: [{ name: "first" }, { name: "second" }],
      routes: { first: [{ target: "second", kind: "strong" }], second: [] } as WorkflowEdgeMap,
      loops: [], termination: { agent: "finish" }
    };
    const after = structuredClone(before);
    after.routes.second = [{ target: "first", kind: "strong" }];
    const result = reconcileLoopTopology(before, after, { source: "second", target: "first" }, {
      exitTo: (members, topology) => topology.agents.find((agent) => !members.includes(agent.name))?.name
    });
    expect(result.error).toMatch(/outside its cycle/);
    expect(result.created).toBeUndefined();
  });
});
