import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_ORCHESTRATION, normalizeProject } from "./lib";
import { applyLiveRuntimeSnapshot, mergeProjectSnapshot } from "./project-runtime";
import { scopedRosterMembers } from "./scoped-runtime";
import { buildWorkflowRuntimeState } from "./components/workflow-canvas/core/workflow-runtime";
import { buildLiveCanvasSnapshot } from "./components/workflow-canvas/WorkflowCanvasLive";
import { adaptWorkflowToCanvas } from "./components/workflow-canvas/core/canvas-adapter";
import { runtimeProjectFixture } from "./test/runtime-project";

describe("project runtime API and live updates", () => {
  it("shows a single confirmed progress revision while a completion snapshot is pending", () => {
    const project = runtimeProjectFixture();
    const running = { ...project, overallProgress: { ...project.overallProgress, percent: 42, label: "执行中" } };
    const completed = { ...running, status: "completed" as const, phase: "accepted",
      runtime: { ...running.runtime!, stateRevision: 13, status: "completed" as const, phase: "accepted", activities: [] },
      overallProgress: { ...running.overallProgress, percent: 100, label: "项目已完成" } };
    const interim = applyLiveRuntimeSnapshot(running, completed.runtime);
    const displayed = [interim.status, interim.overallProgress.percent, interim.overallProgress.label];
    expect([["running", 42, "执行中"], ["completed", 100, "项目已完成"]]).toContainEqual(displayed);
    const confirmed = mergeProjectSnapshot(interim, completed);
    expect(confirmed.overallProgress).toEqual(completed.overallProgress);
    expect(mergeProjectSnapshot(confirmed, running)).toBe(confirmed);
  });

  it("keeps the confirmed serial revision across list and detail even when the earlier read arrives last", () => {
    const earlier = { ...runtimeProjectFixture(), runtime: undefined, collaboration: { stateRevision: 10 } };
    const later = { ...earlier, collaboration: { stateRevision: 11 }, status: "completed" as const,
      overallProgress: { ...earlier.overallProgress, percent: 100, label: "项目已完成" } };
    expect(mergeProjectSnapshot(earlier, later)).toBe(later);
    expect(mergeProjectSnapshot(later, earlier)).toBe(later);
  });

  it("preserves recursive facts and activity roles through actual API normalization", () => {
    const project = runtimeProjectFixture();
    expect(project.scopedGroupRuns).toHaveLength(2);
    expect(project.scopedArrivals).toHaveLength(2);
    expect(project.scopedExecutions).toHaveLength(2);
    expect(project.scopedManagementTurns).toHaveLength(1);
    expect(project.runtime?.activities.map((activity) => activity.scopeKind)).toEqual(["scoped-agent", "scoped-agent"]);
    const members = scopedRosterMembers(project, "research");
    expect(members).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: "writing", executionCount: 1, state: "running" }),
      expect.objectContaining({ agentId: "review", executionCount: 1, state: "running" }),
      expect.objectContaining({ agentId: "idea", executionCount: 0, state: "waiting" })
    ]));
  });

  it("updates every active Agent immediately and preserves the newest live revision", () => {
    const project = runtimeProjectFixture();
    const next = applyLiveRuntimeSnapshot(project, { ...project.runtime!, stateRevision: 13 });
    expect(next.agentProgress.writing?.state).toBe("running");
    expect(next.agentProgress.review?.state).toBe("running");
    expect(applyLiveRuntimeSnapshot(next, next.runtime!)).toBe(next);
    expect(mergeProjectSnapshot(next, project)).toBe(next);
    expect(applyLiveRuntimeSnapshot(next, project.runtime!)).toBe(next);
    expect(project.agentProgress.writing?.state).toBe("waiting");
  });

  it("keeps parent and nested node badges paused consistently with retained running records", () => {
    const project = runtimeProjectFixture();
    const runtimeEvent = { ...project.runtime!, stateRevision: 13, status: "paused" as const, activities: [] };
    expect(applyLiveRuntimeSnapshot(project, runtimeEvent)).toBe(project);
    const committed = { ...project, status: runtimeEvent.status, phase: runtimeEvent.phase,
      overallProgress: { ...project.overallProgress, label: "任务已暂停" }, runtime: runtimeEvent };
    const paused = applyLiveRuntimeSnapshot(mergeProjectSnapshot(project, committed), { ...runtimeEvent });
    expect(paused.overallProgress.label).toBe("任务已暂停");
    expect(paused.agentProgress.writing?.state).toBe("paused");
    expect(scopedRosterMembers(paused, "research").find((member) => member.agentId === "writing" && member.key.startsWith("inner:"))?.state).toBe("paused");
    const runtime = buildWorkflowRuntimeState(paused, []);
    const canvas = buildLiveCanvasSnapshot({ model: adaptWorkflowToCanvas(paused.orchestration), runtime, project: paused, events: [] });
    expect(runtime.nodeStates.research).toBe("paused");
    expect(canvas.nodeStates.research).toBe("paused");
  });

  it("does not let an old running snapshot override a later completion event", () => {
    const project = normalizeProject({ id: "serial", status: "running", currentAgent: "review", orchestration: DEFAULT_AGENT_ORCHESTRATION,
      agentProgress: { writing: { state: "running", runs: 1 } } });
    const runtime = buildWorkflowRuntimeState(project, [{ seq: 1, type: "agent.completed", agent: "writing", message: "done", ts: "2026-10-09T00:00:00Z" }]);
    expect(runtime.nodeStates.writing).toBe("completed");
  });

  it.each(["retrying", "interrupted"] as const)("propagates a %s live snapshot to Agent badges and the workflow canvas", status => {
    const project = runtimeProjectFixture();
    const runtimeEvent = { ...project.runtime!, stateRevision: 13, status,
      phase: status === "interrupted" ? "collaboration:repair-required" : "collaboration:recovering" };
    expect(applyLiveRuntimeSnapshot(project, runtimeEvent)).toBe(project);
    const committed = { ...project, status, phase: runtimeEvent.phase, runtime: runtimeEvent,
      overallProgress: { ...project.overallProgress, label: status === "interrupted" ? "等待恢复" : "等待重试" } };
    const next = applyLiveRuntimeSnapshot(mergeProjectSnapshot(project, committed), { ...runtimeEvent });
    expect(next.status).toBe(status);
    expect(next.agentProgress.writing?.state).toBe(status);
    expect(next.agentProgress.review?.state).toBe(status);
    const runtime = buildWorkflowRuntimeState(next, []);
    const canvas = buildLiveCanvasSnapshot({ model: adaptWorkflowToCanvas(next.orchestration), runtime, project: next, events: [] });
    expect(runtime.nodeStates.research).toBe(status);
    expect(canvas.nodeStates.research).toBe(status);
    expect(project.status).toBe("running");
  });

  it("keeps v3 failures as failures after normalization and discards malformed facts", () => {
    const project = runtimeProjectFixture();
    project.scopedExecutions![0]!.status = "failed";
    project.scopedArrivals![0]!.status = "failed";
    const normalized = normalizeProject({ ...project, scopedExecutions: [...project.scopedExecutions!, { id: "broken", status: "running" }] });
    expect(normalized.scopedExecutions).toHaveLength(2);
    expect(scopedRosterMembers(normalized, "research").find((member) => member.agentId === "writing" && member.key.startsWith("inner:"))?.state).toBe("failed");
  });
});
