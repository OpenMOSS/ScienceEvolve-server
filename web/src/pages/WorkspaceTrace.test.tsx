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
  it("follows streaming text inside the card until the reader scrolls up", () => {
    const view = render(<AgentActivityCard entry={entry("assistant.delta", "First")} projectCycle={1} />);
    const output = screen.getByRole("region", { name: "Agent 正在输出的正文" });
    Object.defineProperties(output, { scrollHeight: { value: 640 }, clientHeight: { value: 320 } });
    view.rerender(<AgentActivityCard entry={entry("assistant.delta", "First and second")} projectCycle={1} />);
    expect(output.scrollTop).toBe(320);
    output.scrollTop = 100;
    fireEvent.scroll(output);
    view.rerender(<AgentActivityCard entry={entry("assistant.delta", "First, second and third")} projectCycle={1} />);
    expect(output.scrollTop).toBe(100);
    view.rerender(<AgentActivityCard entry={entry("assistant.message", "Complete")} projectCycle={1} />);
    expect(screen.queryByRole("region", { name: "Agent 正在输出的正文" })).not.toBeInTheDocument();
    expect(screen.getByText("Complete")).toBeVisible();
  });

  it("renders LaTeX delimiters alongside Markdown and preserves code examples", () => {
    const message = [
      "## 数值校验",
      "",
      String.raw`- **误差**约 \(2.84\times10^{-14}\) Eh，\(S^2\) 约 \(1.14\times10^{-14}\)；另有 $x^2$。`,
      "",
      String.raw`\[ E = mc^2 \]`,
      "",
      String.raw`代码：\`\(x\)\``.replaceAll("\\`", "`"),
      "",
      "```tex",
      String.raw`\[ y = 2 \]`,
      "```"
    ].join("\n");
    const { container } = render(<AgentActivityCard entry={entry("assistant.message", message)} projectCycle={1} />);
    expect(screen.getByRole("heading", { name: "数值校验" })).toBeVisible();
    expect(container.querySelector("li strong")).toHaveTextContent("误差");
    expect(container.querySelectorAll(".katex")).toHaveLength(5);
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(container.querySelector("p code")?.textContent).toBe(String.raw`\(x\)`);
    expect(container.querySelector("pre code")?.textContent).toContain(String.raw`\[ y = 2 \]`);
  });

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
    expect(screen.getByText("完成")).not.toBeVisible();
    fireEvent.click(screen.getByText("工具调用"));
    expect(screen.getByText("完成")).toBeVisible();
    expect(screen.getByText("（空结果）")).toBeVisible();
    expect(view.container.querySelector(".agent-thought-panel")).toBeNull();
    expect(view.container.querySelector(".agent-tool-disclosure")).toBeNull();
  });

  it("expands a compact tool row to show the full input and output", () => {
    const view = render(<AgentActivityCard entry={entry("tool.completed", "", {
      callId: "call-one", name: "read", status: "completed",
      input: "read research-notes.md", outputPreview: "Sample result" })} projectCycle={1} />);
    const disclosure = view.container.querySelector<HTMLDetailsElement>(".agent-tool-disclosure")!;
    const group = disclosure.closest(".agent-tools-panel");
    expect(group).not.toHaveAttribute("open");
    expect(disclosure).not.toBeVisible();
    fireEvent.click(screen.getByText("工具调用"));
    expect(group).toHaveAttribute("open");
    expect(disclosure).not.toHaveAttribute("open");
    fireEvent.click(disclosure.querySelector("summary")!);
    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByLabelText("工具输入")).toHaveTextContent("read research-notes.md");
    expect(screen.getByText("Sample result")).toBeVisible();
    fireEvent.click(screen.getByText("工具调用"));
    expect(screen.getByText("Sample result")).not.toBeVisible();
  });

  it.each([
    { status: "completed" },
    { status: "started", outputPreview: "" },
    { status: "completed", outputPreview: "", truncated: true }
  ])("does not label a missing, unfinished or truncated tool result as empty ($status)", tool => {
    render(<AgentActivityCard entry={entry(`tool.${tool.status}`, "", { callId: "call-one", name: "read", ...tool })} projectCycle={1} />);
    expect(screen.queryByText("（空结果）")).not.toBeInTheDocument();
    expect(screen.queryByText("查看工具结果")).not.toBeInTheDocument();
  });
});
