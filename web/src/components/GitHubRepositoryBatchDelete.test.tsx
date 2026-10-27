import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteGitHubRepositories, previewGitHubRepositoryDeletion, type GitHubRepositoryDeletionPreview } from "../api";
import type { GitHubAccountRecord, Project } from "../types";
import { GitHubRepositoryBatchDelete } from "./GitHubRepositoryBatchDelete";
import { normalizeProject } from "../lib";

vi.mock("../api", () => ({ deleteGitHubRepositories: vi.fn(), previewGitHubRepositoryDeletion: vi.fn() }));
const alice = { id: `gha_${"a".repeat(32)}`, login: "alice", providerUserId: 7, status: "ready", scopes: ["repo", "delete_repo"], isDefault: true } as GitHubAccountRecord;
const bob = { ...alice, id: `gha_${"b".repeat(32)}`, login: "bob", providerUserId: 9, isDefault: false };
function project(name: string, account = alice, status: Project["status"] = "completed"): Project {
  return normalizeProject({ id: `prj_${name === "A" ? "1".repeat(32) : name === "B" ? "2".repeat(32) : "3".repeat(32)}`, title: `项目 ${name}`, status,
    git: { enabled: true, status: "ready", provider: "github", account, repository: { owner: account.login, name,
      htmlUrl: `https://github.com/${account.login}/${name}`, private: true, defaultBranch: "main", localPath: "repository" } } });
}
const projects = [project("A"), project("B"), project("C", bob)];
function preview(): GitHubRepositoryDeletionPreview {
  return { previewId: "a".repeat(48), accountId: alice.id, accountLogin: alice.login, expiresAt: "2026-10-25T12:00:00.000Z", confirmationText: "永久删除",
    repositories: projects.slice(0, 2).map(item => ({ projectId: item.id, owner: "alice", name: item.git!.repository!.name, status: "ready" })) };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(previewGitHubRepositoryDeletion).mockResolvedValue(preview());
});
function setup(input: { accounts?: GitHubAccountRecord[]; projects?: Project[]; deletedProjectIds?: Set<string> } = {}) {
  const onDeleted = vi.fn(), onAuthorize = vi.fn();
  render(<GitHubRepositoryBatchDelete accounts={input.accounts ?? [alice, bob]} projects={input.projects ?? projects}
    deletedProjectIds={input.deletedProjectIds ?? new Set()} connecting={false} onAuthorize={onAuthorize} onDeleted={onDeleted} />);
  fireEvent.click(screen.getByRole("button", { name: "批量删除仓库" }));
  return { onDeleted, onAuthorize };
}
async function prepare() {
  fireEvent.click(screen.getByRole("checkbox", { name: "选择当前账号所有可删除仓库" }));
  fireEvent.click(screen.getByRole("button", { name: "预览删除 2 个仓库" }));
  await screen.findByRole("textbox", { name: "仓库永久删除确认词" });
}

describe("GitHub repository batch deletion", () => {
  it("limits select-all to one batch and lets it be cleared for accounts with more than 100 repositories", () => {
    setup({ projects: Array.from({ length: 101 }, (_, index) => ({ ...project(`repository-${index}`), id: `prj_${index.toString(16).padStart(32, "0")}` })) });
    const selectAll = screen.getByRole("checkbox", { name: "选择当前账号所有可删除仓库" });
    fireEvent.click(selectAll);
    expect(selectAll).toBeChecked();
    expect(screen.getByRole("button", { name: "预览删除 100 个仓库" })).toBeEnabled();
    fireEvent.click(selectAll);
    expect(screen.getByRole("button", { name: "预览删除 0 个仓库" })).toBeDisabled();
    expect(previewGitHubRepositoryDeletion).not.toHaveBeenCalled();
  });
  it("scopes selection to one account and only deletes after an explicit preview and exact confirmation", async () => {
    const f = setup();
    expect(screen.queryByRole("checkbox", { name: "选择仓库 bob/C" })).not.toBeInTheDocument();
    expect(previewGitHubRepositoryDeletion).not.toHaveBeenCalled();
    await prepare();
    expect(previewGitHubRepositoryDeletion).toHaveBeenCalledWith(alice.id, projects.slice(0, 2).map(item => ({ projectId: item.id, owner: "alice", name: item.git!.repository!.name })));
    expect(deleteGitHubRepositories).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "永久删除 2 个仓库" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "仓库永久删除确认词" }), { target: { value: "删除" } });
    expect(button).toBeDisabled();
    const result = preview(); result.repositories.forEach(item => { item.status = "deleted"; });
    vi.mocked(deleteGitHubRepositories).mockResolvedValue(result);
    fireEvent.change(screen.getByRole("textbox", { name: "仓库永久删除确认词" }), { target: { value: "永久删除" } });
    fireEvent.click(button);
    await screen.findByText("批量删除结果");
    expect(deleteGitHubRepositories).toHaveBeenCalledExactlyOnceWith(alice.id, "a".repeat(48), "永久删除");
    expect(screen.getAllByText("已删除")).toHaveLength(2);
    expect(f.onDeleted).toHaveBeenCalledWith(result.repositories);
  });

  it("clears old selections when switching accounts and requires an optional deletion authorization", () => {
    const f = setup({ accounts: [{ ...alice, scopes: ["repo"] }, bob] });
    expect(screen.getByRole("checkbox", { name: "选择仓库 alice/A" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "授权仓库删除" }));
    expect(f.onAuthorize).toHaveBeenCalledWith(alice.id);
    fireEvent.change(screen.getByRole("combobox", { name: "批量删除使用的 GitHub 账号" }), { target: { value: bob.id } });
    expect(screen.queryByRole("checkbox", { name: "选择仓库 alice/A" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "选择仓库 bob/C" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "预览删除 0 个仓库" })).toBeDisabled();
  });

  it("blocks repositories with unfinished projects and those already confirmed deleted", () => {
    setup({ projects: [project("A", alice, "running"), project("B")], deletedProjectIds: new Set([projects[1]!.id]) });
    expect(screen.getByRole("checkbox", { name: "选择仓库 alice/A" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "选择仓库 alice/B" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "选择当前账号所有可删除仓库" })).toBeDisabled();
    expect(deleteGitHubRepositories).not.toHaveBeenCalled();
  });

  it("reports failures and uncertainty separately and updates only successfully deleted cards", async () => {
    const f = setup(); await prepare();
    const result = preview();
    result.repositories[0]!.status = "deleted";
    result.repositories[1]!.status = "unconfirmed"; result.repositories[1]!.error = "删除请求结果尚未确认";
    vi.mocked(deleteGitHubRepositories).mockResolvedValue(result);
    fireEvent.change(screen.getByRole("textbox", { name: "仓库永久删除确认词" }), { target: { value: "永久删除" } });
    fireEvent.click(screen.getByRole("button", { name: "永久删除 2 个仓库" }));
    await screen.findByText("结果待核对");
    expect(f.onDeleted).toHaveBeenCalledWith([result.repositories[0]]);
    expect(screen.getByText("删除请求结果尚未确认")).toBeVisible();
  });

  it("does not reopen a cancelled preview or perform any deletion when its late response arrives", async () => {
    let resolve!: (value: GitHubRepositoryDeletionPreview) => void;
    vi.mocked(previewGitHubRepositoryDeletion).mockImplementation(() => new Promise(done => { resolve = done; }));
    setup();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择当前账号所有可删除仓库" }));
    fireEvent.click(screen.getByRole("button", { name: "预览删除 2 个仓库" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await act(async () => { resolve(preview()); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deleteGitHubRepositories).not.toHaveBeenCalled();
  });

  it("keeps the same preview for a user-requested retry after an HTTP failure", async () => {
    setup(); await prepare();
    vi.mocked(deleteGitHubRepositories).mockRejectedValue(new Error("网络中断，请核对结果"));
    fireEvent.change(screen.getByRole("textbox", { name: "仓库永久删除确认词" }), { target: { value: "永久删除" } });
    fireEvent.click(screen.getByRole("button", { name: "永久删除 2 个仓库" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByRole("button", { name: "永久删除 2 个仓库" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "永久删除 2 个仓库" }));
    await waitFor(() => expect(deleteGitHubRepositories).toHaveBeenCalledTimes(2));
    expect(vi.mocked(deleteGitHubRepositories).mock.calls[0]).toEqual(vi.mocked(deleteGitHubRepositories).mock.calls[1]);
    expect(previewGitHubRepositoryDeletion).toHaveBeenCalledOnce();
  });
});
