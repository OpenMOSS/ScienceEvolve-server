import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ensureExecutionSummary, getGitHubRepositoryStatus, getProjectGitGraph } from "../../api";
import { DEFAULT_AGENT_ORCHESTRATION, DEFAULT_AGENTS } from "../../lib";
import type { AgentEvent, Project } from "../../types";
import { runtimeProjectFixture } from "../../test/runtime-project";
import {
  planRuntimeCanvasViewport,
  runtimeGroupMemberStates,
  WorkflowCanvasRuntime
} from "./WorkflowCanvasRuntime";

vi.mock("../../api", () => ({
  ensureExecutionSummary: vi.fn(async () => ({ invocationId: "inv_idea", status: "completed", text: "已完成实验，等待复核。" })),
  getGitHubRepositoryStatus: vi.fn(async () => ({ exists: true, observedAt: "2026-09-24T00:00:00.000Z" })),
  getProjectGitGraph: vi.fn(async () => ({
    commits: [{
      sha: "3".repeat(40),
      parents: ["2".repeat(40), "1".repeat(40)],
      subject: "[OpenFARS][a] Merge PR #42 into main",
      body: "OpenFARS-Agent: a",
      authorName: "GitHub User",
      authorEmail: "user@example.test",
      authoredAt: "2026-09-22T00:00:00.000Z",
      committerName: "GitHub",
      committerEmail: "noreply@example.test",
      committedAt: "2026-09-22T00:00:00.000Z",
      refs: ["main"],
      trailers: { "OpenFARS-Agent": "a", "OpenFARS-Group": "group-run-1" },
      agentId: "a",
      taskId: "task-a",
      executionId: "execution-final",
      groupRunId: "group-run-1",
      pullRequests: [{ id: "pull-final", number: 42, status: "merged", htmlUrl: "https://github.example.test/pulls/42", role: "merge" }],
      changedFiles: [{ status: "M", path: "paper/main.tex" }],
      htmlUrl: "https://github.example.test/commit/3333",
      system: false
    }],
    refs: [{ name: "main", sha: "3".repeat(40) }],
    repositoryUrl: "https://github.example.test/example-user/runtime-project",
    githubActor: "example-user",
    observedAt: "2026-09-24T00:00:00.000Z"
  }))
}));

const project = {
  id: "project-runtime-canvas",
  title: "Runtime canvas fixture",
  requirement: "Verify the running workflow map",
  status: "running",
  phase: "agent:writing:running",
  currentAgent: "writing",
  turn: 2,
  cycle: 1,
  agentProgress: {},
  overallProgress: { percent: 35, label: "running", estimated: true, successfulCalls: 9 },
  agents: {},
  orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION)
} as unknown as Project;

const events: AgentEvent[] = [
  {
    seq: 1,
    type: "agent.execution.started",
    agent: "idea",
    message: "idea business execution started",
    ts: "2026-09-08T00:00:00.000Z",
    data: { executionId: "exec_idea", executionNumber: 1, invocationId: "inv_idea", sourceAgent: "input" }
  },
  {
    seq: 2,
    type: "agent.started",
    agent: "idea",
    message: "idea started",
    ts: "2026-09-08T00:00:01.000Z",
    data: { invocationId: "inv_idea", sourceAgent: "input", cycle: 1 }
  },
  {
    seq: 3,
    type: "agent.completed",
    agent: "idea",
    message: "idea completed",
    ts: "2026-09-08T00:00:02.000Z",
    data: { invocationId: "inv_idea", cycle: 1 }
  },
  {
    seq: 4,
    type: "agent.execution.started",
    agent: "writing",
    message: "writing business execution started",
    ts: "2026-09-08T00:00:03.000Z",
    data: { executionId: "exec_writing", executionNumber: 1, invocationId: "inv_writing", sourceAgent: "main" }
  },
  {
    seq: 5,
    type: "agent.started",
    agent: "writing",
    message: "writing started",
    ts: "2026-09-08T00:00:03.000Z",
    data: { invocationId: "inv_writing", sourceAgent: "main", cycle: 1 }
  }
];

function collaborationRuntimeProject(): Project {
  return {
    ...project,
    currentAgent: undefined,
    phase: "collaboration:research_group:integrating",
    activeNodeRunId: "node-run-group",
    activeInvocationId: "invocation-final",
    runtime: {
      stateRevision: 12,
      status: "running",
      phase: "model:running",
      currentAgent: "a",
      activeInvocationId: "invocation-final",
      activityStartedAt: "2026-09-22T00:00:00.000Z",
      nodeRunId: "node-run-group",
      groupRunId: "group-run-1",
      taskId: "task-a",
      executionId: "execution-final",
      ownershipEpoch: 3,
      coordinatorEpoch: 2,
      leaseState: "current",
      executionCount: 2,
      primaryActivity: {
        activityId: "activity-final",
        projectId: "project-runtime-canvas",
        kind: "turn",
        phase: "model:running",
        invocationId: "invocation-final",
        agentId: "a",
        nodeRunId: "node-run-group",
        groupRunId: "group-run-1",
        taskId: "task-a",
        executionId: "execution-final",
        ownershipEpoch: 3,
        coordinatorEpoch: 2,
        inputId: "input-final",
        startedAt: "2026-09-22T00:00:00.000Z",
        writerLeaseEpoch: 1,
        leaseState: "current"
      },
      activities: []
    },
    orchestration: {
      schemaVersion: 2,
      agents: [
        { name: "main", template: "main" },
        { name: "a", template: "idea" },
        { name: "b", template: "execution" },
        { name: "c", template: "review" }
      ],
      collaborations: [{
        id: "research_group",
        displayName: "Research group",
        memberAgentIds: ["a", "b"],
        renamePolicy: "editable"
      }],
      input: { source: "input", target: "c" },
      routes: {
        main: [
          { target: "research_group", kind: "weak" },
          { target: "c", kind: "weak" }
        ],
        c: [{ target: "research_group", kind: "strong" }],
        research_group: [{ target: "finish", kind: "weak" }]
      },
      decisionPlans: {},
      allowUserIntervention: true,
      termination: {
        agent: "research_group",
        condition: "Integrated pull request is merged.",
        decisionBy: "main",
        automatic: false
      }
    },
    nodeRuns: [{
      id: "node-run-group",
      node: { kind: "collaboration", nodeId: "research_group", groupId: "research_group" },
      workflowRevision: 7,
      activationRequestId: "activate-group",
      inputSnapshotRef: "messages/group.json",
      sourceAgentId: "c",
      activatedByAgentId: "c",
      status: "integrating"
    }],
    groupRuns: [{
      id: "group-run-1",
      nodeRunId: "node-run-group",
      memberSnapshot: ["a", "b"],
      leaderAgentId: "c",
      coordinatorEpoch: 2,
      baseCommit: "1111111111111111111111111111111111111111",
      groupBranch: "groups/group-run-1",
      integrationTarget: "main",
      integrationOwnerExecutionId: "execution-final",
      finalPullRequestId: "pull-final",
      taskIds: ["task-a", "task-b"],
      status: "integrating"
    }],
    tasks: [
      {
        id: "task-a",
        nodeRunId: "node-run-group",
        groupRunId: "group-run-1",
        assignment: "Collect reproducible evidence.",
        assigneeAgentId: "a",
        dependencyTaskIds: [],
        queueOrdinal: 1,
        currentExecutionId: "execution-a-2",
        status: "succeeded"
      },
      {
        id: "task-b",
        nodeRunId: "node-run-group",
        groupRunId: "group-run-1",
        assignment: "Implement the accepted finding.",
        assigneeAgentId: "b",
        dependencyTaskIds: [],
        queueOrdinal: 2,
        currentExecutionId: "execution-b-1",
        status: "waiting",
        waitReason: "等待 GitHub 授权"
      }
    ],
    executions: [
      {
        id: "execution-a-1",
        nodeRunId: "node-run-group",
        groupRunId: "group-run-1",
        taskId: "task-a",
        agentId: "a",
        purpose: "delivery",
        ownershipEpoch: 1,
        status: "failed",
        executionBranch: "executions/a-1",
        worktreePath: "git-worktrees/a-1",
        successorExecutionId: "execution-a-2",
        failureReason: "provider timeout"
      },
      {
        id: "execution-a-2",
        nodeRunId: "node-run-group",
        groupRunId: "group-run-1",
        taskId: "task-a",
        agentId: "a",
        purpose: "delivery",
        ownershipEpoch: 2,
        status: "succeeded",
        executionBranch: "executions/a-2",
        worktreePath: "git-worktrees/a-2",
        predecessorExecutionId: "execution-a-1"
      },
      {
        id: "execution-b-1",
        nodeRunId: "node-run-group",
        groupRunId: "group-run-1",
        taskId: "task-b",
        agentId: "b",
        purpose: "delivery",
        ownershipEpoch: 1,
        status: "waiting_authorization",
        executionBranch: "executions/b-1",
        worktreePath: "git-worktrees/b-1",
        waitReason: "GitHub authorization"
      },
      {
        id: "execution-final",
        nodeRunId: "node-run-group",
        groupRunId: "group-run-1",
        taskId: "task-a",
        agentId: "a",
        purpose: "final-integration",
        ownershipEpoch: 3,
        status: "pr_open",
        executionBranch: "groups/group-run-1",
        worktreePath: "git-worktrees/final",
        pullRequestId: "pull-final"
      }
    ],
    pullRequests: [{
      id: "pull-final",
      providerNumber: 42,
      htmlUrl: "https://github.example.test/pulls/42",
      head: "groups/group-run-1",
      base: "main",
      headSha: "2222222222222222222222222222222222222222",
      baseSha: "1111111111111111111111111111111111111111",
      ownerExecutionId: "execution-final",
      status: "conflicted",
      mergeable: false,
      diffUrl: "https://github.example.test/pulls/42/files",
      headCommitUrl: "https://github.example.test/commit/2222",
      conflictPaths: ["paper/main.tex"],
      checks: [{
        id: 1,
        name: "reproducibility",
        status: "completed",
        conclusion: "failure",
        observedAt: "2026-09-22T00:00:00.000Z"
      }],
      blockers: ["final check failed"],
      reconciliation: {
        status: "observed",
        operationId: "operation-final",
        message: "remote conflict observed"
      },
      observedAt: "2026-09-22T00:00:00.000Z"
    }],
    git: {
      enabled: true,
      status: "ready",
      provider: "github",
      account: {
        id: "github-account",
        login: "example-user",
        providerUserId: 42
      },
      repository: {
        owner: "example-user",
        name: "runtime-project",
        htmlUrl: "https://github.example.test/example-user/runtime-project",
        private: true,
        defaultBranch: "main",
        localPath: "repository"
      },
      branches: [{
        name: "groups/group-run-1",
        head: "2222222222222222222222222222222222222222",
        base: "main",
        ownerExecutionId: "execution-final",
        worktreePath: "git-worktrees/final",
        status: "retained",
        retained: true
      }],
      commits: [{
        sha: "2222222222222222222222222222222222222222",
        htmlUrl: "https://github.example.test/commit/2222",
        message: "Integrate collaboration results"
      }],
      blockers: ["Git provider reconciliation pending"],
      capacity: {
        retainedWorktreeCount: 9,
        warningThreshold: 8,
        warning: "保留 worktree 数量已达到提醒阈值；系统不会自动删除或清理。"
      },
      observedAt: "2026-09-22T00:00:00.000Z"
    }
  };
}

describe("WorkflowCanvasRuntime fixed preview", () => {
  it("shows one active outer group with durable member rounds and read-only Git/PR facts", () => {
    const groupProject = collaborationRuntimeProject();
    const view = render(<WorkflowCanvasRuntime project={groupProject} events={[]} />);
    const preview = view.container.querySelector('[data-runtime-surface-mode="preview"]')!;
    expect(screen.queryByText("点击查看大型只读画布")).not.toBeInTheDocument();
    expect(view.container.querySelector(".workflow-runtime-preview-hint")).toBeNull();
    expect(preview.querySelector('[data-node-id="research_group"]')).not.toBeNull();
    expect(preview.querySelector('[data-node-id="a"]')).toBeNull();
    expect(preview.querySelector('[data-node-id="b"]')).toBeNull();

    const gitFacts = screen.getByRole("region", { name: "Git 与 Pull Request 只读事实" });
    expect(within(gitFacts).getByRole("link", { name: "example-user/runtime-project" }))
      .toHaveAttribute("href", "https://github.example.test/example-user/runtime-project");
    expect(within(gitFacts).getByRole("link", { name: "查看代码" }))
      .toHaveAttribute("href", "https://github.example.test/example-user/runtime-project/tree/main");
    expect(within(gitFacts).getByRole("button", { name: "Git 提交图" })).toBeEnabled();
    expect(within(gitFacts).getByRole("link", { name: "GitHub Network" }))
      .toHaveAttribute("href", "https://github.example.test/example-user/runtime-project/network");
    expect(within(gitFacts).getByRole("link", { name: "活动" }))
      .toHaveAttribute("href", "https://github.example.test/example-user/runtime-project/activity");
    expect(within(gitFacts).getByRole("link", { name: "查看 PR" }))
      .toHaveAttribute("href", "https://github.example.test/pulls/42");
    expect(within(gitFacts).getByRole("link", { name: "前往 GitHub 删除" }))
      .toHaveAttribute("href", "https://github.example.test/example-user/runtime-project/settings");
    expect(within(gitFacts).getByRole("link", { name: "查看 commit" }))
      .toHaveAttribute("href", "https://github.example.test/commit/2222");
    expect(within(gitFacts).getByRole("link", { name: "查看 diff" }))
      .toHaveAttribute("href", "https://github.example.test/pulls/42/files");
    expect(gitFacts).toHaveTextContent("paper/main.tex");
    expect(gitFacts).toHaveTextContent("reproducibility · failure");
    expect(gitFacts).toHaveTextContent("remote conflict observed");
    expect(gitFacts).toHaveTextContent("可合并性：不可合并");
    expect(gitFacts).toHaveTextContent("观测于 2026-09-22T00:00:00.000Z");
    expect(gitFacts).toHaveTextContent("保留 worktree：9 / 提醒阈值 8");
    expect(gitFacts).toHaveTextContent("保留 worktree 数量已达到提醒阈值；系统不会自动删除或清理。");
    expect(within(gitFacts).getAllByRole("button")).toHaveLength(1);

    fireEvent.click(preview.querySelector('[data-node-id="research_group"]')!);
    const detail = screen.getByLabelText("协作组运行详情");
    expect(detail).toHaveTextContent("协调者c");
    expect(detail).toHaveTextContent("#1");
    expect(detail).toHaveTextContent("#2");
    expect(detail).toHaveTextContent("Collect reproducible evidence.");
    expect(detail).toHaveTextContent("Implement the accepted finding.");
    expect(detail).toHaveTextContent("第 1 轮 · a");
    expect(detail).toHaveTextContent("第 2 轮 · a");
    expect(detail).toHaveTextContent("等待授权");
    expect(detail).toHaveTextContent("provider timeout");
    expect(detail).toHaveTextContent("ownership epoch 1");
    expect(detail).toHaveTextContent("接续自执行：execution-a-1");
    expect(detail).toHaveTextContent("故障后接续：execution-a-2");
    expect(detail).toHaveTextContent("最终集成正在进行");
    expect(within(detail).getAllByRole("link", { name: "PR #42 · conflicted" }).length).toBeGreaterThan(0);
    expect(detail).not.toHaveTextContent("等待 Main 批准");
  });

  it("projects member status from only the current group run", () => {
    const current = collaborationRuntimeProject();
    current.nodeRuns = [{
      ...current.nodeRuns![0]!,
      id: "node-run-old",
      status: "completed"
    }, ...current.nodeRuns!];
    current.groupRuns = [{
      ...current.groupRuns![0]!,
      id: "group-run-old",
      nodeRunId: "node-run-old",
      status: "completed"
    }, ...current.groupRuns!];
    current.executions = [{
      ...current.executions!.find((execution) => execution.agentId === "b")!,
      id: "execution-b-old",
      nodeRunId: "node-run-old",
      groupRunId: "group-run-old",
      status: "failed"
    }, ...current.executions!.filter((execution) => execution.agentId !== "b")];

    expect(runtimeGroupMemberStates(current).research_group).toEqual({
      a: "running",
      b: "waiting"
    });
  });

  it("reconciles a stale running group to paused when C13 has no active execution", () => {
    const paused = collaborationRuntimeProject();
    paused.status = "paused";
    paused.phase = "collaboration:user-paused";
    paused.currentAgent = undefined;
    paused.activeInvocationId = undefined;
    paused.runtime = {
      stateRevision: 13,
      status: "paused",
      phase: "collaboration:user-paused",
      nodeRunId: "node-run-group",
      groupRunId: "group-run-1",
      executionId: "execution-final",
      ownershipEpoch: 3,
      coordinatorEpoch: 2,
      executionCount: 2,
      activities: []
    };

    const view = render(<WorkflowCanvasRuntime project={paused} events={[]} />);
    const previewGroup = view.container.querySelector<HTMLElement>(
      '[data-runtime-surface-mode="preview"] [data-node-id="research_group"]'
    )!;
    expect(previewGroup).toHaveClass("runtime-node-paused");
    expect(previewGroup).not.toHaveClass("runtime-node-running");
    expect(previewGroup).toHaveTextContent("已暂停");

    fireEvent.click(previewGroup);
    const detail = screen.getByLabelText("协作组运行详情");
    expect(detail).toHaveAttribute("data-collaboration-state", "paused");
    expect(detail).toHaveTextContent("协作组已暂停");
    expect(detail).toHaveTextContent("项目已暂停，最终集成不会继续显示为执行中。");
    expect(within(detail).queryByText("最终集成正在进行。")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "执行速览" }));
    const executionPreview = screen.getByRole("region", { name: "执行速览" });
    expect(executionPreview).toHaveTextContent("Research group：协作组已暂停");
    expect(within(executionPreview).queryByText("执行中")).toBeNull();
  });

  it("opens the internal GitTree with Agent attribution, filters, topology and changed files", async () => {
    render(<WorkflowCanvasRuntime project={collaborationRuntimeProject()} events={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Git 提交图" }));
    const dialog = await screen.findByRole("dialog", { name: "提交与分支图" });
    expect(getProjectGitGraph).toHaveBeenCalledWith(
      "project-runtime-canvas",
      { limit: 200, includeTechnical: false },
      expect.any(AbortSignal)
    );
    expect(within(dialog).getByLabelText("协作组")).toHaveTextContent("Research group");
    expect(within(dialog).getByLabelText("PR 状态")).toHaveTextContent("merged");
    expect(within(dialog).getByText("Agent a")).toBeInTheDocument();
    expect(within(dialog).getByText("paper/main.tex")).toBeInTheDocument();
    expect(dialog.querySelectorAll(".git-tree-lanes > g")).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭 Git 提交图" }));
    expect(screen.queryByRole("dialog", { name: "提交与分支图" })).toBeNull();
  });

  it("keeps local GitTree history available when GitHub confirms that the repository was deleted", async () => {
    vi.mocked(getGitHubRepositoryStatus).mockResolvedValueOnce({
      exists: false,
      observedAt: "2026-09-24T00:00:00.000Z"
    });
    render(<WorkflowCanvasRuntime project={collaborationRuntimeProject()} events={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Git 提交图" }));
    const dialog = await screen.findByRole("dialog", { name: "提交与分支图" });
    expect(await within(dialog).findByText(/GitHub 远端仓库已删除/)).toBeInTheDocument();
    expect(within(dialog).getAllByText("[OpenFARS][a] Merge PR #42 into main").length).toBeGreaterThan(0);
    expect(within(dialog).queryByRole("link", { name: "在 GitHub 查看 commit" })).toBeNull();
    expect(within(dialog).queryByRole("link", { name: "查看 PR #42" })).toBeNull();
  });

  it("preserves the visible live canvas expansion preference while keeping the preview compact", () => {
    const view = render(<WorkflowCanvasRuntime project={collaborationRuntimeProject()} events={[]} />);
    const preview = view.container.querySelector<HTMLElement>('[data-runtime-surface-mode="preview"]')!;
    expect(preview.querySelector(".collaboration-expand-button")).toBeNull();
    expect(preview.querySelector(".collaboration-member-list")).toBeNull();
    fireEvent.click(preview.querySelector('[data-node-id="research_group"]')!);
    const frame = screen.getByTitle("运行 Workflow 大画布") as HTMLIFrameElement;
    const send = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    expect(send.mock.lastCall?.[0].snapshot.workflow.nodes.find((node: { id: string }) => node.id === "research_group").expanded).toBe(false);
    fireEvent(window, new MessageEvent("message", { origin: window.location.origin, source: frame.contentWindow,
      data: { type: "scienceevolve.workflow.runtime.toggle-group", nodeId: "research_group" } }));
    expect(send.mock.lastCall?.[0].snapshot.workflow.nodes.find((node: { id: string }) => node.id === "research_group").expanded).toBe(true);
    expect(screen.getByRole("dialog").querySelector(".workflow-runtime-semantic-fallback")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭运行 Workflow 画布" }));
    expect(preview.querySelector(".collaboration-member-list")).toBeNull();
    fireEvent.click(preview.querySelector('[data-node-id="research_group"]')!);
    const reopened = screen.getByTitle("运行 Workflow 大画布") as HTMLIFrameElement;
    const resend = vi.spyOn(reopened.contentWindow!, "postMessage");
    fireEvent.load(reopened);
    expect(resend.mock.lastCall?.[0].snapshot.workflow.nodes.find((node: { id: string }) => node.id === "research_group").expanded).toBe(true);
  });

  it("keeps one live canvas, shared details and controls across nested scopes", () => {
    const scoped = runtimeProjectFixture();
    const research = scoped.orchestration.scopedWorkflow!.groups.find((group) => group.id === "research")!;
    const inner = scoped.orchestration.scopedWorkflow!.groups.find((group) => group.id === "inner")!;
    // References need not share the identity of their Agent or child group.
    const child = research.workflow.nodes.find((node) => node.kind === "collaboration")!;
    child.nodeId = "child-ref";
    const worker = inner.workflow.nodes.find((node) => node.kind === "agent" && node.agentId === "writing")!;
    const previousId = worker.nodeId;
    worker.nodeId = "writer-ref";
    inner.workflow.input.edges.forEach((edge) => { if (edge.target === previousId) edge.target = worker.nodeId; });
    inner.workflow.routes[worker.nodeId] = inner.workflow.routes[previousId] ?? [];
    delete inner.workflow.routes[previousId];
    scoped.scopedArrivals!.forEach((arrival) => { if (arrival.groupRunId === "run-inner" && arrival.targetNodeId === previousId) arrival.targetNodeId = worker.nodeId; });
    scoped.agents.writing.model = "scoped-writer-model";
    const view = render(<WorkflowCanvasRuntime project={scoped} events={[]} />);
    fireEvent.click(screen.getByLabelText("运行 Workflow 缩略画布，点击打开大画布"));
    const frame = screen.getByTitle("运行 Workflow 大画布") as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    const send = (action: string, nodeId: string, scopeId?: string, groupId?: string) => fireEvent(window,
      new MessageEvent("message", { origin: window.location.origin, source: frame.contentWindow,
        data: { type: `scienceevolve.workflow.runtime.${action}`, nodeId, scopeId, groupId } }));
    const snapshot = () => post.mock.calls.at(-1)![0].snapshot;
    send("select", "research");
    expect(screen.getByLabelText("协作组运行详情")).toHaveTextContent("Research");
    fireEvent.click(screen.getByRole("button", { name: "查看子 Agent" }));
    expect(snapshot().workflow.nodes.find((node: { id: string }) => node.id === "research").expanded).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "进入组内运行 Workflow" }));
    expect(screen.getByTitle("运行 Workflow 大画布")).toBe(frame);
    expect(snapshot().scopeId).toBe("research");
    expect(screen.getByLabelText("Research 组内运行 Workflow")).toBeInTheDocument();
    send("select", "child-ref", "research");
    const childDetail = screen.getByLabelText("协作组运行详情");
    expect(childDetail).toHaveTextContent("Inner");
    fireEvent.click(within(childDetail).getByRole("button", { name: "查看子 Agent" }));
    expect(snapshot().workflow.nodes.find((node: { id: string }) => node.id === "child-ref").expanded).toBe(true);
    send("navigate-group", "child-ref", "research", "inner");
    expect(screen.getByTitle("运行 Workflow 大画布")).toBe(frame);
    expect(screen.getByLabelText("Inner 组内运行 Workflow")).toBeInTheDocument();
    expect(screen.queryByLabelText("协作组运行详情")).toBeNull();
    send("select", "writer-ref", "research"); // A delayed action from the old scope.
    expect(screen.queryByLabelText("运行节点详情")).toBeNull();
    send("select", "writer-ref", "inner");
    const detail = screen.getByLabelText("运行节点详情");
    expect(detail).toHaveTextContent("累计执行 1 次");
    expect(detail).toHaveTextContent("运行中");
    expect(detail).toHaveTextContent("scoped-writer-model");
    expect(detail.querySelector("[data-runtime-config-snapshot]")).toBeInTheDocument();
    expect(snapshot().nodeStates["writer-ref"]).toBe("running");
    fireEvent.click(screen.getByRole("button", { name: "执行速览" }));
    fireEvent.click(screen.getByRole("button", { name: "返回 Workflow" }));
    expect(screen.getByTitle("运行 Workflow 大画布")).toBe(frame);
    expect(screen.getByLabelText("运行节点详情")).toHaveTextContent("scoped-writer-model");
    fireEvent.click(screen.getByRole("button", { name: "返回父图" }));
    expect(screen.getByLabelText("协作组运行详情")).toHaveTextContent("Inner");
    fireEvent.click(screen.getByRole("button", { name: "项目" }));
    expect(screen.getByTitle("运行 Workflow 大画布")).toBe(frame);
    expect(screen.getByLabelText("协作组运行详情")).toHaveTextContent("Research");
    send("navigate-group", "research", undefined, "inner");
    expect(screen.getByLabelText("运行节点详情")).toHaveTextContent("scoped-writer-model");
    // Main removes the selected node, then dissolves the currently open group.
    const updated = structuredClone(scoped);
    const updatedInner = updated.orchestration.scopedWorkflow!.groups.find((group) => group.id === "inner")!;
    updatedInner.workflow.nodes = updatedInner.workflow.nodes.filter((node) => node.nodeId !== "writer-ref");
    view.rerender(<WorkflowCanvasRuntime project={updated} events={[]} />);
    expect(screen.queryByLabelText("运行节点详情")).toBeNull();
    expect(snapshot().workflow.nodes.some((node: { id: string }) => node.id === "writer-ref")).toBe(false);
    const dissolved = structuredClone(updated);
    dissolved.orchestration.scopedWorkflow!.groups = [];
    dissolved.orchestration.collaborations = [];
    view.rerender(<WorkflowCanvasRuntime project={dissolved} events={[]} />);
    expect(screen.queryByLabelText("运行 Workflow 范围路径")).toBeNull();
    expect(snapshot().scopeId).toBeNull();
    expect(screen.getByTitle("运行 Workflow 大画布")).toBe(frame);
  });

  it("shows model summaries by default, retains capped original output, and updates live", async () => {
    const outputEvents = [...events, {
      seq: 6, type: "handoff.saved", agent: "idea", message: "", ts: events[0].ts,
      data: { invocationId: "inv_idea", excerpt: "原".repeat(1000) + "隐藏尾部" }
    }];
    const view = render(<WorkflowCanvasRuntime project={project} events={outputEvents} />);
    fireEvent.click(screen.getByLabelText("运行 Workflow 缩略画布，点击打开大画布"));
    fireEvent.click(screen.getByRole("button", { name: "执行速览" }));
    const preview = screen.getByRole("region", { name: "执行速览" });
    expect(within(preview).getByText(project.requirement)).toBeInTheDocument();
    expect(within(preview).queryByText("原".repeat(1000))).toBeNull();
    expect(await within(preview).findByText("已完成实验，等待复核。")).toBeInTheDocument();
    fireEvent.click(within(preview).getByRole("button", { name: "查看原文" }));
    expect(within(preview).getByText("原".repeat(1000))).toBeInTheDocument();
    expect(preview).not.toHaveTextContent("隐藏尾部");
    expect(within(preview).getByText("当前：writing Agent")).toBeInTheDocument();
    fireEvent.click(within(preview).getByRole("button", { name: "展开原文" }));
    expect(within(preview).getByRole("button", { name: "收起" })).toHaveAttribute("aria-expanded", "true");
    view.rerender(<WorkflowCanvasRuntime project={{ ...project, status: "completed", currentAgent: undefined }} events={[
      ...outputEvents,
      { seq: 7, type: "agent.completed", agent: "writing", message: "", ts: events[0].ts, data: { invocationId: "inv_writing" } }
    ]} />);
    expect(within(preview).queryByText("执行中")).toBeNull();
    expect(within(preview).getByText("流程已完成")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回 Workflow" }));
    expect(screen.getByLabelText("运行 Workflow 大画布")).toBeInTheDocument();
  });

  it("keeps original output available when summarization fails and supports explicit retry", async () => {
    vi.mocked(ensureExecutionSummary).mockResolvedValueOnce({ invocationId: "inv_idea", status: "failed", error: "请配置解说 Agent" });
    render(<WorkflowCanvasRuntime project={project} events={[...events, {
      seq: 6, type: "handoff.saved", agent: "idea", message: "", ts: events[0].ts,
      data: { invocationId: "inv_idea", excerpt: "独立原始输出" }
    }]} />);
    fireEvent.click(screen.getByLabelText("运行 Workflow 缩略画布，点击打开大画布"));
    fireEvent.click(screen.getByRole("button", { name: "执行速览" }));
    expect(await screen.findByText("摘要生成失败：请配置解说 Agent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看原文" }));
    expect(screen.getByText("独立原始输出")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试摘要" }));
    expect(await screen.findByText("已完成实验，等待复核。")).toBeInTheDocument();
    expect(ensureExecutionSummary).toHaveBeenLastCalledWith(project.id, "inv_idea", true, expect.any(AbortSignal));
  });

  it("updates queued and running summaries without waiting for the workflow to finish", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(ensureExecutionSummary)
        .mockResolvedValueOnce({ invocationId: "inv_idea", status: "queued" })
        .mockResolvedValueOnce({ invocationId: "inv_idea", status: "running" });
      const view = render(<WorkflowCanvasRuntime project={project} events={[...events, {
        seq: 6, type: "handoff.saved", agent: "idea", message: "", ts: events[0].ts,
        data: { invocationId: "inv_idea", excerpt: "原始结果" }
      }]} />);
      fireEvent.click(screen.getByLabelText("运行 Workflow 缩略画布，点击打开大画布"));
      fireEvent.click(screen.getByRole("button", { name: "执行速览" }));
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByText("摘要等待生成…")).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(screen.getByText("项目解说模型正在生成摘要，较慢网关可能需要几分钟…")).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(screen.getByText("已完成实验，等待复核。")).toBeInTheDocument();
      view.unmount();
      const count = vi.mocked(ensureExecutionSummary).mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(ensureExecutionSummary).toHaveBeenCalledTimes(count);
    } finally { vi.useRealTimers(); }
  });

  it("renders Loop return and virtual-exit states with batch counters", () => {
    const loopProject = structuredClone(project);
    loopProject.orchestration.routes.idea = [{ target: "execution", kind: "strong" }];
    loopProject.orchestration.routes.execution = [{ target: "idea", kind: "strong" }];
    loopProject.orchestration.loops = [{
      id: "drafting",
      from: "execution",
      to: "idea",
      maxIterations: 3,
      exitTo: "writing"
    }];
    loopProject.loopIterations = { drafting: 3 };
    loopProject.loopBatches = { drafting: 2 };
    loopProject.loopTotalIterations = { drafting: 6 };
    const loopEvents: AgentEvent[] = [{
      seq: 20,
      type: "workflow.loop.exhausted",
      agent: "execution",
      message: "Loop drafting completed its batch",
      ts: "2026-09-08T00:00:20.000Z",
      data: {
        loopId: "drafting",
        batch: 2,
        iterations: 3,
        totalIterations: 6,
        maxIterations: 3
      }
    }];

    const view = render(<WorkflowCanvasRuntime project={loopProject} events={loopEvents} />);
    screen.getByLabelText("运行 Workflow 缩略画布，点击打开大画布");
    expect(screen.getByLabelText("Loop 运行计数")).toHaveTextContent(
      "drafting batch 2 · iteration 3/3 · total 6"
    );
    const returnEdge = view.container.querySelector('[data-loop-id="drafting"][data-loop-role="return"]');
    const exitEdge = view.container.querySelector('[data-loop-id="drafting"][data-loop-role="exit"]');
    expect(returnEdge).not.toBeNull();
    expect(exitEdge).not.toBeNull();
    expect(returnEdge).toHaveClass("runtime-edge-traversed");
    expect(exitEdge).toHaveClass("runtime-edge-active");
    expect(returnEdge).toHaveTextContent("↻ drafting · B2 · 3/3 · Σ6");
  });

  it("uses an internal horizontal frame for a readable narrow modal", () => {
    const plan = planRuntimeCanvasViewport("modal", { width: 350, height: 668 }, {
      minX: 20,
      minY: 70,
      maxX: 929,
      maxY: 712
    });
    expect(plan.scrollable).toBe(true);
    expect(plan.frameWidth).toBeGreaterThan(350);
    expect(plan.frameHeight).toBeGreaterThanOrEqual(668);
    expect(plan.viewport.zoom).toBeCloseTo(0.62);

    const desktop = planRuntimeCanvasViewport("modal", { width: 900, height: 600 }, {
      minX: 20,
      minY: 70,
      maxX: 929,
      maxY: 712
    });
    expect(desktop.scrollable).toBe(false);
    expect(desktop.frameWidth).toBe(900);
  });

  it("keeps the preview fixed and opens the live demo canvas in the runtime dialog", () => {
    const view = render(<WorkflowCanvasRuntime project={project} events={events} />);
    const preview = screen.getByLabelText("运行 Workflow 缩略画布，点击打开大画布");
    const world = preview.querySelector<HTMLElement>(".workflow-canvas-world")!;
    const before = world.style.transform;

    fireEvent.wheel(preview, { deltaY: -120, clientX: 120, clientY: 90 });
    fireEvent.pointerDown(preview, { pointerId: 7, button: 0, clientX: 90, clientY: 80 });
    fireEvent.pointerMove(preview, { pointerId: 7, clientX: 180, clientY: 150 });
    fireEvent.pointerUp(preview, { pointerId: 7, clientX: 180, clientY: 150 });
    expect(world.style.transform).toBe(before);
    expect(view.container.querySelector(".workflow-runtime-fit")).toBeNull();

    fireEvent.click(preview);
    const dialog = screen.getByRole("dialog", { name: "运行 Workflow 画布" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.querySelector(".left-panel")).toBeNull();
    expect(dialog.querySelector(".right-panel")).toBeNull();
    expect(dialog.querySelector(".canvas-toolbar")).toBeNull();
    expect(dialog.querySelector(".node-port")).toBeNull();
    expect(dialog.querySelector(".edge-hit")).toBeNull();

    const modalCanvas = within(dialog).getByLabelText("运行 Workflow 大画布");
    expect(modalCanvas.tagName).toBe("IFRAME");
    expect(modalCanvas).toHaveAttribute("src", expect.stringContaining("workflow-canvas-demo/index.html?runtime=1&project=project-runtime-canvas"));

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭运行 Workflow 画布" }));
    expect(screen.queryByRole("dialog", { name: "运行 Workflow 画布" })).toBeNull();
  });

  it("opens from a node, shows lightweight status, and closes with Escape", () => {
    const view = render(<WorkflowCanvasRuntime project={project} events={events} />);
    const writingNode = view.container.querySelector<HTMLElement>('[data-runtime-surface-mode="preview"] [data-node-id="writing"]')!;
    expect(writingNode).toHaveAttribute("tabindex", "0");
    writingNode.focus();
    fireEvent.keyDown(writingNode, { key: "Enter" });
    const dialog = screen.getByRole("dialog", { name: "运行 Workflow 画布" });
    expect(within(dialog).getByLabelText("运行节点详情")).toHaveTextContent("运行中");
    expect(within(dialog).getByLabelText("运行节点详情")).toHaveTextContent("累计执行 1 次");
    expect(within(dialog).getByLabelText("运行节点详情")).toHaveTextContent("inv_writing");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "运行 Workflow 画布" })).toBeNull();
  });

  it("shows append-only failures, retries, and the final successful attempt", () => {
    const failureProject: Project = {
      ...project,
      failureAttempts: [{
        attemptId: "attempt-init-1",
        projectId: project.id,
        scope: "git",
        operation: "initialization",
        status: "failed",
        errorCode: "GITHUB_PROVIDER_FAILED",
        retryable: true,
        redactedMessage: "provider rejected [REDACTED]",
        causeClass: "GitHubProviderError",
        agentId: "main",
        invocationId: "invocation-init-1",
        ownershipEpoch: 1,
        startedAt: "2026-09-24T10:01:00.000Z",
        finishedAt: "2026-09-24T10:02:00.000Z",
        metadata: {}
      }, {
        attemptId: "attempt-init-2",
        projectId: project.id,
        scope: "git",
        operation: "initialization",
        status: "succeeded",
        errorCode: null,
        retryable: false,
        redactedMessage: "Git initialization succeeded",
        causeClass: "None",
        startedAt: "2026-09-24T10:02:30.000Z",
        finishedAt: "2026-09-24T10:03:00.000Z",
        metadata: {}
      }],
      failureSummary: {
        currentStatus: "healthy",
        totalAttempts: 2,
        failedAttempts: 1,
        succeededAttempts: 1,
        unresolvedFailures: 0,
        operations: []
      }
    };
    render(<WorkflowCanvasRuntime project={failureProject} events={[]} />);

    const history = screen.getByLabelText("失败与重试历史");
    expect(within(history).getByText("当前已恢复")).toBeInTheDocument();
    const attempts = within(history).getAllByRole("listitem");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toHaveTextContent("Git 尝试失败");
    expect(attempts[0]).toHaveTextContent("第 1 次尝试");
    expect(attempts[0]).toHaveTextContent("provider rejected [REDACTED]");
    expect(attempts[0]).toHaveTextContent("GITHUB_PROVIDER_FAILED");
    expect(attempts[0]).toHaveTextContent("invocation-init-1");
    expect(attempts[1]).toHaveTextContent("Git 重试成功");
    expect(attempts[1]).toHaveTextContent("第 2 次尝试");
    expect(attempts[1]).toHaveTextContent("Git initialization succeeded");
  });

  it("shows the credential-free project configuration snapshot as locked runtime metadata", () => {
    const lockedProject: Project = {
      ...project,
      configurationLocked: true,
      agents: {
        ...DEFAULT_AGENTS,
        main: {
          ...DEFAULT_AGENTS.main,
          harness: "claude-code",
          model: "nex-agi/Nex-N2-Pro",
          gatewayId: "gwy_0123456789abcdef0123456789abcdef",
          gatewaySnapshot: {
            id: "gwy_0123456789abcdef0123456789abcdef",
            name: "验收 Anthropic 网关",
            url: "https://gateway.example.test/v1",
            models: ["nex-agi/Nex-N2-Pro"],
            defaultModel: "nex-agi/Nex-N2-Pro",
            protocol: "anthropic-messages",
            testedAt: "2026-09-12T00:00:00.000Z"
          }
        }
      }
    };
    const view = render(<WorkflowCanvasRuntime
      project={lockedProject}
      events={events}
      harnesses={[{ id: "claude-code", label: "Claude Code" }]}
    />);

    fireEvent.click(view.container.querySelector('[data-runtime-surface-mode="preview"] [data-node-id="main"]')!);
    const dialog = screen.getByRole("dialog", { name: "运行 Workflow 画布" });
    const detail = within(dialog).getByLabelText("运行节点详情");
    expect(detail).toHaveTextContent("Claude Code");
    expect(detail).toHaveTextContent("验收 Anthropic 网关");
    expect(detail).toHaveTextContent("nex-agi/Nex-N2-Pro");
    expect(detail).toHaveTextContent("Anthropic Messages");
    expect(detail).toHaveTextContent("Harness 协议未记录");
    expect(detail).not.toHaveTextContent("直连");
    expect(detail).toHaveTextContent("项目创建后已锁定配置");
    expect(detail).not.toHaveTextContent(/api.?key/i);
  });
});
