import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FinalResultsView } from "./WorkspacePage";
import { getDisplayedFile, getArtifactViewUrl } from "../api";
import type { Project } from "../types";
import "../styles.css";
import { normalizeProject } from "../lib";

vi.mock("../api", () => ({
  getDisplayedFile: vi.fn(),
  getArtifactDownloadUrl: vi.fn(() => "./download"),
  getArtifactHtmlPreviewUrl: vi.fn(() => "./report-preview"),
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
    vi.mocked(getArtifactViewUrl).mockReset().mockReturnValue("./view");
  });

  it("enlarges the existing HTML reader without reloading and restores focus and inline reading on Escape", async () => {
    const user = userEvent.setup();
    vi.mocked(getDisplayedFile).mockResolvedValue({ path: "index.html", name: "Interactive report", kind: "text", content: "<input>" });
    const { container } = render(<FinalResultsView projectId="prj_results" project={{ ...baseProject, display: {
      primary: { agent: "analyst", path: "index.html", title: "Interactive report", artifactId: "html", commitSha: "a".repeat(40) }, items: [] } }} />);
    const frame = await screen.findByTitle("Interactive report");
    const documentPanel = container.querySelector<HTMLElement>(".artifact-document")!;
    documentPanel.scrollTop = 135;
    const expand = screen.getByRole("button", { name: "放大阅读" });
    await user.click(expand);
    const dialog = screen.getByRole("dialog", { name: "最终结果放大阅读" });
    expect(within(dialog).getByTitle("Interactive report")).toBe(frame);
    expect(document.body.style.overflow).toBe("hidden");
    expect(dialog).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole("button", { name: "关闭放大阅读" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTitle("Interactive report")).toBe(frame);
    expect(documentPanel.scrollTop).toBe(135);
    expect(getDisplayedFile).toHaveBeenCalledOnce();
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(expand).toHaveFocus();
    expect(container.querySelector(".final-result-files")).toBeVisible();
  });

  it("switches result files in the enlarged reader and retains file and Markdown mode when closed", async () => {
    const user = userEvent.setup();
    vi.mocked(getDisplayedFile).mockImplementation(async (_projectId, item) => ({ path: item.path, name: item.title,
      kind: "markdown", content: `# ${item.title}\n\nLong result` }));
    render(<FinalResultsView projectId="prj_results" project={{ ...baseProject, display: {
      primary: { agent: "analyst", path: "report.md", title: "Report" },
      items: [{ agent: "analyst", path: "evidence.md", title: "Evidence" }] } }} />);
    await screen.findByRole("heading", { name: "Report" });
    await user.click(screen.getByRole("button", { name: "放大阅读" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("tab", { name: "Evidence" }));
    await screen.findByRole("heading", { name: "Evidence" });
    await user.click(screen.getByRole("button", { name: "源码" }));
    const documentPanel = screen.getByRole("dialog").querySelector<HTMLElement>(".artifact-document")!;
    documentPanel.scrollTop = 75;
    await user.click(screen.getByRole("button", { name: "关闭放大阅读" }));
    expect(screen.getByRole("tab", { name: "Evidence" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/# Evidence/)).toBeVisible();
    expect(documentPanel.closest(".final-results-view")!.scrollTop).toBe(75);
    expect(screen.getByRole("button", { name: "放大阅读" })).toHaveFocus();
    expect(getDisplayedFile).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "放大阅读" }));
    expect(screen.getByText(/# Evidence/)).toBeVisible();
    await user.keyboard("{Escape}");
  });

  it("releases the modal focus and scrolling state if the result list becomes empty", async () => {
    const user = userEvent.setup();
    vi.mocked(getDisplayedFile).mockResolvedValue({ path: "report.md", name: "Report", kind: "markdown", content: "# Report" });
    const view = render(<FinalResultsView projectId="prj_results" project={{ ...baseProject,
      display: { primary: { agent: "analyst", path: "report.md", title: "Report" }, items: [] } }} />);
    await screen.findByRole("heading", { name: "Report" });
    await user.click(screen.getByRole("button", { name: "放大阅读" }));
    expect(document.body.style.overflow).toBe("hidden");
    view.rerender(<FinalResultsView projectId="prj_results" project={baseProject} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(view.container.inert).not.toBe(true);
  });

  it("renders the selected original HTML through its source URL without a frame sandbox", async () => {
    vi.mocked(getDisplayedFile).mockResolvedValue({ path: "reports/index.html", name: "Report", kind: "text", agent: "analyst",
      origin: "workspace", content: '<p id="result"></p><script>document.querySelector("#result").textContent="ready"</script>' });
    render(<FinalResultsView projectId="prj_results" project={{ ...baseProject, display: {
      primary: { agent: "analyst", path: "reports/index.html", title: "Report", artifactId: "html-1", commitSha: "a".repeat(40) }, items: [] } }} />);
    const frame = await screen.findByTitle("Report");
    expect(frame).toHaveAttribute("src", "./report-preview");
    expect(frame).not.toHaveAttribute("sandbox");
    expect(frame).not.toHaveAttribute("srcdoc");
  });

  it.each(["completed", "running-project", "running-node", "later-worker"])("shows the formal terminal Main conclusion only after project completion (%s)", condition => {
    const main = "Main 已核实最终成果与研究边界。", worker = "最近一次发布收尾记录。";
    const node = { id: "node_main", node: { kind: "agent", nodeId: "main", agentId: "main" }, workflowRevision: 1,
      activationRequestId: "main-activation", inputSnapshotRef: "main-input", activatedByAgentId: "analyst", status: condition === "running-node" ? "running" : "completed",
      activatedAt: "2026-11-08T00:00:00Z", updatedAt: "2026-11-08T00:02:00Z", completedAt: "2026-11-08T00:02:00Z", output: main };
    const project = normalizeProject({ ...baseProject, git: { enabled: true }, status: condition === "running-project" ? "running" : "completed",
      latestHandoff: { agent: "analyst", invocationId: "inv_worker", excerpt: worker, markdown: worker, updatedAt: "2026-11-08T00:01:00Z" },
      nodeRuns: [node, ...(condition === "later-worker" ? [{ ...node, id: "node_worker", node: { kind: "agent", nodeId: "analyst", agentId: "analyst" },
        completedAt: "2026-11-08T00:03:00Z", output: worker }] : [])] });
    render(<FinalResultsView projectId="prj_results" project={project} />);
    const terminal = condition === "completed";
    expect(screen.getAllByText(terminal ? main : worker)[0]).toBeVisible();
    expect(screen.queryByText(terminal ? worker : main)).not.toBeInTheDocument();
    expect(project.latestHandoff?.markdown).toBe(worker);
  });

  it.each(["succeeded", "working", "failed"])("uses only finished standalone Git handoffs after an old accepted receipt (%s)", status => {
    const old = "早期已接受交接。", current = "新版正式成果交接。";
    const project = normalizeProject({ ...baseProject, git: { enabled: true },
      taskCompletions: { old: { agent: "analyst", invocationId: "inv_old", status: "accepted", summary: old,
        acceptedAt: "2026-11-06T00:00:00Z" } },
      executions: [{ id: "execution_new", nodeRunId: "node_new", taskId: "task_new", agentId: "analyst", purpose: "delivery",
        ownershipEpoch: 1, status, executionBranch: "executions/execution_new", worktreePath: "/project/git-worktrees/execution_new",
        invocationId: "inv_new", queuedAt: "2026-11-08T00:00:00Z", startedAt: "2026-11-08T00:00:00Z",
        updatedAt: "2026-11-08T00:01:00Z", ...(status === "working" ? {} : { completedAt: "2026-11-08T00:01:00Z" }), output: current }] });
    render(<FinalResultsView projectId="prj_results" project={project} />);
    const expected = status === "succeeded" ? current : old;
    expect(screen.getAllByText(expected)[0]).toBeVisible();
    expect(screen.queryByText(status === "succeeded" ? old : current)).not.toBeInTheDocument();
  });

  it("reads the same exact publication again when the user reselects a failed file", async () => {
    const user = userEvent.setup();
    const selection = { agent: "analyst", path: "reports/final.md", title: "最终报告",
      artifactId: "published-report", commitSha: "a".repeat(40) };
    vi.mocked(getDisplayedFile).mockRejectedValueOnce(new Error("Artifact not found"))
      .mockResolvedValueOnce({ path: selection.path, name: selection.title, kind: "markdown",
        agent: selection.agent, origin: "workspace", id: selection.artifactId, commitSha: selection.commitSha,
        content: "# 正式成果已恢复" });
    render(<FinalResultsView projectId="prj_results" project={{ ...baseProject,
      display: { primary: selection, items: [] } }} />);
    expect(await screen.findByText("Artifact not found")).toBeVisible();
    expect(getDisplayedFile).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("tab", { name: /最终报告/ }));
    expect(await screen.findByRole("heading", { name: "正式成果已恢复" })).toBeVisible();
    expect(getDisplayedFile).toHaveBeenCalledTimes(2);
    expect(getDisplayedFile).toHaveBeenNthCalledWith(2, "prj_results", selection);
    expect(screen.queryByText("Artifact not found")).not.toBeInTheDocument();
  });

  it("keeps Markdown report links and images bound to the same published source", async () => {
    const commitSha = "a".repeat(40);
    vi.mocked(getArtifactViewUrl).mockImplementation((projectId, artifact) =>
      `./api/projects/${projectId}/artifacts/content?${new URLSearchParams({ path: artifact.path,
        agent: artifact.agent!, commitSha: artifact.commitSha! })}`);
    vi.mocked(getDisplayedFile).mockResolvedValue({ path: "reports/final.md", name: "final.md", kind: "markdown",
      agent: "analyst", origin: "workspace", id: "published-report", commitSha,
      content: "[Evidence](../evidence/matrix.csv)\n\n![Result figure](../figures/result.svg)\n\n[Paper](https://example.org/paper)" });
    render(<FinalResultsView projectId="prj_results" project={{ ...baseProject, display: {
      primary: { agent: "analyst", path: "reports/final.md", title: "Final report", artifactId: "published-report", commitSha }, items: [] } }} />);
    const link = await screen.findByRole("link", { name: "Evidence" });
    const image = screen.getByRole("img", { name: "Result figure" });
    for (const [url, path] of [[link.getAttribute("href")!, "evidence/matrix.csv"],
      [image.getAttribute("src")!, "figures/result.svg"]]) {
      const resolved = new URL(url!, document.baseURI);
      expect(resolved.pathname).toContain("/api/projects/prj_results/artifacts/content");
      expect(resolved.searchParams.get("path")).toBe(path);
      expect(resolved.searchParams.get("agent")).toBe("analyst");
      expect(resolved.searchParams.get("commitSha")).toBe(commitSha);
      expect(resolved.searchParams.has("artifactId")).toBe(false);
    }
    expect(screen.getByRole("link", { name: "Paper" })).toHaveAttribute("href", "https://example.org/paper");
  });

  it.each([
    ["evidence/papers.jsonl", '{"id":"P01","read":"full text"}'],
    ["evidence/references.bib", "@article{P01, title={Verified source}}"]
  ])("previews the published text evidence file %s", async (path, content) => {
    vi.mocked(getDisplayedFile).mockResolvedValue({ path, name: path, kind: "text", agent: "analyst", origin: "workspace", content });
    const selection = { agent: "analyst", path, title: path, artifactId: "evidence-publication", commitSha: "a".repeat(40) };
    render(<FinalResultsView projectId="prj_results" project={{ ...baseProject, display: { primary: selection, items: [] } }} />);
    expect(await screen.findByText(content)).toBeVisible();
    expect(getDisplayedFile).toHaveBeenCalledWith("prj_results", selection);
    expect(screen.queryByText("该文件不适合直接预览")).not.toBeInTheDocument();
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
