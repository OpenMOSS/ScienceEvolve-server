import { ExternalLink, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getGitHubRepositoryStatus, getProjectGitGraph } from "../../api";
import type { GitGraphCommit, GitGraphEmptyReason, Project } from "../../types";
import { ScopedPullRequestTree } from "./ScopedPullRequestTree";

const LANE_COLORS = ["#42a5ff", "#ffbf3f", "#42e39a", "#be7dff", "#ff6ba8", "#32d6db", "#ff795f", "#a7e34b"];
const ROW_HEIGHT = 66;
const LANE_WIDTH = 21;

const EMPTY_REASON_COPY: Record<GitGraphEmptyReason, { title: string; description: string }> = {
  git_disabled: {
    title: "项目未启用 Git",
    description: "该项目不会创建仓库、成员分支或 Pull Request，因此没有 Git 拓扑可展示。"
  },
  repository_uninitialized: {
    title: "仓库尚未初始化",
    description: "服务端尚未建立可读取的本地仓库和首个提交；这里不会生成占位 commit。"
  },
  repository_initializing: {
    title: "仓库仍在初始化",
    description: "仓库创建、main 初始化或首次 push 尚未完成，完成后提交图会自动出现。"
  },
  repository_failed: {
    title: "仓库初始化失败",
    description: "Git 初始化没有完成。修复或重试后将继续使用真实仓库事实，不会绘制虚假分支。"
  },
  before_first_assignment: {
    title: "尚未开始成员分工",
    description: "项目在首次任务分配前暂停或尚未进入分工，因此还没有成员分支。"
  },
  branch_without_commits: {
    title: "成员分支尚无业务提交",
    description: "任务或 execution 已创建，但 Agent 还没有在成员分支产生可展示的 commit。"
  },
  commits_without_pull_request: {
    title: "已有提交，尚未创建 Pull Request",
    description: "下面展示真实 commit；PR head、检查与 merge 节点会在 Pull Request 创建后出现。"
  }
};

interface GraphLayout {
  lanes: Map<string, number>;
  maxLane: number;
}

export function layoutGitGraph(commits: readonly GitGraphCommit[]): GraphLayout {
  const active: Array<string | undefined> = [];
  const lanes = new Map<string, number>();
  let maxLane = 0;
  const freeLane = () => {
    const empty = active.findIndex((value) => value === undefined);
    if (empty >= 0) return empty;
    active.push(undefined);
    return active.length - 1;
  };
  for (const commit of commits) {
    let lane = active.indexOf(commit.sha);
    if (lane < 0) lane = freeLane();
    lanes.set(commit.sha, lane);
    maxLane = Math.max(maxLane, lane);
    const firstParent = commit.parents[0];
    if (!firstParent) {
      active[lane] = undefined;
    } else {
      const existing = active.indexOf(firstParent);
      if (existing >= 0 && existing !== lane) active[lane] = undefined;
      else active[lane] = firstParent;
    }
    for (const parent of commit.parents.slice(1)) {
      if (active.includes(parent)) continue;
      const parentLane = freeLane();
      active[parentLane] = parent;
      maxLane = Math.max(maxLane, parentLane);
    }
  }
  return { lanes, maxLane };
}

function shortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const seconds = Math.round((timestamp - Date.now()) / 1_000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  if (absolute < 60) return formatter.format(seconds, "second");
  if (absolute < 3_600) return formatter.format(Math.round(seconds / 60), "minute");
  if (absolute < 86_400) return formatter.format(Math.round(seconds / 3_600), "hour");
  if (absolute < 2_592_000) return formatter.format(Math.round(seconds / 86_400), "day");
  return shortTime(value);
}

function GitLaneGraph({ commits, layout, selectedSha }: { commits: readonly GitGraphCommit[]; layout: GraphLayout; selectedSha?: string }) {
  const rowBySha = new Map(commits.map((commit, index) => [commit.sha, index]));
  const width = Math.max(58, (layout.maxLane + 1) * LANE_WIDTH + 30);
  const height = Math.max(1, commits.length * ROW_HEIGHT);
  return <svg className="git-tree-lanes" width={width} height={height} aria-hidden="true">
    <defs>
      <filter id="git-tree-neon-glow" x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="2.4" result="blur" />
        <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
      </filter>
    </defs>
    {commits.flatMap((commit, row) => {
      const lane = layout.lanes.get(commit.sha) ?? 0;
      const x = 17 + lane * LANE_WIDTH;
      const y = row * ROW_HEIGHT + 23;
      return commit.parents.flatMap((parent, parentIndex) => {
        const parentRow = rowBySha.get(parent);
        if (parentRow === undefined) return [];
        const parentLane = layout.lanes.get(parent) ?? lane;
        const parentX = 17 + parentLane * LANE_WIDTH;
        const parentY = parentRow * ROW_HEIGHT + 23;
        const color = LANE_COLORS[parentIndex === 0 ? lane % LANE_COLORS.length : parentLane % LANE_COLORS.length];
        const path = `M ${x} ${y} C ${x} ${Math.min(parentY, y + 27)}, ${parentX} ${Math.max(y, parentY - 27)}, ${parentX} ${parentY}`;
        return <g key={`${commit.sha}:${parent}`}>
          <path className="git-tree-lane-aura" d={path} fill="none" stroke={color} strokeWidth="7" />
          <path className="git-tree-lane-path" d={path} fill="none" stroke={color} strokeWidth="2.6" />
        </g>;
      });
    })}
    {commits.map((commit, row) => {
      const lane = layout.lanes.get(commit.sha) ?? 0;
      const x = 17 + lane * LANE_WIDTH;
      const y = row * ROW_HEIGHT + 23;
      const merge = commit.parents.length > 1;
      const selected = commit.sha === selectedSha;
      const color = LANE_COLORS[lane % LANE_COLORS.length];
      return <g key={commit.sha}>
        <circle className="git-tree-node-aura" cx={x} cy={y} r={selected ? 11 : merge ? 8 : 7} fill={color} />
        {selected && <circle className="git-tree-node-selection" cx={x} cy={y} r="9" fill="none" stroke={color} strokeWidth="1.5" />}
        <circle className="git-tree-node" cx={x} cy={y} r={merge ? 5.5 : 4.5} fill={color} stroke="#0c1712" strokeWidth="2" />
        {merge && <circle cx={x} cy={y} r="2" fill="#f7fffb" />}
      </g>;
    })}
  </svg>;
}

export function GitTreeDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [commits, setCommits] = useState<GitGraphCommit[]>([]);
  const [refs, setRefs] = useState<Array<{ name: string; sha: string }>>([]);
  const [emptyReason, setEmptyReason] = useState<GitGraphEmptyReason>();
  const [nextCursor, setNextCursor] = useState<string>();
  const [selectedSha, setSelectedSha] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [includeTechnical, setIncludeTechnical] = useState(false);
  const [agentFilter, setAgentFilter] = useState("all");
  const [branchFilter, setBranchFilter] = useState("all");
  const [groupFilter, setGroupFilter] = useState("all");
  const [pullRequestFilter, setPullRequestFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [remoteStatus, setRemoteStatus] = useState<"checking" | "available" | "deleted" | "unknown">("checking");

  const load = async (append = false, signal?: AbortSignal) => {
    append ? setLoadingMore(true) : setLoading(true);
    setError("");
    if (!append) setEmptyReason(undefined);
    try {
      const page = await getProjectGitGraph(project.id, {
        limit: 200,
        ...(append && nextCursor ? { cursor: nextCursor } : {}),
        includeTechnical
      }, signal);
      if (signal?.aborted) return;
      setCommits((current) => append
        ? [...current, ...page.commits.filter((commit) => !current.some((entry) => entry.sha === commit.sha))]
        : page.commits);
      setRefs(page.refs);
      if (!append) setEmptyReason(page.emptyReason);
      setNextCursor(page.nextCursor);
      if (!append) setSelectedSha((current) => current && page.commits.some((commit) => commit.sha === current) ? current : page.commits[0]?.sha);
    } catch (reason) {
      if (signal?.aborted) return;
      setError(reason instanceof Error ? reason.message : "Git 提交图加载失败");
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  useEffect(() => {
    closeRef.current?.focus();
    const controller = new AbortController();
    let inFlight = true;
    void load(false, controller.signal).finally(() => { inFlight = false; });
    const running = ["queued", "running", "retrying", "interrupting", "pausing"].includes(project.status);
    const timer = running ? window.setInterval(() => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      void load(false, controller.signal).finally(() => { inFlight = false; });
    }, 5_000) : undefined;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", keydown);
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearInterval(timer);
      window.removeEventListener("keydown", keydown);
    };
  // nextCursor is intentionally excluded: background refresh always reloads page one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeTechnical, project.id, project.status]);

  useEffect(() => {
    let current = true;
    if (!project.git?.repository || !project.git.account) {
      setRemoteStatus("unknown");
      return () => { current = false; };
    }
    setRemoteStatus("checking");
    void getGitHubRepositoryStatus(project.id).then((observation) => {
      if (current) setRemoteStatus(observation.exists ? "available" : "deleted");
    }).catch(() => {
      if (current) setRemoteStatus("unknown");
    });
    return () => { current = false; };
  }, [project.git?.account, project.git?.repository, project.id]);

  const agents = useMemo(() => [...new Set(commits.map((commit) => commit.agentId).filter((value): value is string => Boolean(value)))].sort(), [commits]);
  const branchNames = useMemo(() => refs.map((ref) => ref.name).filter((name) => !name.startsWith("origin/")).sort(), [refs]);
  const groupRunIds = useMemo(() => [...new Set(commits.map((commit) => commit.groupRunId).filter((value): value is string => Boolean(value)))].sort(), [commits]);
  const pullRequestStatuses = useMemo(() => [...new Set(commits.flatMap((commit) => commit.pullRequests.map((pull) => pull.status)))].sort(), [commits]);
  const groupLabel = (groupRunId: string) => {
    const groupRun = project.orchestration.schemaVersion === 3
      ? project.scopedGroupRuns?.find((run) => run.id === groupRunId)
      : project.groupRuns?.find((run) => run.id === groupRunId);
    const nodeRun = project.orchestration.schemaVersion === 3
      ? project.nodeRuns?.find((run) => run.activationRequestId === (groupRun && "activationRequestId" in groupRun ? groupRun.activationRequestId : undefined))
      : project.nodeRuns?.find((run) => run.id === (groupRun && "nodeRunId" in groupRun ? groupRun.nodeRunId : undefined));
    const nodeId = groupRun?.groupId ?? nodeRun?.node.nodeId;
    const displayName = project.orchestration.collaborations?.find((group) => group.id === nodeId)?.displayName;
    return displayName ? `${displayName} · ${groupRunId.slice(0, 8)}` : groupRunId;
  };
  const branchReachable = useMemo(() => {
    if (branchFilter === "all") return undefined;
    const head = refs.find((ref) => ref.name === branchFilter)?.sha;
    if (!head) return new Set<string>();
    const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
    const reachable = new Set<string>();
    const pending = [head];
    while (pending.length) {
      const sha = pending.pop()!;
      if (reachable.has(sha)) continue;
      reachable.add(sha);
      pending.push(...(bySha.get(sha)?.parents ?? []));
    }
    return reachable;
  }, [branchFilter, commits, refs]);
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => commits.filter((commit) => (
    (agentFilter === "all" || commit.agentId === agentFilter)
    && (groupFilter === "all" || commit.groupRunId === groupFilter)
    && (pullRequestFilter === "all" || commit.pullRequests.some((pull) => pull.status === pullRequestFilter))
    && (!branchReachable || branchReachable.has(commit.sha))
    && (!normalizedQuery || [commit.subject, commit.sha, commit.authorName, commit.agentId, commit.groupRunId, commit.taskId, ...commit.refs]
      .filter(Boolean).some((value) => value!.toLowerCase().includes(normalizedQuery)))
  )), [agentFilter, branchReachable, commits, groupFilter, normalizedQuery, pullRequestFilter]);
  const layout = useMemo(() => layoutGitGraph(filtered), [filtered]);
  const selected = commits.find((commit) => commit.sha === selectedSha);
  const graphWidth = Math.max(58, (layout.maxLane + 1) * LANE_WIDTH + 30);
  const explanation = emptyReason ? EMPTY_REASON_COPY[emptyReason] : undefined;
  const failureDetail = emptyReason === "repository_failed"
    ? project.git?.initialization?.error ?? project.git?.blockers?.at(-1) ?? project.error
    : undefined;

  return <div className="git-tree-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="git-tree-dialog" role="dialog" aria-modal="true" aria-labelledby="git-tree-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="git-tree-header">
        <div><span>ScienceEvolve GIT TREE</span><h2 id="git-tree-title">提交与分支图</h2><small>Agent 作者与 GitHub 执行账号分开展示</small></div>
        <div><button type="button" onClick={() => void load(false)} disabled={loading}><RefreshCw size={14} />刷新</button><button ref={closeRef} type="button" aria-label="关闭 Git 提交图" onClick={onClose}><X size={17} /></button></div>
      </header>
      <div className="git-tree-toolbar">
        <label><span>分支</span><select value={branchFilter} onChange={(event) => setBranchFilter(event.target.value)}><option value="all">全部分支</option>{branchNames.map((name) => <option value={name} key={name}>{name}</option>)}</select></label>
        <label><span>Agent</span><select value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)}><option value="all">全部 Agent</option>{agents.map((agent) => <option value={agent} key={agent}>{agent}</option>)}</select></label>
        <label><span>协作组</span><select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}><option value="all">全部协作组</option>{groupRunIds.map((groupRunId) => <option value={groupRunId} key={groupRunId}>{groupLabel(groupRunId)}</option>)}</select></label>
        <label><span>PR 状态</span><select value={pullRequestFilter} onChange={(event) => setPullRequestFilter(event.target.value)}><option value="all">全部 PR 状态</option>{pullRequestStatuses.map((status) => <option value={status} key={status}>{status}</option>)}</select></label>
        <label className="git-tree-search"><span>搜索</span><input value={query} placeholder="commit、SHA、作者" onChange={(event) => setQuery(event.target.value)} /></label>
        <label className="git-tree-system-toggle"><input type="checkbox" checked={includeTechnical} onChange={(event) => setIncludeTechnical(event.target.checked)} />显示系统提交</label>
      </div>
      {remoteStatus === "deleted" && <div className="git-tree-remote-state is-deleted" role="status">GitHub 远端仓库已删除；下面继续显示 ScienceEvolve 保留的本地提交历史，远端链接已停用。</div>}
      {remoteStatus === "unknown" && <div className="git-tree-remote-state is-unknown" role="status">暂时无法核验 GitHub 远端状态；本地提交图仍可正常查看。</div>}
      {error && <div className="git-tree-error" role="alert">{error}</div>}
      {project.orchestration.schemaVersion === 3 && <ScopedPullRequestTree project={project} />}
      {emptyReason && explanation && <section
        className={`git-tree-explanation is-${emptyReason}`}
        aria-label="Git 提交图状态说明"
        data-reason-code={emptyReason}
      >
        <div><strong>{explanation.title}</strong><code>{emptyReason}</code></div>
        <p>{explanation.description}</p>
        <small>当前阶段：{project.phase || project.status}{failureDetail ? ` · ${failureDetail}` : ""}</small>
      </section>}
      <div className="git-tree-content">
        <div className="git-tree-list" style={{ ["--git-graph-width" as string]: `${graphWidth}px` }}>
          {loading && !commits.length ? <p className="git-tree-empty">正在读取本地 Git 历史…</p> : !filtered.length ? <p className="git-tree-empty">{emptyReason ? "没有可展示的真实 commit。" : "当前筛选条件下没有 commit。"}</p> : <>
            <GitLaneGraph commits={filtered} layout={layout} selectedSha={selectedSha} />
            <ol>{filtered.map((commit) => <li key={commit.sha} className={selectedSha === commit.sha ? "is-selected" : ""}>
              <button type="button" onClick={() => setSelectedSha(commit.sha)}>
                <span className="git-tree-commit-title">{commit.parents.length > 1 ? <GitMerge size={13} /> : <GitCommitHorizontal size={13} />}<strong>{commit.subject}</strong></span>
                <span className="git-tree-badges">{commit.refs.map((ref) => <em key={ref}><GitBranch size={10} />{ref}</em>)}{commit.pullRequests.map((pull) => <em className="is-pr" key={pull.id}><GitPullRequest size={10} />PR #{pull.number}</em>)}</span>
                <span className="git-tree-commit-meta"><b>{commit.agentId ? `Agent ${commit.agentId}` : commit.authorName}</b><time title={shortTime(commit.committedAt)}>{relativeTime(commit.committedAt)}</time><code>{commit.sha.slice(0, 8)}</code></span>
              </button>
            </li>)}</ol>
          </>}
          {nextCursor && <button className="git-tree-load-more" type="button" disabled={loadingMore} onClick={() => void load(true)}>{loadingMore ? "加载中…" : "加载更多 commit"}</button>}
        </div>
        <aside className="git-tree-details">
          {selected ? <>
            <h3>{selected.subject}</h3>
            <div className="git-tree-identity"><span><strong>Agent 作者</strong><b>{selected.agentId ?? "未标记"}</b></span><span><strong>Git Author</strong><b>{selected.authorName}</b><small>{selected.authorEmail}</small></span><span><strong>GitHub 执行账号</strong><b>{project.git?.account?.login ?? "未记录"}</b></span></div>
            <dl><div><dt>Commit</dt><dd>{selected.sha}</dd></div><div><dt>Parents</dt><dd>{selected.parents.join("、") || "根提交"}</dd></div><div><dt>Author time</dt><dd>{shortTime(selected.authoredAt)}</dd></div><div><dt>Committer</dt><dd>{selected.committerName} · {shortTime(selected.committedAt)}</dd></div></dl>
            {Object.keys(selected.trailers).length > 0 && <section><strong>ScienceEvolve 审计字段</strong>{Object.entries(selected.trailers).map(([key, value]) => <p key={key}><code>{key}</code><span>{value}</span></p>)}</section>}
            {selected.body && <section><strong>提交说明</strong><pre>{selected.body}</pre></section>}
            <section className="git-tree-changed-files"><strong>变更文件 · {selected.changedFiles.length}</strong>{selected.changedFiles.length ? <ul>{selected.changedFiles.map((file) => <li key={`${file.status}:${file.path}`}><em>{file.status}</em><code>{file.path}</code></li>)}</ul> : <p>该提交没有可展示的文件差异（合并提交可能只记录父级关系）。</p>}</section>
            <div className="git-tree-detail-actions">{remoteStatus !== "deleted" && selected.htmlUrl && <a href={selected.htmlUrl} target="_blank" rel="noreferrer"><ExternalLink size={12} />在 GitHub 查看 commit</a>}{remoteStatus !== "deleted" && selected.pullRequests.map((pull) => <a href={pull.htmlUrl} target="_blank" rel="noreferrer" key={pull.id}><GitPullRequest size={12} />查看 PR #{pull.number}</a>)}</div>
          </> : <p>选择一个 commit 查看 Agent、PR、父提交和审计字段。</p>}
        </aside>
      </div>
    </section>
  </div>;
}
