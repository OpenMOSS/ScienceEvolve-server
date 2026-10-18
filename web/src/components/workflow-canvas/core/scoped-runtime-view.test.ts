import { describe, expect, it } from "vitest";
import { runtimeProjectFixture } from "../../../test/runtime-project";
import { canvasEdgeId, loopExitCanvasEdgeId } from "./canvas-layout";
import { buildScopedRuntimeView } from "./scoped-runtime-view";

function fixture() {
  const project = runtimeProjectFixture();
  for (const group of project.orchestration.scopedWorkflow!.groups) {
    const aliases = new Map(group.workflow.nodes.map((node) => [node.nodeId, node.kind === "agent" ? node.agentId : node.groupId]));
    group.workflow.nodes.forEach((node) => { node.nodeId = aliases.get(node.nodeId)!; });
    group.workflow.input.edges.forEach((edge) => { edge.target = aliases.get(edge.target) ?? edge.target; });
    group.workflow.routes = Object.fromEntries(Object.entries(group.workflow.routes).map(([source, edges]) =>
      [aliases.get(source) ?? source, edges.map((edge) => ({ ...edge, target: aliases.get(edge.target) ?? edge.target }))]));
    project.scopedArrivals!.filter((arrival) => arrival.groupRunId === `run-${group.id}`).forEach((arrival) => {
      arrival.targetNodeId = aliases.get(arrival.targetNodeId) ?? arrival.targetNodeId;
    });
  }
  return project;
}

describe("scoped views for the common live canvas", () => {
  it("keeps the configured parallel graph without inventing executions or Main dispatch", () => {
    const project = fixture();
    project.scopedGroupRuns = [];
    // Flat legacy facts and the Agent's work in another scope cannot fill this view.
    project.agentProgress.writing = { state: "completed", runs: 99 };
    const before = structuredClone(project);
    const { model, runtime, path } = buildScopedRuntimeView(project, "inner")!;
    expect(path.map((group) => group.id)).toEqual(["research", "inner"]);
    expect(model.nodes.map((node) => node.id)).toEqual(["input", "writing", "review", "finish"]);
    expect(model.edges.filter((edge) => edge.source === "input").map((edge) => edge.kind)).toEqual(["parallel", "parallel"]);
    expect(model.edges.some((edge) => edge.systemRoute)).toBe(false);
    expect(Object.values(runtime.nodeStates).every((state) => state === "waiting")).toBe(true);
    expect(runtime.executionCounts).toEqual({ writing: 0, review: 0 });
    expect(Object.values(runtime.edgeStates).every((state) => state === "configured")).toBe(true);
    expect(project).toEqual(before);
    expect(buildScopedRuntimeView(project, "missing")).toBeUndefined();
  });

  it("counts business arrivals once across ownership retries and excludes other group batches", () => {
    const project = fixture();
    project.scopedExecutions!.push({ ...project.scopedExecutions![0]!, id: "retry", ownershipEpoch: 2 });
    project.runtime!.activities.push({ ...project.runtime!.activities[0]!, activityId: "retry-activity", executionId: "retry", ownershipEpoch: 2, invocationId: "retry-invocation" });
    project.scopedArrivals!.push({ ...project.scopedArrivals![0]!, sequence: 3, requestId: "queued-next", status: "queued" });
    project.scopedArrivals!.push({ ...project.scopedArrivals![0]!, sequence: 4, requestId: "old", groupRunId: "previous-run", status: "completed" });
    const { runtime } = buildScopedRuntimeView(project, "inner")!;
    expect(runtime.executionCounts.writing).toBe(1);
    expect(runtime.nodeStates.writing).toBe("running");
    expect(runtime.currentInvocationId).toBeDefined();
    expect(runtime.recentInvocationPath.find((item) => item.nodeId === "writing")?.invocationId).toBe("retry-invocation");
    expect(runtime.recentInvocationPath).toHaveLength(2);
    expect(runtime.edgeStates[canvasEdgeId("input", "writing")]).toBe("active");
    const parent = buildScopedRuntimeView(project, "research")!;
    expect(parent.runtime.nodeStates.writing).toBe("waiting");
    expect(parent.runtime.executionCounts.writing).toBe(0);
    expect(parent.runtime.nodeStates.inner).toBe("running");
  });

  it("uses reference IDs for graph topology and Agent/group IDs for configuration and navigation", () => {
    const project = fixture();
    const group = project.orchestration.scopedWorkflow!.groups.find((group) => group.id === "research")!;
    group.workflow.nodes.find((node) => node.kind === "agent" && node.agentId === "writing")!.nodeId = "writer-alias";
    group.workflow.nodes.find((node) => node.kind === "collaboration")!.nodeId = "child-alias";
    // Public scoped definitions still work if optional legacy display records are missing.
    project.orchestration.collaborations = [];
    const { model } = buildScopedRuntimeView(project, "research")!;
    expect(model.nodes.find((node) => node.id === "writer-alias")?.name).toBe("writing");
    expect(model.nodes.find((node) => node.id === "child-alias")?.collaboration).toMatchObject({ id: "inner", displayName: "inner" });
  });

  it("clears stale child batches when the parent is reactivated and inherits pause state", () => {
    const project = fixture();
    project.status = "paused";
    project.runtime!.status = "paused";
    expect(buildScopedRuntimeView(project, "inner")!.runtime.nodeStates.writing).toBe("paused");
    project.scopedGroupRuns!.push({ ...project.scopedGroupRuns![0]!, id: "new-parent" });
    const { runtime, run } = buildScopedRuntimeView(project, "inner")!;
    expect(run).toBeUndefined();
    expect(runtime.nodeStates.writing).toBe("waiting");
    expect(runtime.executionCounts.writing).toBe(0);
  });

  it("uses actual scoped arrivals for route highlighting and shares Loop geometry and counters", () => {
    const project = fixture();
    const group = project.orchestration.scopedWorkflow!.groups.find((group) => group.id === "inner")!;
    group.workflow.routes = { writing: [{ target: "review", kind: "strong" }], review: [{ target: "writing", kind: "strong" }] };
    group.workflow.loops = [{ id: "cycle", from: "review", to: "writing", exitTo: "finish", maxIterations: 2 }];
    project.scopedArrivals![0]!.status = "completed";
    project.scopedArrivals![1]!.sourceRunId = project.scopedArrivals![0]!.requestId;
    project.scopedArrivals![1]!.pathContext = { pathId: "path", loops: { cycle: { batch: 2, iterations: 1, totalIterations: 3 } } };
    const { model, runtime } = buildScopedRuntimeView(project, "inner")!;
    expect(model.edges.find((edge) => edge.id === canvasEdgeId("writing", "review"))?.loop?.role).toBe("member");
    expect(model.edges.find((edge) => edge.id === canvasEdgeId("review", "writing"))?.loop?.role).toBe("return");
    expect(model.edges.find((edge) => edge.id === loopExitCanvasEdgeId("cycle"))?.loop?.role).toBe("exit");
    expect(runtime.edgeStates[canvasEdgeId("writing", "review")]).toBe("active");
    expect(runtime.edgeStates[canvasEdgeId("review", "writing")]).toBe("configured");
    expect(runtime.loopStates.cycle).toMatchObject({ batch: 2, iteration: 1, totalIterations: 3, phase: "iterating" });
    expect(runtime.nodeStates.finish).toBe("waiting");
    project.scopedGroupRuns![1]!.status = "completed";
    expect(buildScopedRuntimeView(project, "inner")!.runtime.nodeStates.finish).toBe("completed");
  });
});
