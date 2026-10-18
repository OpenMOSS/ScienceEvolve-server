import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { normalizeProject } from "../lib";
import { ProjectStatePanel } from "./ProjectStatePanel";

describe("formal collaboration state panel", () => {
  it("shows resource readiness and platform results without treating business claims or missing native receipts as completion", () => {
    const project = normalizeProject({ id: "p", status: "running", collaboration: { stateRevision: 9,
      businessState: [{ object: { kind: "project", id: "p" }, sequence: 8, updatedAt: "2026-10-13T00:00:00Z", extensions: { completed: true, resultReceived: true } }],
      formalState: { domain: { scheduler: "serial", protocol: "project-state-v1" },
        checkpoint: { version: "a".repeat(64), revision: 3, lifecycle: { status: "running" } },
        invocationCommit: { status: "in_progress" }, experiments: { version: "b".repeat(64), revision: 4, ledger: { experiments: [
          { id: "resource", agent: "worker-a", taskId: "original-task", runId: "original-run", status: "resource_ready", required: true, resultReceived: false },
          { id: "result", agent: "worker-b", taskId: "other-task", runId: "other-run", status: "succeeded", required: true, resultReceived: false }
        ] } } } } });
    const { rerender } = render(<ProjectStatePanel project={project} />);
    expect(screen.getByText("本轮结果提交：待完成提交")).toBeInTheDocument();
    const experiments = screen.getByRole("region", { name: "实验状态", hidden: true });
    expect(within(experiments).getByText(/worker-a · 资源已就绪/)).toBeInTheDocument();
    expect(within(experiments).getByText(/worker-b · 执行成功/)).toBeInTheDocument();
    expect(within(experiments).getAllByText("尚未实收")).toHaveLength(2);
    expect(within(experiments).getByText("original-task")).toBeInTheDocument();
    expect(within(experiments).getByText("original-run")).toBeInTheDocument();
    expect(project.status).toBe("running"); expect(screen.queryByText("原会话已实收")).not.toBeInTheDocument();
    project.collaboration!.formalState!.experiments.ledger.experiments[1].resultReceived = true;
    rerender(<ProjectStatePanel project={project} />);
    expect(screen.getByText("原会话已实收")).toBeInTheDocument(); expect(project.status).toBe("running");
  });
});
