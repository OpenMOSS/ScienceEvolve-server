import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readProjectGitGraph } from "../src/git-graph.js";
import type { ProjectState } from "../src/types.js";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  await exec("git", args, { cwd, env: { ...process.env, ...env } });
}

describe("Git graph reader", () => {
  it("returns parents, refs, Agent trailers and hides management commits by default", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-git-graph-"));
    roots.push(root);
    await git(root, ["init", "-b", "main"]);
    await fs.writeFile(path.join(root, "README.md"), "root\n");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "-m", "Initialize"], { GIT_AUTHOR_NAME: "OpenFARS Git Service", GIT_AUTHOR_EMAIL: "openfars@localhost", GIT_COMMITTER_NAME: "OpenFARS Git Service", GIT_COMMITTER_EMAIL: "openfars@localhost" });
    await git(root, ["checkout", "-b", "executions/execution-1"]);
    await fs.writeFile(path.join(root, "agent.md"), "agent\n");
    await git(root, ["add", "agent.md"]);
    await git(root, ["commit", "-m", "[alpha] 完成任务", "-m", "OpenFARS-Agent: alpha\nOpenFARS-Execution: execution-1\nOpenFARS-Reason: 完成验证"] , { GIT_AUTHOR_NAME: "OpenFARS Agent alpha", GIT_AUTHOR_EMAIL: "alpha@localhost", GIT_COMMITTER_NAME: "OpenFARS Git Service", GIT_COMMITTER_EMAIL: "openfars@localhost" });
    await git(root, ["checkout", "main"]);
    await git(root, ["merge", "--no-ff", "executions/execution-1", "-m", "Merge Agent alpha"], { GIT_AUTHOR_NAME: "GitHub User", GIT_AUTHOR_EMAIL: "user@example.test", GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@example.test" });
    await git(root, ["checkout", "-b", "management/memory"]);
    await fs.writeFile(path.join(root, "memory.md"), "memory\n");
    await git(root, ["add", "memory.md"]);
    await git(root, ["commit", "-m", "Update management memory for main"], { GIT_AUTHOR_NAME: "OpenFARS Git Service", GIT_AUTHOR_EMAIL: "openfars@localhost", GIT_COMMITTER_NAME: "OpenFARS Git Service", GIT_COMMITTER_EMAIL: "openfars@localhost" });

    const project = {
      id: "prj_graph",
      updatedAt: "2026-09-24T00:00:00.000Z",
      git: { enabled: true, status: "ready", account: { id: "account", login: "alice", providerUserId: 1 }, repository: { owner: "alice", name: "repo", htmlUrl: "https://github.com/alice/repo", private: true, defaultBranch: "main", localPath: root } },
      pullRequests: [],
      executions: []
    } as unknown as ProjectState;
    const ordinary = await readProjectGitGraph(project, { limit: 20 });
    expect(ordinary.commits.some((commit) => commit.subject.startsWith("Update management memory"))).toBe(false);
    const agent = ordinary.commits.find((commit) => commit.agentId === "alpha");
    expect(agent).toMatchObject({ executionId: "execution-1", parents: expect.any(Array) });
    expect(agent?.trailers["OpenFARS-Reason"]).toBe("完成验证");
    expect(agent?.changedFiles).toContainEqual({ status: "A", path: "agent.md" });
    expect(ordinary.commits.find((commit) => commit.parents.length === 2)?.authorName).toBe("GitHub User");
    const technical = await readProjectGitGraph(project, { limit: 20, includeTechnical: true });
    expect(technical.commits.some((commit) => commit.system)).toBe(true);
  });

  it("projects every empty topology reason without inventing commits or branches", async () => {
    const disabled = await readProjectGitGraph({
      id: "prj_disabled",
      updatedAt: "2026-09-24T00:00:00.000Z",
      git: { enabled: false, status: "disabled" }
    } as unknown as ProjectState, { limit: 20 });
    expect(disabled).toMatchObject({
      commits: [],
      refs: [],
      emptyReason: "git_disabled"
    });

    const uninitialized = await readProjectGitGraph({
      id: "prj_uninitialized",
      updatedAt: "2026-09-24T00:00:00.000Z",
      git: { enabled: true, status: "ready" }
    } as unknown as ProjectState, { limit: 20 });
    expect(uninitialized.emptyReason).toBe("repository_uninitialized");

    const initializing = await readProjectGitGraph({
      id: "prj_initializing",
      updatedAt: "2026-09-24T00:00:00.000Z",
      git: { enabled: true, status: "pushing_main" }
    } as unknown as ProjectState, { limit: 20 });
    expect(initializing.emptyReason).toBe("repository_initializing");

    const failed = await readProjectGitGraph({
      id: "prj_failed",
      updatedAt: "2026-09-24T00:00:00.000Z",
      git: { enabled: true, status: "failed" }
    } as unknown as ProjectState, { limit: 20 });
    expect(failed.emptyReason).toBe("repository_failed");

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-git-graph-empty-"));
    roots.push(root);
    await git(root, ["init", "-b", "main"]);
    await fs.writeFile(path.join(root, "README.md"), "root\n");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "-m", "Initialize"], {
      GIT_AUTHOR_NAME: "OpenFARS Git Service",
      GIT_AUTHOR_EMAIL: "openfars@localhost",
      GIT_COMMITTER_NAME: "OpenFARS Git Service",
      GIT_COMMITTER_EMAIL: "openfars@localhost"
    });
    const repository = {
      owner: "alice",
      name: "repo",
      htmlUrl: "https://github.com/alice/repo",
      private: true,
      defaultBranch: "main",
      localPath: root
    };
    const beforeAssignment = await readProjectGitGraph({
      id: "prj_before_assignment",
      updatedAt: "2026-09-24T00:00:00.000Z",
      git: { enabled: true, status: "ready", repository },
      pullRequests: [],
      tasks: [],
      executions: []
    } as unknown as ProjectState, { limit: 20 });
    expect(beforeAssignment.emptyReason).toBe("before_first_assignment");

    await git(root, ["branch", "executions/execution-1"]);
    const assignedProject = {
      id: "prj_assigned",
      updatedAt: "2026-09-24T00:00:00.000Z",
      git: {
        enabled: true,
        status: "ready",
        repository,
        branches: [{
          name: "executions/execution-1",
          ownerExecutionId: "execution-1",
          status: "active"
        }]
      },
      pullRequests: [],
      tasks: [],
      executions: [{ id: "execution-1", agentId: "alpha", taskId: "task-1" }]
    } as unknown as ProjectState;
    const branchWithoutCommits = await readProjectGitGraph(assignedProject, { limit: 20 });
    expect(branchWithoutCommits.emptyReason).toBe("branch_without_commits");

    await git(root, ["checkout", "executions/execution-1"]);
    await fs.writeFile(path.join(root, "agent.md"), "agent\n");
    await git(root, ["add", "agent.md"]);
    await git(root, [
      "commit",
      "-m",
      "[alpha] Add evidence",
      "-m",
      "OpenFARS-Agent: alpha\nOpenFARS-Execution: execution-1\nOpenFARS-Task: task-1"
    ], {
      GIT_AUTHOR_NAME: "OpenFARS Agent alpha",
      GIT_AUTHOR_EMAIL: "alpha@localhost",
      GIT_COMMITTER_NAME: "OpenFARS Git Service",
      GIT_COMMITTER_EMAIL: "openfars@localhost"
    });
    const commitsWithoutPullRequest = await readProjectGitGraph(assignedProject, { limit: 20 });
    expect(commitsWithoutPullRequest.emptyReason).toBe("commits_without_pull_request");
    expect(commitsWithoutPullRequest.commits.some((commit) => commit.agentId === "alpha")).toBe(true);

    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })).stdout.trim();
    const withPullRequest = await readProjectGitGraph({
      ...assignedProject,
      pullRequests: [{
        id: "pull-1",
        providerNumber: 1,
        status: "open",
        htmlUrl: "https://github.com/alice/repo/pull/1",
        headSha: head,
        ownerExecutionId: "execution-1"
      }]
    } as ProjectState, { limit: 20 });
    expect(withPullRequest.emptyReason).toBeUndefined();
  });
});
