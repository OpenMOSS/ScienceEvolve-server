import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../types";
import { buildTraceEntries } from "../trace-model";
import { AgentActivityCard } from "./WorkspacePage";

function entry(kind: string, message: string, tool?: object) {
  const event: AgentEvent = { seq: 1, ts: "2026-11-09T00:00:00Z", type: "agent.trace", agent: "main", message,
    data: { canonicalEvent: { schemaVersion: 1, eventId: "one", harnessId: "fixture", invocationId: "inv-one",
      kind, itemId: "item-one", message, ...(tool ? { tool } : {}) } } };
  const value = buildTraceEntries([event])[0];
  if (value?.kind !== "activity") throw new Error("Expected an activity entry");
  return value;
}

describe("visible research output cards", () => {
  it("renders ordinary text without an empty tool panel", () => {
    const view = render(<AgentActivityCard entry={entry("assistant.message", "Ordinary output")} projectCycle={1} />);
    expect(screen.getByText("Agent 过程文字")).toBeVisible();
    expect(screen.getByText("Ordinary output")).toBeVisible();
    expect(view.container.querySelector(".agent-tools-panel")).toBeNull();
  });

  it("renders the actual visible summary as expandable content without requiring tools", () => {
    render(<AgentActivityCard entry={entry("reasoning.summary", "Check actual sources.")} projectCycle={1} />);
    expect(screen.getByText("可见思考摘要")).toBeVisible();
    expect(screen.queryByText("Agent 过程文字")).not.toBeInTheDocument();
    const summary = screen.getByText("阅读摘要");
    fireEvent.click(summary);
    expect(summary.closest("details")).toHaveAttribute("open");
    expect(screen.getByText("Check actual sources.")).toBeVisible();
  });

  it("renders tool status without a fabricated text panel or empty result body", () => {
    const view = render(<AgentActivityCard entry={entry("tool.completed", "", {
      callId: "call-one", name: "read", status: "completed", outputPreview: "" })} projectCycle={1} />);
    expect(screen.getByText("工具调用")).toBeVisible();
    expect(screen.getByText("完成")).toBeVisible();
    expect(view.container.querySelector(".agent-thought-panel")).toBeNull();
    expect(screen.queryByText("查看工具结果")).not.toBeInTheDocument();
  });
});
