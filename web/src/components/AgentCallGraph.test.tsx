import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentCallGraph } from "./AgentCallGraph";
import { normalizeEvent, normalizeProject } from "../lib";
import type { AgentEvent } from "../types";

vi.mock("./workflow-canvas/WorkflowCanvasRuntime", () => ({ WorkflowCanvasRuntime: () => <div>Workflow preview</div> }));

const member = (seq: number, agent: string, invocationId: string, executionId: string): AgentEvent => normalizeEvent({
  seq, type: "collaboration.execution.started", agentId: agent, invocationId, executionId,
  ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  data: { sourceType: "scoped.agent.native_opened", groupRunId: "group-a", ownershipEpoch: 1 }
})!;

describe("Agent call list", () => {
  it("shows parallel members and their Leader with correct active rows after a bootstrap or live replay", () => {
    const project = normalizeProject({ id: "prj_calls", status: "running", phase: "resident:running", runtime: {
      status: "running", phase: "resident:running", activities: [
        { activityId: "a", projectId: "prj_calls", kind: "turn", phase: "model:running", leaseState: "current", agentId: "execution", invocationId: "a-repair", nodeRunId: "node-a", startedAt: "2026-10-15T00:00:00Z", writerLeaseEpoch: 1 },
        { activityId: "b", projectId: "prj_calls", kind: "turn", phase: "model:running", leaseState: "current", agentId: "writing", invocationId: "b", nodeRunId: "node-b", startedAt: "2026-10-15T00:00:00Z", writerLeaseEpoch: 1 }
      ]
    } });
    const events = [
      normalizeEvent({ seq: 1, type: "workflow.node.updated", agentId: "main", invocationId: "leader", data: {
        sourceType: "agent.native_binding.opened", executionContext: { role: "leader", groupRunId: "group-a" }
      } })!,
      member(2, "execution", "a", "execution-a"), member(3, "writing", "b", "execution-b"),
      member(4, "execution", "a-repair", "execution-a")
    ];
    const { rerender } = render(<AgentCallGraph project={project} events={events} />);
    const list = screen.getByLabelText("调用记录");
    expect(within(list).getByText("Main Agent")).toBeInTheDocument();
    expect(within(list).getByText("execution Agent")).toBeInTheDocument();
    expect(within(list).getByText("writing Agent")).toBeInTheDocument();
    expect(list.querySelectorAll(".agent-call-sequence-number")).toHaveLength(3);
    expect(within(list).getAllByText("运行中")).toHaveLength(2);
    rerender(<AgentCallGraph project={project} events={[...events, member(4, "execution", "a-repair", "execution-a")]} />);
    expect(list.querySelectorAll(".agent-call-sequence-number")).toHaveLength(3);
  });

  it("paginates all actual management calls without counting reserved-only turns", () => {
    const project = normalizeProject({ id: "prj_pages", status: "paused" });
    const events = Array.from({ length: 12 }, (_, i) => normalizeEvent({ seq: i + 1, type: "workflow.node.updated", agentId: "main", invocationId: `leader-${i}`, data: {
      sourceType: "agent.native_binding.opened", executionContext: { role: "leader", groupRunId: "group-a" }
    } })!);
    events.push(normalizeEvent({ seq: 13, type: "workflow.node.updated", agentId: "main", invocationId: "not-started", data: { sourceType: "scoped.leader.claimed", groupRunId: "group-a" } })!);
    render(<AgentCallGraph project={project} events={events} />);
    expect(screen.getByLabelText("调用记录").querySelectorAll(".agent-call-sequence-number")).toHaveLength(2);
    expect(screen.getByText("11–12 / 12")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看上一组调用" }));
    expect(screen.getByLabelText("调用记录").querySelectorAll(".agent-call-sequence-number")).toHaveLength(10);
    expect(screen.getByText("1–10 / 12")).toBeInTheDocument();
  });
});
