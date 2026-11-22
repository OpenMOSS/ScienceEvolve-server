import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowGateEditor } from "./WorkflowGateEditor";
import { WorkflowGateRuns } from "./WorkflowGateRuns";
import { adaptWorkflowToCanvas } from "./core/canvas-adapter";
import { normalizeAgentOrchestration } from "../../lib";
import type { AgentOrchestrationTemplate } from "../../types";
import type { GateRun } from "../../../../server/src/internal/shared/workflow-gate.js";

afterEach(cleanup);
const workflow: AgentOrchestrationTemplate = { schemaVersion: 2, agents: [{ name: "main" }, { name: "worker" }],
  input: { source: "input", target: "worker" }, routes: { main: [{ kind: "weak", target: "worker" }], worker: [{ kind: "strong", target: "main" }] },
  decisionPlans: {}, allowUserIntervention: true, termination: { agent: "main", condition: "Complete the task", decisionBy: "main", automatic: false } };

describe("Workflow Gate configuration and visible facts", () => {
  it("creates a code Gate and preserves it through import and canvas projection", () => {
    const change = vi.fn(); render(<WorkflowGateEditor workflow={workflow} onChange={change} />);
    fireEvent.click(screen.getByText("新增 Gate"));
    fireEvent.change(screen.getByLabelText("Gate ID"), { target: { value: "check" } });
    fireEvent.change(screen.getByLabelText("Gate 名称"), { target: { value: "检查证据" } });
    fireEvent.change(screen.getByLabelText("检查代码"), { target: { value: 'print("negative feedback")' } });
    fireEvent.change(screen.getByLabelText("输出格式"), { target: { value: "text" } });
    expect(screen.getByRole("dialog", { name: "新增 Gate 配置" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "worker" }));
    fireEvent.click(screen.getByText("保存 Gate"));
    expect(change).toHaveBeenCalledOnce();
    const saved = normalizeAgentOrchestration(change.mock.calls[0][0]);
    expect(saved.gates).toEqual([expect.objectContaining({ id: "check", verifier: { kind: "code", interpreter: "python3", code: 'print("negative feedback")', output: "text" } })]);
    expect(saved.routes.check).toEqual([{ kind: "strong", target: "worker" }]);
    expect(adaptWorkflowToCanvas(saved).nodes.find(node => node.id === "check")?.gate?.name).toBe("检查证据");
  });
  it("supports Agent checking, multiple outgoing paths and cancelling without saving", () => {
    const change = vi.fn(); render(<WorkflowGateEditor workflow={workflow} onChange={change} />);
    fireEvent.click(screen.getByRole("button", { name: /新增 Gate/ }));
    fireEvent.change(screen.getByLabelText("Gate ID"), { target: { value: "review-check" } });
    fireEvent.change(screen.getByLabelText("Gate 名称"), { target: { value: "Review" } });
    fireEvent.click(screen.getByRole("button", { name: /Agent 检查/ }));
    fireEvent.change(screen.getByLabelText("检查 Agent"), { target: { value: "worker" } });
    fireEvent.change(screen.getByLabelText("检查指引"), { target: { value: "Review actual evidence" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "worker" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "main" }));
    fireEvent.click(screen.getByRole("button", { name: "保存 Gate" }));
    expect(change.mock.calls[0][0]).toMatchObject({ gates: [{ verifier: { kind: "agent", agentId: "worker", instructions: "Review actual evidence" } }],
      routes: { "review-check": [{ target: "worker", kind: "weak" }, { target: "main", kind: "weak" }] } });
    fireEvent.click(screen.getByRole("button", { name: /新增 Gate/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(change).toHaveBeenCalledOnce();
  });
  it("shows concise required-field errors beside the save action without changing the workflow", () => {
    const change = vi.fn(); render(<WorkflowGateEditor workflow={workflow} onChange={change} />);
    fireEvent.click(screen.getByRole("button", { name: /新增 Gate/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存 Gate" }));
    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("请填写Gate ID。");
    expect(error).toHaveTextContent("请填写Gate 名称。");
    expect(error).toHaveTextContent("请填写检查代码。");
    expect(error.closest(".gate-actions")).toContainElement(screen.getByRole("button", { name: "保存 Gate" }));
    expect(error).not.toHaveTextContent('"code":');
    expect(change).not.toHaveBeenCalled();
  });
  it("identifies malformed hard-rule JSON and preserves the draft", () => {
    const change = vi.fn(); render(<WorkflowGateEditor workflow={workflow} onChange={change} />);
    fireEvent.click(screen.getByRole("button", { name: /新增 Gate/ }));
    fireEvent.change(screen.getByLabelText("Gate 名称"), { target: { value: "Evidence review" } });
    fireEvent.change(screen.getByLabelText("Gate 硬规则"), { target: { value: "[{" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Gate" }));
    expect(screen.getByRole("alert")).toHaveTextContent("硬规则 JSON 格式无效");
    expect(screen.getByLabelText("Gate 名称")).toHaveValue("Evidence review");
    expect(change).not.toHaveBeenCalled();
  });
  it("keeps read-only configuration disabled", () => {
    render(<WorkflowGateEditor workflow={workflow} readOnly onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /新增 Gate/ })).toBeDisabled();
  });
  it("rejects hard rules that name an unconfigured path", () => {
    const gate = { id: "check", name: "Check", verifier: { kind: "agent" as const, agentId: "worker", instructions: "Read actual evidence" } };
    const change = vi.fn(); render(<WorkflowGateEditor workflow={{ ...workflow, gates: [gate], routes: { ...workflow.routes, check: [{ target: "worker", kind: "strong" }] } }} gateId="check" onChange={change} />);
    fireEvent.change(screen.getByLabelText("Gate 硬规则"), { target: { value: JSON.stringify([{ target: "unknown", all: [{ path: ["score"], operator: "gt", value: 1 }] }]) } });
    fireEvent.click(screen.getByText("保存 Gate"));
    expect(screen.getByRole("alert").textContent).toContain("硬规则必须覆盖每条出边"); expect(change).not.toHaveBeenCalled();
  });
  it("shows negative business feedback separately from execution errors", () => {
    const run: GateRun = { id: "run", version: 3, gate: { id: "check", name: "Evidence", verifier: { kind: "agent", agentId: "worker", instructions: "Review" } },
      targets: ["main"], configurationHash: "config", inputHash: "input", origin: { projectId: "p", sourceRunId: "task-1", nodeId: "worker", workflowRevision: 1, input: "original" },
      executorAgentId: "worker", decisionAgentId: "worker", status: "selected", selectedTarget: "main", result: "Negative business feedback",
      evidence: { invocationId: "inv", callId: "actual-check", eventId: "result" }, createdAt: "now", updatedAt: "now" };
    render(<WorkflowGateRuns runs={[run, { ...run, id: "error", status: "error", selectedTarget: undefined, result: undefined, error: "Missing dependency" }]} />);
    expect(screen.getByText("Negative business feedback", { exact: false })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Missing dependency");
    expect(screen.getByText("Evidence · 路径已选定，等待交付 → main")).toBeTruthy();
  });
});
