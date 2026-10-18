import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGitHubRepositoryStatus, getProjectGitGraph } from "../../api";
import type { GitGraphCommit, GitGraphEmptyReason, Project } from "../../types";
import { GitTreeDialog, layoutGitGraph } from "./GitTreeDialog";
import { normalizeProject } from "../../lib";

vi.mock("../../api", () => ({
  getGitHubRepositoryStatus: vi.fn(async () => ({
    exists: true,
    observedAt: "2026-09-24T00:00:00.000Z"
  })),
  getProjectGitGraph: vi.fn()
}));

function commit(sha: string, parents: string[]): GitGraphCommit {
  return {
    sha,
    parents,
    subject: sha,
    authorName: "OpenFARS Git Service",
    authorEmail: "openfars@localhost",
    authoredAt: "2026-09-24T00:00:00.000Z",
    committerName: "OpenFARS Git Service",
    committerEmail: "openfars@localhost",
    committedAt: "2026-09-24T00:00:00.000Z",
    refs: [],
    trailers: {},
    pullRequests: [],
    changedFiles: [],
    system: false
  };
}

describe("GitTree lane layout", () => {
  beforeEach(() => {
    vi.mocked(getProjectGitGraph).mockReset();
    vi.mocked(getGitHubRepositoryStatus).mockClear();
  });

  it("does not overlap slow graph polls and cancels polling on close", async () => {
    vi.useFakeTimers();
    vi.mocked(getProjectGitGraph).mockImplementation(() => new Promise(() => undefined));
    const view = render(<GitTreeDialog project={normalizeProject({ id: "slow-graph", title: "Slow graph", status: "running" })} onClose={vi.fn()} />);
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(getProjectGitGraph).toHaveBeenCalledTimes(1);
      const signal = vi.mocked(getProjectGitGraph).mock.calls[0]?.[2];
      view.unmount();
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it("keeps the first-parent lane and allocates a separate lane for a merged branch", () => {
    const layout = layoutGitGraph([
      commit("merge", ["main-parent", "agent-parent"]),
      commit("agent-parent", ["root"]),
      commit("main-parent", ["root"]),
      commit("root", [])
    ]);
    expect(layout.lanes.get("merge")).toBe(0);
    expect(layout.lanes.get("main-parent")).toBe(0);
    expect(layout.lanes.get("agent-parent")).toBe(1);
    expect(layout.maxLane).toBeGreaterThanOrEqual(1);
  });

  it.each<[GitGraphEmptyReason, string]>([
    ["git_disabled", "项目未启用 Git"],
    ["repository_uninitialized", "仓库尚未初始化"],
    ["repository_initializing", "仓库仍在初始化"],
    ["repository_failed", "仓库初始化失败"],
    ["before_first_assignment", "尚未开始成员分工"],
    ["branch_without_commits", "成员分支尚无业务提交"],
    ["commits_without_pull_request", "已有提交，尚未创建 Pull Request"]
  ])("renders backend reason %s without fake graph nodes", async (emptyReason, title) => {
    vi.mocked(getProjectGitGraph).mockResolvedValueOnce({
      commits: [],
      refs: [],
      emptyReason,
      observedAt: "2026-09-24T00:00:00.000Z"
    });
    const project = {
      id: `project-${emptyReason}`,
      title: "GitTree empty-state fixture",
      requirement: "Explain missing Git topology",
      status: emptyReason === "repository_failed" ? "paused" : "running",
      phase: `git:${emptyReason}`,
      turn: 0,
      cycle: 0,
      agentProgress: {},
      overallProgress: { percent: 0, label: "waiting", estimated: true, successfulCalls: 0 },
      agents: {},
      orchestration: {
        schemaVersion: 2,
        agents: [{ name: "main", template: "main" }],
        collaborations: [],
        input: { source: "input", target: "main" },
        routes: { main: [{ target: "finish", kind: "weak" }] },
        decisionPlans: {},
        allowUserIntervention: true,
        termination: { agent: "main", condition: "done", decisionBy: "main", automatic: false }
      },
      git: {
        enabled: emptyReason !== "git_disabled",
        status: emptyReason === "repository_failed" ? "failed" : "ready",
        account: { id: "account", login: "alice", providerUserId: 1 },
        repository: {
          owner: "alice",
          name: "repo",
          htmlUrl: "https://github.example.test/alice/repo",
          private: true,
          defaultBranch: "main",
          localPath: "/srv/openfars/repo"
        },
        ...(emptyReason === "repository_failed"
          ? { initialization: { operationId: "operation-1", attempt: 1, completedSteps: [], error: "redacted initialization failure" } }
          : {})
      }
    } as unknown as Project;

    const view = render(<GitTreeDialog project={project} onClose={vi.fn()} />);
    const explanation = await screen.findByLabelText("Git 提交图状态说明");
    expect(explanation).toHaveAttribute("data-reason-code", emptyReason);
    expect(explanation).toHaveTextContent(title);
    expect(explanation).toHaveTextContent(emptyReason);
    expect(view.container.querySelectorAll(".git-tree-node")).toHaveLength(0);
    expect(screen.getByText("没有可展示的真实 commit。")).toBeInTheDocument();
  });
});
