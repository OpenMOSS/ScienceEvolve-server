import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FinalResultsView } from "./WorkspacePage";
import { getDisplayedFile } from "../api";
import type { Project } from "../types";
import "../styles.css";
import { normalizeProject } from "../lib";

vi.mock("../api", () => ({
  getDisplayedFile: vi.fn(),
  getArtifactDownloadUrl: vi.fn(() => "./download"),
  getArtifactViewUrl: vi.fn(() => "./view")
}));

const baseProject = {
  id: "prj_results",
  title: "结果展示测试",
  requirement: "验证最终结果展示。",
  status: "completed",
  phase: "accepted",
  turn: 2,
  cycle: 1,
  agentProgress: {},
  overallProgress: {
    percent: 100,
    label: "已完成",
    estimated: true,
    successfulCalls: 1
  },
  agents: {},
  orchestration: {
    agents: [{ name: "analyst", kind: "worker", template: "general" }],
    input: { source: "input", target: "analyst" },
    routes: { analyst: [{ target: "finish", kind: "weak" }] },
    decisionPlans: { analyst: "完成任务" },
    allowUserIntervention: true,
    termination: {
      agent: "analyst",
      condition: "结果完成",
      decisionBy: "main",
      automatic: false
    }
  }
} as unknown as Project;

describe("FinalResultsView", () => {
  beforeEach(() => {
    vi.mocked(getDisplayedFile).mockReset();
  });

  it("shows the worker conclusion and selected JSON file as formatted text", async () => {
    vi.mocked(getDisplayedFile).mockResolvedValue({
      path: "results/metrics.json",
      name: "metrics.json",
      kind: "text",
      agent: "analyst",
      origin: "workspace",
      content: '{"accuracy":0.91}'
    });

    render(
      <FinalResultsView
        projectId="prj_results"
        project={{
          ...baseProject,
          latestHandoff: {
            agent: "analyst",
            invocationId: "inv-1",
            excerpt: "分析完成。",
            markdown: "# Result\n\n已完成。",
            updatedAt: "2026-08-26T00:00:00.000Z"
          },
          display: {
            primary: { agent: "analyst", path: "results/metrics.json", title: "指标 JSON" },
            items: [
              { agent: "analyst", path: "reports/final.md", title: "详细报告" },
              { agent: "analyst", path: "results/metrics.json", title: "重复指标" }
            ]
          }
        }}
      />
    );

    expect(screen.getByText("分析完成。")).toBeInTheDocument();
    expect(screen.getByText("指标 JSON")).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "主结果指标 JSON",
      "详细报告"
    ]);
    await waitFor(() => expect(screen.getByText(/\"accuracy\": 0\.91/)).toBeInTheDocument());
  });

  it("uses a media preview for image result files without reading them as text", async () => {
    render(
      <FinalResultsView
        projectId="prj_results"
        project={{
          ...baseProject,
          display: {
            primary: { agent: "analyst", path: "figures/plot.svg", title: "结果图" },
            items: []
          }
        }}
      />
    );

    const image = await screen.findByRole("img", { name: "结果图" });
    expect(image).toHaveAttribute("src", "./view");
    expect(getDisplayedFile).not.toHaveBeenCalled();
  });

  it("shows accepted Git conclusions and published files without a manually selected display", async () => {
    const commitSha = "a".repeat(40);
    vi.mocked(getDisplayedFile).mockResolvedValue({ path: "report.md", name: "report.md", kind: "markdown", content: "# Verified publication" });
    render(<FinalResultsView projectId="prj_results" project={normalizeProject({ ...baseProject, git: { enabled: true },
      artifacts: [{ id: "publication", agent: "analyst", path: "report.md", title: "Accepted report", gitSource: { commitSha } }],
      taskCompletions: { final: { status: "accepted", agent: "main", invocationId: "inv_final", acceptedAt: "2026-10-13T12:00:00Z", summary: "Git delivery completed." } }
    })} />);
    expect(screen.queryByText("暂无最终结果")).not.toBeInTheDocument();
    expect(screen.getByText(/尚未指定最终展示清单/)).toBeVisible();
    expect(screen.getAllByText("Git delivery completed.")[0]).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Verified publication" })).toBeVisible();
    expect(getDisplayedFile).toHaveBeenCalledWith("prj_results", expect.objectContaining({ artifactId: "publication", commitSha }));
  });

  it("wraps long inline result paths inside the detailed-result card", () => {
    const longPath =
      "/inspire/qb-ilm2/project/example/user/ScienceEvolve/data/projects/prj_1234567890abcdef1234567890abcdef/workspaces/reporter/shared/report.md";

    const { container } = render(
      <FinalResultsView
        projectId="prj_results"
        project={{
          ...baseProject,
          latestHandoff: {
            agent: "analyst",
            invocationId: "inv-long-path",
            excerpt: "长路径展示完成。",
            markdown: `## Result\n完成。\n\n## Evidence\n- Primary: \`${longPath}\`\n\n## Risks and Unresolved Issues\n无。`,
            updatedAt: "2026-08-26T00:00:00.000Z"
          }
        }}
      />
    );

    const report = container.querySelector(".final-result-report");
    const inlineCode = screen.getByText(longPath);
    expect(report).toHaveStyle({ overflow: "hidden" });
    expect(inlineCode).toHaveStyle({
      whiteSpace: "normal",
      overflowWrap: "anywhere",
      wordBreak: "break-word"
    });
  });

  it("keeps result sections expanded by default and lets each section collapse", async () => {
    const user = userEvent.setup();
    render(
      <FinalResultsView
        projectId="prj_results"
        project={{
          ...baseProject,
          latestHandoff: {
            agent: "analyst",
            invocationId: "inv-collapse",
            excerpt: "当前摘要。",
            markdown: "## Result\n\n详细结果内容。",
            updatedAt: "2026-08-26T00:00:00.000Z"
          },
          display: {
            primary: { agent: "analyst", path: "report.md", title: "报告" },
            items: []
          }
        }}
      />
    );

    const summaryToggle = screen.getByRole("button", { name: /项目结论/ });
    const reportToggle = screen.getByRole("button", { name: /最近一次 Agent 交接/ });
    expect(summaryToggle).toHaveAttribute("aria-expanded", "true");
    expect(reportToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("当前摘要。")).toBeInTheDocument();
    expect(screen.getByText("详细结果内容。")).toBeInTheDocument();

    await user.click(reportToggle);
    expect(reportToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("详细结果内容。")).not.toBeInTheDocument();
    expect(summaryToggle).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps all result sections in the outer scroll flow", () => {
    const { container } = render(
      <FinalResultsView
        projectId="prj_results"
        project={{
          ...baseProject,
          latestHandoff: {
            agent: "analyst",
            invocationId: "inv-layout",
            excerpt: "摘要内容。",
            markdown: "## Result\n\n详细结果内容。",
            updatedAt: "2026-08-26T00:00:00.000Z"
          },
          display: {
            primary: { agent: "analyst", path: "report.md", title: "报告" },
            items: [{ agent: "analyst", path: "metrics.json", title: "指标" }]
          }
        }}
      />
    );

    expect(container.querySelector(".final-results-view")).toHaveStyle({
      overflowX: "hidden",
      overflowY: "auto"
    });
    expect(container.querySelector(".final-result-summary-body")).toHaveStyle({
      overflow: "visible"
    });
    expect(container.querySelector(".final-result-report-body")).toHaveStyle({
      overflow: "visible"
    });
    expect(container.querySelector(".final-result-files")).toHaveStyle({
      display: "flex",
      flexDirection: "column"
    });
  });
});
