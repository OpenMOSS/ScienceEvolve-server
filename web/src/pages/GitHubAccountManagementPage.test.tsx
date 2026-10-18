import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteGitHubAccount,
  getGitHubAccounts,
  getGitHubRepositoryStatus,
  getProjects,
  setDefaultGitHubAccount,
  startGitHubAuthorization,
  verifyGitHubAccount
} from "../api";
import type { GitHubAccountRecord, Project } from "../types";
import { GitHubAccountManagementPage } from "./GitHubAccountManagementPage";

vi.mock("../api", () => ({
  deleteGitHubAccount: vi.fn(),
  getGitHubAccounts: vi.fn(),
  getGitHubRepositoryStatus: vi.fn(),
  getProjects: vi.fn(),
  setDefaultGitHubAccount: vi.fn(),
  startGitHubAuthorization: vi.fn(),
  verifyGitHubAccount: vi.fn()
}));

const alice: GitHubAccountRecord = {
  id: "gha_11111111111111111111111111111111",
  login: "alice",
  providerUserId: 7,
  status: "ready",
  scopes: ["repo"],
  isDefault: true,
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
  lastVerifiedAt: "2026-09-24T08:00:00.000Z"
};

const bob: GitHubAccountRecord = {
  ...alice,
  id: "gha_22222222222222222222222222222222",
  login: "bob",
  providerUserId: 9,
  isDefault: false
};

beforeEach(() => {
  vi.mocked(getGitHubAccounts).mockReset();
  vi.mocked(getProjects).mockReset();
  vi.mocked(getProjects).mockResolvedValue([]);
  vi.mocked(getGitHubRepositoryStatus).mockReset();
  vi.mocked(getGitHubRepositoryStatus).mockResolvedValue({
    exists: true,
    observedAt: "2026-09-24T08:00:00.000Z"
  });
  vi.mocked(deleteGitHubAccount).mockReset();
  vi.mocked(setDefaultGitHubAccount).mockReset();
  vi.mocked(startGitHubAuthorization).mockReset();
  vi.mocked(verifyGitHubAccount).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GitHubAccountManagementPage", () => {
  it("does not claim OAuth is unconfigured when the backend cannot be reached", async () => {
    vi.mocked(getGitHubAccounts).mockRejectedValue(new Error("后端服务不可用"));
    render(<GitHubAccountManagementPage onBack={vi.fn()} />);
    expect(await screen.findByText("后端服务不可用")).toBeVisible();
    expect(screen.queryByText("GitHub OAuth 尚未配置")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录新账号" })).toBeDisabled();
  });

  it("shows setup guidance only after the server confirms credentials are missing", async () => {
    vi.mocked(getGitHubAccounts).mockResolvedValue({ accounts: [], oauthConfigured: false });
    render(<GitHubAccountManagementPage onBack={vi.fn()} />);
    expect(await screen.findByText("GitHub OAuth 尚未配置")).toBeVisible();
    expect(screen.getByRole("button", { name: "登录新账号" })).toBeDisabled();
  });

  it("manages multiple account identities without displaying credentials", async () => {
    vi.mocked(getGitHubAccounts).mockResolvedValue({
      accounts: [alice, bob],
      defaultAccountId: alice.id,
      oauthConfigured: true
    });
    vi.mocked(verifyGitHubAccount).mockResolvedValue(alice);
    vi.mocked(setDefaultGitHubAccount).mockResolvedValue({
      ...bob,
      isDefault: true
    });
    vi.mocked(deleteGitHubAccount).mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<GitHubAccountManagementPage onBack={vi.fn()} />);

    const aliceCard = (await screen.findByText("alice")).closest("article");
    const bobCard = screen.getByText("bob").closest("article");
    expect(aliceCard).not.toBeNull();
    expect(bobCard).not.toBeNull();
    expect(screen.queryByText(/token|secret|ghp_/i)).not.toBeInTheDocument();

    fireEvent.click(within(aliceCard!).getByRole("button", { name: "验证授权" }));
    await waitFor(() => expect(verifyGitHubAccount).toHaveBeenCalledWith(alice.id));
    expect(await screen.findByText("alice 的授权仍然有效")).toBeVisible();

    fireEvent.click(within(bobCard!).getByRole("button", { name: "设为默认" }));
    await waitFor(() => expect(setDefaultGitHubAccount).toHaveBeenCalledWith(bob.id));
    expect(within(bobCard!).getByText("默认账号")).toBeVisible();

    fireEvent.click(within(bobCard!).getByRole("button", { name: "移除" }));
    await waitFor(() => expect(deleteGitHubAccount).toHaveBeenCalledWith(bob.id));
    expect(screen.queryByText("bob")).not.toBeInTheDocument();
    expect(within(aliceCard!).getByText("默认账号")).toBeVisible();
  });

  it("uses an OAuth popup and refreshes the library after a same-origin callback", async () => {
    vi.mocked(getGitHubAccounts)
      .mockResolvedValueOnce({ accounts: [], oauthConfigured: true })
      .mockResolvedValueOnce({
        accounts: [alice],
        defaultAccountId: alice.id,
        oauthConfigured: true
      });
    vi.mocked(startGitHubAuthorization).mockResolvedValue({
      authorizationUrl: "https://github.com/login/oauth/authorize?state=opaque",
      expiresAt: "2026-09-24T08:10:00.000Z"
    });
    const popup = {
      closed: false,
      close: vi.fn(),
      location: { href: "about:blank" }
    };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);

    render(<GitHubAccountManagementPage onBack={vi.fn()} />);
    await screen.findByText("尚未登录 GitHub 账号");
    fireEvent.click(screen.getByRole("button", { name: "登录新账号" }));

    await waitFor(() => expect(startGitHubAuthorization).toHaveBeenCalledTimes(1));
    expect(popup.location.href).toBe("https://github.com/login/oauth/authorize?state=opaque");
    window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin,
      data: {
        type: "openfars:github-auth",
        status: "success",
        message: "GitHub 账号 alice 已连接"
      }
    }));

    expect(await screen.findByText("GitHub 账号 alice 已连接")).toBeVisible();
    expect(await screen.findByText("alice")).toBeVisible();
    expect(getGitHubAccounts).toHaveBeenCalledTimes(2);
  });

  it("lists OpenFARS repositories using GitHub-only management links", async () => {
    vi.mocked(getGitHubAccounts).mockResolvedValue({
      accounts: [alice],
      defaultAccountId: alice.id,
      oauthConfigured: true
    });
    vi.mocked(getProjects).mockResolvedValue([{
      id: "prj_repository",
      title: "Evidence review",
      status: "completed",
      git: {
        enabled: true,
        status: "ready",
        provider: "github",
        account: {
          id: alice.id,
          login: alice.login,
          providerUserId: alice.providerUserId
        },
        repository: {
          owner: "alice",
          name: "evidence-review",
          htmlUrl: "https://github.com/alice/evidence-review",
          private: true,
          defaultBranch: "main",
          localPath: "repository"
        }
      },
      pullRequests: [{
        id: "pull_1",
        providerNumber: 7,
        htmlUrl: "https://github.com/alice/evidence-review/pull/7",
        head: "groups/research",
        base: "main",
        ownerExecutionId: "execution_1",
        status: "open",
        observedAt: "2026-09-24T08:00:00.000Z"
      }]
    } as Project]);

    render(<GitHubAccountManagementPage onBack={vi.fn()} />);

    const repository = await screen.findByText("alice/evidence-review");
    const card = repository.closest("article")!;
    expect(within(card).getByRole("link", { name: "查看代码" })).toHaveAttribute(
      "href",
      "https://github.com/alice/evidence-review/tree/main"
    );
    expect(within(card).getByRole("link", { name: "GitHub Network" })).toHaveAttribute(
      "href",
      "https://github.com/alice/evidence-review/network"
    );
    expect(within(card).getByRole("link", { name: "活动" })).toHaveAttribute(
      "href",
      "https://github.com/alice/evidence-review/activity"
    );
    expect(within(card).getByRole("link", { name: "查看 PR" })).toHaveAttribute(
      "href",
      "https://github.com/alice/evidence-review/pull/7"
    );
    expect(within(card).getByRole("link", { name: "前往 GitHub 删除" })).toHaveAttribute(
      "href",
      "https://github.com/alice/evidence-review/settings"
    );
    expect(within(card).queryByRole("button", { name: /删除/ })).not.toBeInTheDocument();
    expect(getProjects).toHaveBeenCalledWith(true);
    expect(getGitHubRepositoryStatus).toHaveBeenCalledWith("prj_repository");
  });

  it("marks a repository deleted on GitHub and disables stale management links", async () => {
    vi.mocked(getGitHubAccounts).mockResolvedValue({
      accounts: [alice],
      defaultAccountId: alice.id,
      oauthConfigured: true
    });
    vi.mocked(getProjects).mockResolvedValue([{
      id: "prj_deleted_repository",
      title: "Deleted smoke project",
      status: "cancelled",
      git: {
        enabled: true,
        status: "ready",
        provider: "github",
        account: { id: alice.id, login: alice.login, providerUserId: alice.providerUserId },
        repository: {
          owner: "alice",
          name: "deleted-project",
          htmlUrl: "https://github.com/alice/deleted-project",
          private: true,
          defaultBranch: "main",
          localPath: "repository"
        }
      }
    } as Project]);
    vi.mocked(getGitHubRepositoryStatus).mockResolvedValue({
      exists: false,
      observedAt: "2026-09-24T08:00:00.000Z"
    });

    render(<GitHubAccountManagementPage onBack={vi.fn()} />);

    const repository = await screen.findByText("alice/deleted-project");
    const card = repository.closest("article")!;
    expect(within(card).getByText("GitHub 已删除")).toBeVisible();
    expect(within(card).getByText("已从 GitHub 删除")).toBeVisible();
    expect(within(card).getByText(/本地项目记录仍会保留/)).toBeVisible();
    expect(within(card).queryByRole("link")).not.toBeInTheDocument();
    expect(within(card).getAllByText(/查看代码|GitHub Network|活动|查看 PR|仓库已删除/)).toHaveLength(5);
  });
});
