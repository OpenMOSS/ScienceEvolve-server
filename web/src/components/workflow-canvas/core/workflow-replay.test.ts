import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_ORCHESTRATION, DEFAULT_AGENTS } from "../../../lib";
import { runtimeProjectFixture } from "../../../test/runtime-project";
import type { AgentEvent } from "../../../types";
import { buildWorkflowReplay, workflowReplayTimes, WORKFLOW_REPLAY_ROOT_SCOPE as ROOT, type WorkflowReplayConfigurationHistory } from "./workflow-replay";

const ts = (second: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, second)).toISOString();
const event = (seq: number, type: string, agent?: string, data: Record<string, unknown> = {}): AgentEvent => ({ seq, type, agent, data, ts: ts(seq), message: `${type}: ${agent ?? "project"}` });
function configuration(): WorkflowReplayConfigurationHistory {
  return { revisions: [{ revision: 1, ts: ts(0), orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION) }],
    configurations: [{ revision: 1, ts: ts(0), collaborationSeq: 1, agents: structuredClone(DEFAULT_AGENTS) }] };
}

describe("Workflow execution replay", () => {
  it("preserves parallel execution and earlier failures without future progress", () => {
    const events = [event(1, "agent.started", "idea", { invocationId: "idea-1" }),
      event(2, "agent.started", "execution", { invocationId: "exec-1" }),
      event(3, "agent.failed", "idea", { invocationId: "idea-1", reason: "validation failed" }),
      event(4, "retry.scheduled", "idea"), event(5, "agent.started", "idea", { invocationId: "idea-2" }),
      event(6, "agent.completed", "idea", { invocationId: "idea-2" }), event(7, "project.completed")];
    const { frames } = buildWorkflowReplay(configuration(), [...events].reverse());
    expect(frames[0]!.scopes[ROOT]!.nodeStates.idea).toBe("waiting");
    expect(frames.find(frame => frame.event?.seq === 2)!.scopes[ROOT]!.nodeStates).toMatchObject({ idea: "running", execution: "running" });
    expect(frames.find(frame => frame.event?.seq === 3)!.scopes[ROOT]!.nodeStates.idea).toBe("failed");
    expect(frames.find(frame => frame.event?.seq === 3)!.scopes[ROOT]!.nodeReasons.idea).toBe("validation failed");
    expect(frames.find(frame => frame.event?.seq === 4)!.scopes[ROOT]!.nodeStates.idea).toBe("retrying");
    expect(frames.find(frame => frame.event?.seq === 6)!.scopes[ROOT]!.nodeStates).toMatchObject({ idea: "completed", execution: "running" });
    expect(frames.at(-1)!.scopes[ROOT]!.nodeStates.finish).toBe("completed");
    expect(frames[1]!.scopes[ROOT]!.nodeStates.idea).toBe("running");
  });

  it("restores immutable historical topology and real Prompt/configuration changes", () => {
    const history = configuration(), next = structuredClone(history.revisions[0]!);
    next.revision = 2; next.ts = ts(4);
    next.orchestration.agents.push({ ...next.orchestration.agents[1]!, name: "fact-check", description: "Verify sources" });
    history.revisions.push(next);
    const agents = structuredClone(DEFAULT_AGENTS); agents.idea.instructions = "Only use verified sources";
    history.configurations.push({ revision: 2, collaborationSeq: 4, ts: ts(4), agents });
    const { frames } = buildWorkflowReplay(history, [event(1, "agent.started", "idea"),
      { ...event(4, "workflow.reconfigured", undefined, { collaborationSeq: 4, rationale: "source quality" }), workflowRevision: 2 }]);
    const before = frames[1]!, after = frames.at(-1)!;
    expect(before.revision).toBe(1);
    expect(before.models[ROOT]!.nodes.some(node => node.name === "fact-check")).toBe(false);
    expect(before.agents.idea.instructions).not.toBe("Only use verified sources");
    expect(after.revision).toBe(2);
    expect(after.models[ROOT]!.nodes.some(node => node.name === "fact-check")).toBe(true);
    expect(after.change).toMatchObject({ kind: "prompt", reason: "source quality" });
    expect(after.change!.content).toContain("Only use verified sources");
  });

  it("keeps same-named references in distinct group scopes independent", () => {
    const project = runtimeProjectFixture();
    const history = configuration(); history.revisions[0]!.orchestration = project.orchestration;
    const inner = project.orchestration.scopedWorkflow!.groups.find(group => group.id === "inner")!;
    const member = inner.workflow.nodes.find(node => node.kind === "agent")!;
    const events = [event(1, "collaboration.group.started", undefined, { sourceType: "scoped.group.activated", groupId: "research", groupRunId: "outer-run" }),
      event(2, "collaboration.group.started", undefined, { sourceType: "scoped.group.activated", groupId: "inner", groupRunId: "inner-run" }),
      event(3, "collaboration.execution.started", member.kind === "agent" ? member.agentId : undefined,
        { sourceType: "scoped.agent.claimed", groupRunId: "inner-run", targetNodeId: member.nodeId, arrivalRequestId: "a1", executionId: "e1" }),
      event(4, "collaboration.execution.completed", undefined,
        { sourceType: "scoped.agent.merged_route", groupRunId: "inner-run", arrivalRequestId: "a1", executionId: "e1" })];
    const { frames } = buildWorkflowReplay(history, events);
    expect(frames.find(frame => frame.event?.seq === 3)!.scopes.inner!.nodeStates[member.nodeId]).toBe("running");
    expect(frames.at(-1)!.scopes.inner!.nodeStates[member.nodeId]).toBe("completed");
    expect(frames.at(-1)!.scopes[ROOT]!.nodeStates.research).toBe("running");
    expect(frames.at(-1)!.scopes.research!.nodeStates.inner).toBe("running");
    expect(frames.at(-1)!.scopes.inner!.nodeStates.finish).toBe("waiting");
  });

  it("deduplicates mirrored events and does not count an invocation envelope twice", () => {
    const first = { ...event(1, "agent.execution.started", "idea", { executionId: "e1", invocationId: "i1" }), eventId: "durable-1" };
    const { frames } = buildWorkflowReplay(configuration(), [first, first,
      event(2, "agent.started", "idea", { invocationId: "i1" }), { ...first, seq: 3 }]);
    expect(frames.at(-1)!.scopes[ROOT]!.executionCounts.idea).toBe(1);
  });

  it("does not complete an outer collaboration when a member completes", () => {
    const project = runtimeProjectFixture(), history = configuration();
    history.revisions[0]!.orchestration = project.orchestration;
    const started = { ...event(1, "workflow.node.started", undefined, { sourceType: "node.activated" }), nodeId: "research", nodeRunId: "n1" };
    const member = { ...event(2, "collaboration.execution.completed", "writing", { sourceType: "execution.succeeded" }), nodeId: "research", nodeRunId: "n1", groupRunId: "legacy-run" };
    const { frames } = buildWorkflowReplay(history, [started, member]);
    expect(frames.at(-1)!.scopes[ROOT]!.nodeStates.research).toBe("running");
  });

  it("refuses missing versions and timestamps and reports absent configuration history", () => {
    expect(() => buildWorkflowReplay(configuration(), [{ ...event(1, "workflow.reconfigured"), workflowRevision: 9 }])).toThrow("v9");
    expect(() => buildWorkflowReplay(configuration(), [{ ...event(1, "agent.started", "idea"), ts: "" }])).toThrow("#1");
    const history = configuration(); history.configurations = [];
    expect(buildWorkflowReplay(history, []).notices.join()).toContain("缺少历史 Agent 配置");
  });

  it("compresses idle time, preserves simultaneous starts, and reaches the chosen duration", () => {
    const second = { ...event(2, "agent.started", "execution"), ts: ts(1) };
    const { frames } = buildWorkflowReplay(configuration(), [event(1, "agent.started", "idea"), second,
      { ...event(3, "agent.completed", "idea"), ts: ts(3600) }]);
    const times = workflowReplayTimes(frames, 30_000);
    expect(times[1]).toBe(times[2]);
    expect(times.at(-1)).toBe(30_000);
    expect(workflowReplayTimes(frames.slice(0, 1), 30_000)).toEqual([0]);
  });
});
