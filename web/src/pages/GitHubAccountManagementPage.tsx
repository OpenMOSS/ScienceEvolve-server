import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  FolderGit2,
  GitGraph,
  Github,
  GitPullRequest,
  LoaderCircle,
  LogIn,
  RefreshCw,
  ShieldCheck,
  Star,
  Trash2
} from "lucide-react";
import {
  deleteGitHubAccount,
  getGitHubAccounts,
  getGitHubRepositoryStatus,
  getProjects,
  setDefaultGitHubAccount,
  startGitHubAuthorization,
  startGitHubRepositoryDeletionAuthorization,
  verifyGitHubAccount
} from "../api";
import { Button, ErrorPanel } from "../components/Common";
import { GitHubRepositoryBatchDelete } from "../components/GitHubRepositoryBatchDelete";
import type { GitHubAccountRecord, GitHubRepositoryObservation, Project } from "../types";

type RepositoryCheck =
  | { status: "available"; observation: GitHubRepositoryObservation }
  | { status: "deleted"; observation: GitHubRepositoryObservation }
  | { status: "unknown" };

function repositoryUrl(base: string, suffix = ""): string {
  return `${base.replace(/\/+$/, "")}${suffix}`;
}

function projectStatusLabel(status: Project["status"]): string {
  const labels: Partial<Record<Project["status"], string>> = {
    draft: "草稿",
    queued: "排队中",
    running: "运行中",
    retrying: "重试中",
    interrupting: "中断中",
    interrupted: "已中断",
    pausing: "暂停中",
    paused: "已暂停",
    cancelling: "取消中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    stopping: "停止中",
    stopped: "已停止"
  };
  return labels[status] ?? status;
}

export function GitHubAccountManagementPage({ onBack }: { onBack: () => void }) {
  const [accounts, setAccounts] = useState<GitHubAccountRecord[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [repositoryChecks, setRepositoryChecks] = useState<Record<string, RepositoryCheck>>({});
  const [oauthConfigured, setOauthConfigured] = useState<boolean>();
  const [loading, setLoading] = useState(true);
  const [repositoriesLoading, setRepositoriesLoading] = useState(true);
  const [repositoriesError, setRepositoriesError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const popupMonitorRef = useRef<number>();

  const stopPopupMonitor = useCallback(() => {
    if (popupMonitorRef.current === undefined) return;
    window.clearInterval(popupMonitorRef.current);
    popupMonitorRef.current = undefined;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setOauthConfigured(undefined);
    setRepositoriesLoading(true);
    setRepositoryChecks({});
    const projectsRequest = getProjects(true)
      .then(async (items) => {
        setProjects(items);
        setRepositoriesError("");
        const repositories = items.filter((project) => project.git?.repository);
        const checks = await Promise.all(repositories.map(async (project) => {
          try {
            const observation = await getGitHubRepositoryStatus(project.id);
            return [project.id, {
              status: observation.exists ? "available" : "deleted",
              observation
            }] as const;
          } catch {
            return [project.id, { status: "unknown" }] as const;
          }
        }));
        setRepositoryChecks(Object.fromEntries(checks));
      })
      .catch((reason) => {
        setRepositoriesError(reason instanceof Error ? reason.message : "项目仓库加载失败");
      })
      .finally(() => setRepositoriesLoading(false));
    try {
      const catalog = await getGitHubAccounts();
      setAccounts(catalog.accounts);
      setOauthConfigured(catalog.oauthConfigured);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "GitHub 账号库加载失败");
    } finally {
      setLoading(false);
    }
    await projectsRequest;
  }, []);

  const repositoryProjects = projects.filter((project) => project.git?.repository);

  useEffect(() => {
    void load();
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !event.data || typeof event.data !== "object") return;
      const message = event.data as Record<string, unknown>;
      if (message.type !== "openfars:github-auth") return;
      stopPopupMonitor();
      setConnecting(false);
      if (message.status === "success") {
        setNotice(typeof message.message === "string" ? message.message : "GitHub 账号已连接");
        setError("");
        void load();
      } else {
        setError(typeof message.message === "string" ? message.message : "GitHub 登录失败");
      }
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      stopPopupMonitor();
    };
  }, [load, stopPopupMonitor]);

  const connect = async (deletionAccountId?: string) => {
    setConnecting(true);
    setError("");
    setNotice("");
    const popup = window.open("about:blank", "openfars-github-oauth", "popup=yes,width=720,height=780");
    if (!popup) {
      setConnecting(false);
      setError("浏览器阻止了 GitHub 登录窗口，请允许本站打开弹窗后重试");
      return;
    }
    try {
      const authorization = deletionAccountId ? await startGitHubRepositoryDeletionAuthorization(deletionAccountId) : await startGitHubAuthorization();
      popup.location.href = authorization.authorizationUrl;
      stopPopupMonitor();
      popupMonitorRef.current = window.setInterval(() => {
        if (!popup.closed) return;
        stopPopupMonitor();
        setConnecting(false);
        setError("GitHub 登录窗口已关闭，账号尚未连接");
      }, 500);
    } catch (reason) {
      stopPopupMonitor();
      popup.close();
      setConnecting(false);
      setError(reason instanceof Error ? reason.message : "GitHub 登录启动失败");
    }
  };

  const verify = async (account: GitHubAccountRecord) => {
    setBusyId(account.id);
    setError("");
    try {
      const updated = await verifyGitHubAccount(account.id);
      setAccounts((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNotice(`${updated.login} 的授权仍然有效`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "GitHub 账号验证失败");
      await load();
    } finally {
      setBusyId("");
    }
  };

  const chooseDefault = async (account: GitHubAccountRecord) => {
    setBusyId(account.id);
    setError("");
    try {
      const updated = await setDefaultGitHubAccount(account.id);
      setAccounts((current) => current.map((item) => ({
        ...item,
        isDefault: item.id === updated.id
      })));
      setNotice(`${updated.login} 已设为默认 GitHub 账号`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "默认账号设置失败");
    } finally {
      setBusyId("");
    }
  };

  const remove = async (account: GitHubAccountRecord) => {
    if (!window.confirm(`从 ScienceEvolve 移除 GitHub 账号“${account.login}”吗？\n\n不会删除该账号已有的仓库。`)) return;
    setBusyId(account.id);
    setError("");
    try {
      await deleteGitHubAccount(account.id);
      setAccounts((current) => {
        const remaining = current.filter((item) => item.id !== account.id);
        if (!account.isDefault) return remaining;
        const nextDefault = remaining.find((item) => item.status === "ready")?.id;
        return remaining.map((item) => ({ ...item, isDefault: item.id === nextDefault }));
      });
      setNotice(`${account.login} 已从本地账号库移除`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "GitHub 账号移除失败");
    } finally {
      setBusyId("");
    }
  };

  return (
    <main className="github-account-page">
      <header className="github-account-hero">
        <Button variant="ghost" icon={<ArrowLeft size={18} />} onClick={onBack}>返回</Button>
        <div>
          <span className="eyebrow"><ShieldCheck size={15} /> Credential authority</span>
          <h1>GitHub 账号库</h1>
          <p>项目创建时选择一个账号并永久绑定；访问令牌仅由服务端加密保存。</p>
        </div>
        <Button
          variant="primary"
          icon={connecting ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}
          onClick={() => void connect()}
          disabled={connecting || !oauthConfigured}
        >
          {connecting ? "等待 GitHub…" : "登录新账号"}
        </Button>
      </header>

      {oauthConfigured === false && (
        <div className="github-account-setup" role="status">
          <CircleAlert size={18} />
          <span><strong>GitHub OAuth 尚未配置</strong><small>请在 Server 设置 Client ID、Client Secret 与 Callback URL 后重启服务。</small></span>
        </div>
      )}
      {error && <ErrorPanel title="GitHub 账号操作失败" message={error} />}
      {notice && <div className="github-account-notice" role="status"><CheckCircle2 size={16} />{notice}</div>}

      {loading ? (
        <div className="github-account-loading"><LoaderCircle className="spin" size={22} />正在读取 GitHub 账号…</div>
      ) : accounts.length ? (
        <section className="github-account-grid" aria-label="GitHub 账号列表">
          {accounts.map((account) => {
            const busy = busyId === account.id;
            const ready = account.status === "ready";
            return (
              <article className={`github-account-card${ready ? " is-ready" : " needs-auth"}`} key={account.id}>
                <header>
                  <span className="github-account-avatar" aria-hidden="true"><Github size={23} /></span>
                  <span className="github-account-identity">
                    <strong>{account.login}</strong>
                    <small>GitHub 用户 #{account.providerUserId}</small>
                  </span>
                  <span className={`github-account-status ${account.status}`}>
                    {ready ? "授权正常" : account.status === "expired" ? "授权已过期" : "授权已撤销"}
                  </span>
                </header>
                <div className="github-account-tags">
                  {account.isDefault && <em><Star size={11} />默认账号</em>}
                  <em>repo</em>
                  {account.scopes.includes("delete_repo") && <em>可删除仓库</em>}
                  <em>服务端加密</em>
                </div>
                <dl>
                  <div><dt>最近验证</dt><dd>{account.lastVerifiedAt ? new Date(account.lastVerifiedAt).toLocaleString() : "尚未验证"}</dd></div>
                  <div><dt>项目身份</dt><dd>{account.id.slice(0, 12)}…</dd></div>
                </dl>
                <footer>
                  {ready
                    ? <button type="button" disabled={busy} onClick={() => void verify(account)}><RefreshCw className={busy ? "spin" : undefined} size={14} />验证授权</button>
                    : <button type="button" disabled={connecting || !oauthConfigured} onClick={() => void connect()}><LogIn size={14} />重新登录</button>}
                  {!account.isDefault && ready && <button type="button" disabled={busy} onClick={() => void chooseDefault(account)}><Star size={14} />设为默认</button>}
                  <button type="button" className="danger" disabled={busy} onClick={() => void remove(account)}><Trash2 size={14} />移除</button>
                </footer>
              </article>
            );
          })}
        </section>
      ) : (
        <section className="github-account-empty">
          <Github size={34} />
          <strong>尚未登录 GitHub 账号</strong>
          <p>启用 Git 机制前，需要先登录至少一个能够创建个人私有仓库的账号。</p>
          <Button variant="primary" icon={<LogIn size={16} />} disabled={!oauthConfigured || connecting} onClick={() => void connect()}>登录 GitHub</Button>
        </section>
      )}

      <section className="github-repository-library" aria-labelledby="github-repository-library-title">
        <header>
          <span className="github-repository-library-icon" aria-hidden="true"><FolderGit2 size={20} /></span>
          <div>
            <h2 id="github-repository-library-title">项目仓库</h2>
            <p>汇总 ScienceEvolve 项目创建的仓库；可按账号选择并批量删除远端仓库。逐提交 GitTree 请进入项目查看。</p>
          </div>
          <span className="github-repository-count">{repositoryProjects.length} 个</span>
        </header>
        <GitHubRepositoryBatchDelete accounts={accounts} projects={repositoryProjects} connecting={connecting}
          deletedProjectIds={new Set(Object.entries(repositoryChecks).filter(([, check]) => check.status === "deleted").map(([id]) => id))}
          onAuthorize={oauthConfigured ? accountId => void connect(accountId) : undefined} onDeleted={repositories => {
            const names = new Set(repositories.map(repository => `${repository.owner}/${repository.name}`.toLowerCase()));
            const observation = { exists: false, observedAt: new Date().toISOString() };
            setRepositoryChecks(current => ({ ...current, ...Object.fromEntries(repositoryProjects.filter(project =>
              names.has(`${project.git!.repository!.owner}/${project.git!.repository!.name}`.toLowerCase()))
              .map(project => [project.id, { status: "deleted" as const, observation }])) }));
          }} />
        {repositoriesError && <ErrorPanel title="项目仓库加载失败" message={repositoriesError} />}
        {repositoriesLoading ? (
          <div className="github-repository-loading"><LoaderCircle className="spin" size={18} />正在读取项目仓库…</div>
        ) : repositoryProjects.length ? (
          <div className="github-repository-grid" aria-label="ScienceEvolve 项目仓库列表">
            {repositoryProjects.map((project) => {
              const storedRepository = project.git!.repository!;
              const check = repositoryChecks[project.id];
              const deleted = check?.status === "deleted";
              const observation = check?.status === "available" ? check.observation : undefined;
              const repository = {
                ...storedRepository,
                ...(observation?.htmlUrl ? { htmlUrl: observation.htmlUrl } : {}),
                ...(typeof observation?.private === "boolean" ? { private: observation.private } : {}),
                ...(observation?.defaultBranch ? { defaultBranch: observation.defaultBranch } : {})
              };
              const latestPull = project.pullRequests?.at(-1);
              return <article className={`github-repository-card${deleted ? " is-deleted" : ""}`} key={project.id}>
                <header>
                  <span><Github size={17} /></span>
                  <div><strong>{repository.owner}/{repository.name}</strong><small>{project.title}</small></div>
                  <em className={deleted ? "deleted" : check?.status === "unknown" ? "unknown" : undefined}>
                    {deleted ? "GitHub 已删除" : check?.status === "unknown" ? "状态未知" : repository.private ? "Private" : "Public"}
                  </em>
                </header>
                <dl>
                  <div><dt>项目状态</dt><dd>{projectStatusLabel(project.status)}</dd></div>
                  <div><dt>仓库状态</dt><dd>{deleted ? "已从 GitHub 删除" : check?.status === "unknown" ? "暂时无法核验" : "可访问"}</dd></div>
                  <div><dt>GitHub 账号</dt><dd>{project.git?.account?.login ?? repository.owner}</dd></div>
                  <div><dt>默认分支</dt><dd>{repository.defaultBranch}</dd></div>
                  <div><dt>PR</dt><dd>{project.pullRequests?.length ?? 0}</dd></div>
                </dl>
                {deleted && <p className="github-repository-deleted-note"><CircleAlert size={14} />GitHub 已确认该仓库不存在，本地项目记录仍会保留。</p>}
                <footer>
                  {deleted ? (
                    <>
                      <span className="github-repository-disabled-action" aria-disabled="true"><ExternalLink size={14} />查看代码</span>
                      <span className="github-repository-disabled-action" aria-disabled="true"><GitGraph size={14} />GitHub Network</span>
                      <span className="github-repository-disabled-action" aria-disabled="true"><Activity size={14} />活动</span>
                      <span className="github-repository-disabled-action" aria-disabled="true"><GitPullRequest size={14} />查看 PR</span>
                      <span className="github-repository-disabled-action danger" aria-disabled="true"><Trash2 size={14} />仓库已删除</span>
                    </>
                  ) : (
                    <>
                      <a href={repositoryUrl(repository.htmlUrl, `/tree/${encodeURIComponent(repository.defaultBranch)}`)} target="_blank" rel="noreferrer"><ExternalLink size={14} />查看代码</a>
                      <a href={repositoryUrl(repository.htmlUrl, "/network")} target="_blank" rel="noreferrer" title="查看包含 Fork 的 GitHub repository network；逐提交图请进入项目"><GitGraph size={14} />GitHub Network</a>
                      <a href={repositoryUrl(repository.htmlUrl, "/activity")} target="_blank" rel="noreferrer" title="在 GitHub 查看 push、分支与合并时间线"><Activity size={14} />活动</a>
                      <a href={latestPull?.htmlUrl ?? repositoryUrl(repository.htmlUrl, "/pulls")} target="_blank" rel="noreferrer"><GitPullRequest size={14} />查看 PR</a>
                      <a className="danger" href={repositoryUrl(repository.htmlUrl, "/settings")} target="_blank" rel="noreferrer" title="在 GitHub Settings 的 Danger Zone 中删除仓库"><Trash2 size={14} />前往 GitHub 删除</a>
                    </>
                  )}
                </footer>
              </article>;
            })}
          </div>
        ) : (
          <div className="github-repository-empty"><FolderGit2 size={25} /><span><strong>还没有项目仓库</strong><small>启用 Git 机制并启动项目后，仓库会显示在这里。</small></span></div>
        )}
        <p className="github-repository-disclaimer"><CircleAlert size={14} />批量删除需要额外授权并确认所选仓库；也可以前往 GitHub Settings 删除单个仓库。</p>
      </section>
    </main>
  );
}
