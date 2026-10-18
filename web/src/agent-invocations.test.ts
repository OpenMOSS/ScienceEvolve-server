import { describe, expect, it } from "vitest";
import { buildAgentInvocations, isAgentInvocationActive } from "./agent-invocations";
import { normalizeEvent } from "./lib";
import type { AgentEvent, Project } from "./types";

const event = (seq: number, type: string, agent: string, data: Record<string, unknown> = {}): AgentEvent => ({
  seq, type, agent, ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(), message: "", data
});
const opened = (seq: number, agent: string, invocationId: string, executionId: string, groupRunId = "group-a") =>
  event(seq, "collaboration.execution.started", agent, { sourceType: "scoped.agent.native_opened", invocationId, executionId, groupRunId, ownershipEpoch: 1 });
const binding = (seq: number, agent: string, invocationId: string, context: Record<string, unknown>) => normalizeEvent({
  seq, type: "workflow.node.updated", agentId: agent, invocationId,
  ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  data: { sourceType: "agent.native_binding.opened", binding: { agentId: agent, invocationId, executionContext: context } }
})!;

describe("Agent invocation history", () => {
  it("includes actual collaborative members and management turns while excluding reservations and Git-only updates", () => {
    const calls = buildAgentInvocations([
      binding(1, "main", "root-main", { role: "leader", routeScopeId: "root-route-a" }),
      event(2, "workflow.node.updated", "main", { sourceType: "scoped.leader.claimed", invocationId: "reserved-only", groupRunId: "group-a" }),
      binding(3, "main", "leader-a", { role: "leader", groupRunId: "group-a" }),
      opened(4, "execution", "worker-a", "execution-a"),
      opened(5, "writing", "worker-b", "execution-b"),
      event(6, "pull.request.observed", "writing", { invocationId: "git-only" }),
      binding(7, "main", "leader-b", { role: "leader", groupRunId: "group-a" })
    ]);
    expect(calls.map(call => call.invocationId)).toEqual(["root-main", "leader-a", "worker-a", "worker-b", "leader-b"]);
    expect(calls[1]).toMatchObject({ kind: "management", groupRunId: "group-a" });
  });

  it("merges native binding duplicates and repairs of the same task, retaining their invocation IDs", () => {
    const calls = buildAgentInvocations([
      opened(1, "execution", "original", "execution-a"),
      binding(2, "execution", "original", { role: "delivery", executionId: "execution-a", groupRunId: "group-a" }),
      opened(3, "execution", "repair", "execution-a"),
      binding(4, "execution", "repair", { role: "delivery", executionId: "execution-a", groupRunId: "group-a", ownershipEpoch: 2 })
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ seq: 1, invocationId: "original", invocationIds: ["original", "repair"] });
  });

  it("keeps independent tasks of the same Agent distinct across parallel or nested groups", () => {
    const calls = buildAgentInvocations([
      opened(1, "execution", "first", "execution-a"),
      event(2, "agent.failed", "execution", { invocationId: "first" }),
      opened(3, "execution", "second", "execution-b", "nested-group"),
      opened(4, "execution", "first-repair", "execution-a")
    ]);
    expect(calls).toHaveLength(2);
    expect(calls.map(call => call.executionId)).toEqual(["execution-a", "execution-b"]);
    expect(calls[0].invocationIds).toEqual(["first", "first-repair"]);
  });

  it("keeps final integration distinct from the same Agent's business task", () => {
    const calls = buildAgentInvocations([
      opened(1, "execution", "business", "execution-a"),
      event(2, "collaboration.execution.started", "execution", { sourceType: "scoped.final.native.opened", invocationId: "final", executionId: "group-final-group-a", groupRunId: "group-a" }),
      binding(3, "execution", "final", { role: "delivery", executionId: "group-final-group-a", groupRunId: "group-a" })
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ invocationId: "final", kind: "integration" });
  });

  it("handles compact bootstrap identities without needing full native session data", () => {
    const compact = normalizeEvent({ seq: 1, type: "workflow.node.updated", agentId: "main", invocationId: "manager",
      ts: "2026-10-15T00:00:00Z", data: { sourceType: "agent.native_binding.opened", executionContext: { role: "leader", groupRunId: "group-a" } } })!;
    expect(buildAgentInvocations([compact])[0]).toMatchObject({ role: "main", invocationId: "manager", groupRunId: "group-a", kind: "management" });
  });

  it("preserves the existing ordinary retry and checkpoint continuation numbering", () => {
    const calls = buildAgentInvocations([
      event(1, "agent.started", "execution", { invocationId: "original" }),
      event(2, "agent.failed", "execution"),
      event(3, "invocation.started", "execution", { invocationId: "retry" }),
      { ...event(4, "project.status", "execution"), message: "Recovered checkpoint" },
      event(5, "agent.started", "execution", { invocationId: "recovered" }),
      event(6, "agent.completed", "execution", { invocationId: "recovered" }),
      event(7, "agent.started", "execution", { invocationId: "new-task" })
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0].invocationIds).toEqual(["original", "retry", "recovered"]);
  });

  it("uses the persisted task identity when a legacy task has multiple execution IDs", () => {
    const project = { executions: [{ id: "execution-a", agentId: "execution", taskId: "task-a" }, { id: "execution-b", agentId: "execution", taskId: "task-a" }] } as Project;
    expect(buildAgentInvocations([opened(1, "execution", "first", "execution-a"), opened(2, "execution", "retry", "execution-b")], project)).toHaveLength(1);
  });

  it("marks all active parallel calls and recognizes a resumed invocation on its original row", () => {
    const calls = buildAgentInvocations([opened(1, "execution", "a", "execution-a"), opened(2, "writing", "b", "execution-b"), opened(3, "execution", "a-resumed", "execution-a")]);
    const project = { status: "running", runtime: { status: "running", activities: [
      { kind: "turn", leaseState: "current", agentId: "execution", invocationId: "a-resumed" },
      { kind: "turn", leaseState: "current", agentId: "writing", invocationId: "b" }
    ] } } as Project;
    expect(calls.filter(call => isAgentInvocationActive(call, project, calls))).toHaveLength(2);
    project.status = "paused"; project.runtime!.status = "paused";
    expect(calls.some(call => isAgentInvocationActive(call, project, calls))).toBe(false);
  });
});
