import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./types";
import { buildTraceEntries, isDiagnosticTraceEvent, toolOutput } from "./trace-model";

function trace(seq: number, kind: string, message = "", fields: Record<string, unknown> = {}): AgentEvent {
  return { seq, type: "agent.trace", agent: "researcher", message, ts: `2026-11-09T00:00:${String(seq).padStart(2, "0")}Z`,
    data: { canonicalEvent: { schemaVersion: 1, eventId: `event-${seq}`, seq, invocationId: "inv-1", harnessId: "fixture",
      attempt: 0, kind, itemId: "message-1", message, ...fields } } };
}

function lifecycle(seq: number, type: string, invocationId = "inv-1"): AgentEvent {
  return { seq, type, agent: "researcher", message: type, ts: `2026-11-09T00:00:${String(seq).padStart(2, "0")}Z`,
    data: { invocationId, executionId: "execution-1" } };
}

describe("research trace content and invocation identity", () => {
  it("omits missing or empty optional content and never reveals legacy reasoning", () => {
    expect(buildTraceEntries([trace(1, "reasoning.summary"), trace(2, "assistant.message", "  "),
      { ...trace(3, "activity"), data: { kind: "reasoning", itemType: "thinking" }, message: "private" }])).toEqual([]);
    expect(toolOutput(trace(4, "tool.completed", "", { tool: { callId: "c", name: "read", status: "completed", outputPreview: "" } }))).toBeUndefined();
  });

  it("coalesces body-free activity into one processing state without inventing a summary", () => {
    const entries = buildTraceEntries([lifecycle(1, "invocation.started"), lifecycle(2, "agent.started"),
      trace(3, "activity"), trace(4, "activity"), trace(5, "reasoning.summary")]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "execution", state: "processing", updatedAt: trace(4, "activity").ts });
    expect(entries[0]?.kind === "execution" && entries[0].updates).toHaveLength(2);
  });

  it("keeps visible summaries separate, merges their deltas, and preserves card identity on persistence", () => {
    const first = trace(1, "reasoning.summary", "Read ", { phase: "delta", itemId: "summary" });
    const second = trace(2, "reasoning.summary", "the evidence.", { phase: "delta", itemId: "summary" });
    const live = { ...second, seq: 8_000_000_002, message: "Read the evidence.", data: {
      ...second.data, liveEphemeral: true, canonicalEvent: { ...second.data!.canonicalEvent as object, message: "Read the evidence." } } };
    const liveEntry = buildTraceEntries([live])[0];
    const entries = buildTraceEntries([first, second, live, trace(3, "assistant.message", "Result")]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "activity", contentKind: "summary", thought: { message: "Read the evidence." } });
    expect(entries[0]?.id).toBe(liveEntry?.id);
    expect(entries[1]).toMatchObject({ kind: "activity", thought: { message: "Result" } });
  });

  it("associates multiple lifecycle levels only through explicit invocation and execution IDs", () => {
    const start = lifecycle(1, "invocation.started");
    const member = { ...lifecycle(2, "collaboration.execution.started"), invocationId: "inv-1", executionId: "execution-1", data: {} };
    const end = { ...lifecycle(4, "collaboration.execution.completed"), executionId: "execution-1", data: {} };
    const entries = buildTraceEntries([start, member, trace(3, "assistant.message", "Done"), end, lifecycle(5, "invocation.completed")]);
    expect(entries.filter(entry => entry.kind === "execution")).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "execution", state: "completed" });
    expect(entries[1]).toMatchObject({ displayState: "final" });
    expect(isDiagnosticTraceEvent(lifecycle(6, "workflow.node.completed"))).toBe(true);
  });

  it("keeps real new invocations, parallel agents, and attempts separate, including previous failures", () => {
    const entries = buildTraceEntries([lifecycle(1, "invocation.started"), trace(2, "assistant.message", "Partial", { sourceType: "assistant.incomplete" }),
      lifecycle(3, "agent.failed"), lifecycle(4, "invocation.started", "inv-2"),
      trace(5, "assistant.message", "New work", { invocationId: "inv-2" }),
      { ...trace(6, "assistant.message", "Parallel"), agent: "other" },
      trace(7, "assistant.message", "Recovered", { attempt: 1 })]);
    expect(entries.filter(entry => entry.kind === "execution")).toHaveLength(2);
    expect(entries[0]).toMatchObject({ state: "failed" });
    expect(entries.filter(entry => entry.kind === "activity")).toHaveLength(4);
    expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
  });

  it("merges tool start/result even without a repeated parent ID and does not promote preceding process text", () => {
    const tool = { callId: "call-1", name: "read", status: "started" };
    const entries = buildTraceEntries([trace(1, "assistant.message", "I will read."),
      trace(2, "tool.started", "", { parentItemId: "message-1", tool }),
      trace(3, "tool.completed", "", { itemId: "result", tool: { ...tool, status: "completed", outputPreview: "evidence" } }),
      lifecycle(4, "invocation.completed")]);
    const activity = entries.find(entry => entry.kind === "activity");
    expect(activity).toMatchObject({ displayState: "process", tools: [expect.objectContaining({ seq: 3 })] });
  });

  it("honors an explicit final response even when its group contains tools", () => {
    const message = trace(1, "assistant.message", "Final answer");
    message.data!.liveRole = "final";
    const entries = buildTraceEntries([message, trace(2, "tool.completed", "", { parentItemId: "message-1",
      tool: { callId: "call-1", name: "read", status: "completed" } })]);
    expect(entries[0]).toMatchObject({ kind: "activity", displayState: "final" });
  });

  it("does not relabel an earlier failed attempt as final when a later attempt has no final text", () => {
    const entries = buildTraceEntries([trace(1, "assistant.message", "Earlier output"),
      trace(2, "tool.completed", "", { attempt: 1, tool: { callId: "recovered", name: "read", status: "completed" } }),
      lifecycle(3, "invocation.completed")]);
    expect(entries[0]).toMatchObject({ kind: "activity", displayState: "incomplete" });
    expect(entries.some(entry => entry.kind === "activity" && entry.displayState === "final")).toBe(false);
  });

  it("preserves whitespace between nonempty streamed fragments", () => {
    for (const kind of ["assistant.delta", "reasoning.summary"]) {
      const entries = buildTraceEntries([trace(1, kind, "Read", { phase: "delta" }),
        trace(2, kind, " ", { phase: "delta" }), trace(3, kind, "evidence", { phase: "delta" })]);
      expect(entries[0]).toMatchObject({ thought: { message: "Read evidence" } });
    }
  });

  it("settles resident output from invocation performance without treating a tool or model reply as task completion", () => {
    const message = trace(1, "assistant.message", "Resident answer");
    expect(buildTraceEntries([message])[0]).toMatchObject({ displayState: "process" });
    const end = lifecycle(2, "invocation.performance");
    end.data!.performance = { status: "completed" };
    expect(buildTraceEntries([message, end])[0]).toMatchObject({ displayState: "final" });
    expect(buildTraceEntries([end])).toHaveLength(1);
  });
});
