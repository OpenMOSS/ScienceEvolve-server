import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_ORCHESTRATION } from "../../lib";
import type { Project } from "../../types";
import { addScopedGroup, upgradeLegacyGroups } from "./core/scoped-workflow";
import { ScopedPullRequestTree } from "./ScopedPullRequestTree";

function fixture(): Project {
  const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
  upgradeLegacyGroups(orchestration);
  addScopedGroup(orchestration, { id: "research", displayName: "Research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"] });
  addScopedGroup(orchestration, { id: "inner", displayName: "Inner", parentGroupId: "research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"] });
  return { id: "prj-scoped", orchestration, groupRuns: [], nodeRuns: [], executions: [], pullRequests: [] } as unknown as Project;
}

function integratingFixture(nested = false): Project {
  const project = fixture();
  const groupRunId = nested ? "child-run" : "parent-run";
  project.scopedGroupRuns = [{
    id: "parent-run", projectId: project.id, groupId: "research", activationRequestId: "activate-parent",
    workflowRevision: 2, leaderAgentId: "main", baseCommit: "abc", groupBranch: "groups/parent-run",
    integrationTarget: "main", status: nested ? "running" : "integrating"
  }, ...(nested ? [{
    id: groupRunId, projectId: project.id, groupId: "inner", parentGroupRunId: "parent-run",
    parentArrivalRequestId: "child-arrival", activationRequestId: "activate-child", workflowRevision: 2,
    leaderAgentId: "main", baseCommit: "def", groupBranch: `groups/${groupRunId}`,
    integrationTarget: "groups/parent-run", status: "integrating"
  }] : [])];
  const owner = {
    id: `group-final-${groupRunId}`, projectId: project.id, groupRunId, ownershipEpoch: 1,
    executionBranch: `groups/${groupRunId}`, integrationTarget: nested ? "groups/parent-run" : "main",
    expectedHeadSha: "a".repeat(40), status: "integrating" as const
  };
  project.scopedFinalIntegrations = [owner];
  project.scopedPullRequests = [{
    id: "final-pr", providerNumber: 8, htmlUrl: "https://example.test/pr/8", status: "open",
    ownerExecutionId: owner.id, head: owner.executionBranch, base: owner.integrationTarget,
    headSha: owner.expectedHeadSha, observedAt: "2026-09-30T00:00:00.000Z"
  }];
  return project;
}

describe("ScopedPullRequestTree", () => {
  it("does not fabricate branch or PR facts from configured scopes", () => {
    render(<ScopedPullRequestTree project={fixture()} />);
    expect(screen.getByText(/尚无组运行、分支或 PR 的权威事实/)).toBeInTheDocument();
    expect(screen.queryByText("Research")).not.toBeInTheDocument();
  });

  it("shows a provider-confirmed open member PR without treating it as a completed group merge", () => {
    const project = fixture();
    project.scopedGroupRuns = [{
      id: "parent-run", projectId: project.id, groupId: "research", activationRequestId: "activate-parent",
      workflowRevision: 2, leaderAgentId: "main", baseCommit: "abc", groupBranch: "groups/parent-run",
      integrationTarget: "main", status: "running"
    }];
    project.scopedExecutions = [{
      id: "exec-worker", projectId: project.id, groupRunId: "parent-run", arrivalRequestId: "arrival-worker",
      agentId: "idea", ownershipEpoch: 1, executionBranch: "executions/exec-worker",
      worktreePath: "/srv/worktrees/idea", status: "running"
    }];
    project.scopedPullRequests = [{
      id: "worker-pr", providerNumber: 5, status: "open", head: "executions/exec-worker",
      base: "groups/parent-run", ownerExecutionId: "exec-worker",
      htmlUrl: "https://example.test/pr/5", observedAt: "2026-09-29T00:00:00.000Z"
    }];
    render(<ScopedPullRequestTree project={project} />);
    const tree = screen.getByLabelText("分层 Git 与 PR 树");
    expect(within(tree).getByRole("link", { name: "PR #5" })).toHaveAttribute("href", "https://example.test/pr/5");
    expect(within(tree).getByText("open")).toBeInTheDocument();
    expect(within(tree).getByText("尚无权威 PR 事实")).toBeInTheDocument();
    expect(within(tree).queryByText(/本地目标分支已同步/)).not.toBeInTheDocument();
  });

  it.each(["open", "conflicted", "merged"] as const)("shows a %s runtime final PR without inventing a Worker or sync proof", (status) => {
    const project = integratingFixture();
    project.scopedPullRequests![0]!.status = status;
    render(<ScopedPullRequestTree project={project} />);
    expect(screen.getByRole("link", { name: "PR #8" })).toBeInTheDocument();
    expect(screen.getByText(status)).toBeInTheDocument();
    expect(screen.getByText("groups/parent-run → main")).toBeInTheDocument();
    expect(screen.queryByText(/Agent /)).not.toBeInTheDocument();
    expect(screen.queryByText(/本地目标分支已同步/)).not.toBeInTheDocument();
    if (status === "merged") expect(screen.getByText("PR 已合并，等待确认本地目标分支同步")).toBeInTheDocument();
    else expect(screen.queryByText(/等待确认本地目标分支同步/)).not.toBeInTheDocument();
  });

  it("keeps an in-progress child final PR under its direct parent", () => {
    render(<ScopedPullRequestTree project={integratingFixture(true)} />);
    const child = screen.getByText("Inner").closest("li")!;
    expect(within(child).getByRole("link", { name: "PR #8" })).toBeInTheDocument();
    expect(within(child).getByText("groups/child-run → groups/parent-run")).toBeInTheDocument();
    expect(within(child).queryByText("最终 PR → main")).not.toBeInTheDocument();
    expect(child.parentElement?.closest("li")).toContainElement(child);
  });

  it.each(["missing-owner", "wrong-project", "wrong-head", "wrong-base", "wrong-sha", "wrong-owner"])(
    "does not publish a final PR with %s", (invalid) => {
      const project = integratingFixture();
      const owner = project.scopedFinalIntegrations![0]!;
      const pull = project.scopedPullRequests![0]!;
      if (invalid === "missing-owner") project.scopedFinalIntegrations = [];
      if (invalid === "wrong-project") owner.projectId = "another-project";
      if (invalid === "wrong-head") pull.head = "groups/other";
      if (invalid === "wrong-base") pull.base = "groups/other";
      if (invalid === "wrong-sha") pull.headSha = "b".repeat(40);
      if (invalid === "wrong-owner") pull.ownerExecutionId = "another-owner";
      render(<ScopedPullRequestTree project={project} />);
      expect(screen.queryByRole("link", { name: "PR #8" })).not.toBeInTheDocument();
      expect(screen.getByText("尚无权威 PR 事实")).toBeInTheDocument();
      expect(screen.queryByText(/本地目标分支已同步/)).not.toBeInTheDocument();
    }
  );

  it("shows preparing without claiming a PR when the runtime owner has no provider receipt", () => {
    const project = integratingFixture();
    project.scopedPullRequests = [];
    render(<ScopedPullRequestTree project={project} />);
    expect(screen.getByText("正在准备最终 PR")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows durable final issues and never calls a cancelled retained owner an active publisher", () => {
    const project = integratingFixture(); project.scopedPullRequests = [];
    project.scopedGroupIssues = [{ id: "issue-final", groupRunId: "parent-run", kind: "final", sequence: 1,
      arrivalRequestId: "final-parent", reason: "Direct parent conflict awaits the original Leader" }];
    const view = render(<ScopedPullRequestTree project={project} />);
    expect(screen.getByText(/等待组内协调（最终交付）/)).toHaveTextContent("Direct parent conflict");
    expect(screen.queryByText("正在准备最终 PR")).not.toBeInTheDocument();
    project.scopedGroupIssues = []; project.scopedGroupRuns![0].status = "cancelled";
    view.rerender(<ScopedPullRequestTree project={project} />);
    expect(screen.getByText(/组已取消；保留分支及历史 PR 事实/)).toBeInTheDocument();
    expect(screen.queryByText("正在准备最终 PR")).not.toBeInTheDocument();
  });

  it("prefers the completed merge and synchronization proof over an earlier open receipt", () => {
    const project = integratingFixture();
    const pull = project.scopedPullRequests![0]!;
    project.scopedGroupFinalMerges = [{
      groupRunId: "parent-run", pullRequest: { ...pull, status: "merged", mergeCommitSha: "b".repeat(40) },
      synchronization: {
        projectId: project.id, operationId: "sync-parent", targetBranch: "main", temporaryRef: "refs/tmp/parent",
        expectedSourceHead: "a".repeat(40), mergeCommitSha: "b".repeat(40), remoteHead: "b".repeat(40),
        localHeadBefore: "a".repeat(40), localHeadAfter: "b".repeat(40), status: "synchronized",
        observedAt: "2026-09-30T00:00:00.000Z"
      }, recordedAt: "2026-09-30T00:00:00.000Z"
    }];
    render(<ScopedPullRequestTree project={project} />);
    expect(screen.getByText("merged")).toBeInTheDocument();
    expect(screen.queryByText("open")).not.toBeInTheDocument();
    expect(screen.getByText(/本地目标分支已同步至 b+/)).toBeInTheDocument();
    expect(screen.queryByText(/等待确认本地目标分支同步/)).not.toBeInTheDocument();
  });

  it("nests child group delivery under its parent and shows final PR direction", () => {
    const project = fixture();
    project.scopedGroupRuns = [
      { id: "parent-run", projectId: project.id, groupId: "research", activationRequestId: "activate-parent", workflowRevision: 2, leaderAgentId: "main", baseCommit: "abc", groupBranch: "groups/parent-run", integrationTarget: "main", status: "running" },
      { id: "child-run", projectId: project.id, groupId: "inner", parentGroupRunId: "parent-run", parentArrivalRequestId: "child-arrival", activationRequestId: "activate-child", workflowRevision: 2, leaderAgentId: "main", baseCommit: "def", groupBranch: "groups/child-run", integrationTarget: "groups/parent-run", status: "completed" }
    ];
    project.scopedExecutions = [{
      id: "exec-child", projectId: project.id, groupRunId: "child-run", arrivalRequestId: "arrival-child-worker",
      agentId: "idea", ownershipEpoch: 1, executionBranch: "executions/exec-child",
      worktreePath: "/srv/worktrees/idea", status: "completed"
    }];
    const synchronization = {
      projectId: project.id, operationId: "sync-child", targetBranch: "groups/parent-run",
      temporaryRef: "refs/tmp/child", expectedSourceHead: "a".repeat(40), mergeCommitSha: "b".repeat(40),
      remoteHead: "b".repeat(40), localHeadBefore: "a".repeat(40), localHeadAfter: "b".repeat(40),
      status: "synchronized" as const, observedAt: "2026-09-29T00:00:00.000Z"
    };
    project.scopedAgentMerges = [{
      arrivalRequestId: "arrival-child-worker", executionId: "exec-child", groupRunId: "child-run",
      pullRequest: { id: "worker-pr", providerNumber: 6, status: "merged", head: "executions/exec-child", base: "groups/child-run", ownerExecutionId: "exec-child", htmlUrl: "https://example.test/pr/6", observedAt: synchronization.observedAt },
      synchronization: { ...synchronization, targetBranch: "groups/child-run" }, recordedAt: synchronization.observedAt
    }];
    project.scopedGroupFinalMerges = [{
      groupRunId: "child-run",
      pullRequest: { id: "child-pr", providerNumber: 7, status: "merged", head: "groups/child-run", base: "groups/parent-run", headSha: "a".repeat(40), mergeCommitSha: "b".repeat(40), htmlUrl: "https://example.test/pr/7", observedAt: synchronization.observedAt },
      synchronization, recordedAt: synchronization.observedAt
    }];
    render(<ScopedPullRequestTree project={project} />);
    const tree = screen.getByLabelText("分层 Git 与 PR 树");
    expect(within(tree).getByText("Research")).toBeInTheDocument();
    expect(within(tree).getByText("Inner")).toBeInTheDocument();
    expect(within(tree).getByRole("link", { name: "PR #6" })).toHaveAttribute("href", "https://example.test/pr/6");
    expect(within(tree).getByRole("link", { name: "PR #7" })).toHaveAttribute("href", "https://example.test/pr/7");
    expect(within(tree).getByText("最终 PR → groups/parent-run")).toBeInTheDocument();
  });
});
