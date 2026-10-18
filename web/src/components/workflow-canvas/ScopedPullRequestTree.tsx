import { GitBranch, GitPullRequest } from "lucide-react";
import type { ReactNode } from "react";
import type { Project, PullRequestRecord, ScopedExecution, ScopedGroupRun } from "../../types";

type DisplayPull = Pick<PullRequestRecord, "providerNumber" | "htmlUrl" | "status" | "head" | "base"> &
  Partial<Pick<PullRequestRecord, "conflictPaths" | "blockers">>;

function PullLink({ pull }: { pull?: DisplayPull }) {
  if (!pull) return <small>尚无权威 PR 事实</small>;
  return <span className="scoped-pr-fact"><GitPullRequest size={12} />
    <a href={pull.htmlUrl} target="_blank" rel="noreferrer">PR #{pull.providerNumber}</a>
    <strong>{pull.status}</strong><code>{pull.head} → {pull.base}</code>
    {pull.conflictPaths?.length ? <small>冲突：{pull.conflictPaths.join("、")}</small> : null}
    {pull.blockers?.length ? <small>等待：{pull.blockers.join("；")}</small> : null}
  </span>;
}

export function ScopedPullRequestTree({ project }: { project: Project }) {
  const runs = project.scopedGroupRuns ?? [];
  const scopedExecutions = project.scopedExecutions ?? [];
  const scopedPulls = new Map((project.scopedPullRequests ?? []).map((pull) => [pull.ownerExecutionId, pull]));
  const agentMerges = new Map((project.scopedAgentMerges ?? []).map((fact) => [fact.executionId, fact]));
  const finalMerges = new Map((project.scopedGroupFinalMerges ?? []).map((fact) => [fact.groupRunId, fact]));
  const finalOwners = new Map((project.scopedFinalIntegrations ?? []).map((owner) => [owner.groupRunId, owner]));
  const groups = new Map((project.orchestration.collaborations ?? []).map((group) => [group.id, group]));
  const roots = runs.filter((run) => !run.parentGroupRunId || !runs.some((entry) => entry.id === run.parentGroupRunId));
  const scopedDelivery = (execution: ScopedExecution) => <li key={execution.id}>
    <span className="scoped-pr-node"><GitBranch size={12} /><strong>Agent {execution.agentId}</strong><code>{execution.executionBranch}</code><em>{execution.status}</em></span>
    <PullLink pull={agentMerges.get(execution.id)?.pullRequest ?? scopedPulls.get(execution.id)} />
  </li>;
  const groupNode = (run: ScopedGroupRun, path: ReadonlySet<string>): ReactNode => {
    if (path.has(run.id)) return <li key={run.id}>父子组记录存在循环：{run.id}</li>;
    const nextPath = new Set([...path, run.id]);
    const name = groups.get(run.groupId)?.displayName ?? run.groupId;
    const children = runs.filter((candidate) => candidate.parentGroupRunId === run.id);
    const memberExecutions = scopedExecutions.filter((execution) => execution.groupRunId === run.id);
    const final = finalMerges.get(run.id);
    const owner = finalOwners.get(run.id);
    const observedPull = owner && scopedPulls.get(owner.id);
    const pendingFinalPull = owner?.projectId === project.id &&
      owner.executionBranch === run.groupBranch && owner.integrationTarget === run.integrationTarget &&
      observedPull?.head === owner.executionBranch && observedPull.base === owner.integrationTarget &&
      observedPull.headSha === owner.expectedHeadSha ? observedPull : undefined;
    const finalPull = final?.pullRequest ?? pendingFinalPull;
    const issues = (project.scopedGroupIssues ?? []).filter((issue) => issue.groupRunId === run.id);
    return <li key={run.id}>
      <span className="scoped-pr-node"><GitBranch size={13} /><strong>{name}</strong><code>{run.groupBranch || "等待创建集成分支"}</code><em>{run.status}</em></span>
      <dl><div><dt>GroupRun</dt><dd>{run.id}</dd></div><div><dt>base</dt><dd>{run.baseCommit || "等待观测"}</dd></div><div><dt>target</dt><dd>{run.integrationTarget || "等待观测"}</dd></div><div><dt>revision</dt><dd>{run.workflowRevision}</dd></div></dl>
      {issues.map((issue) => <p key={issue.id} className="scoped-pr-issue" role="status">等待组内协调（{issue.kind === "final" ? "最终交付" : issue.kind === "route" ? "后继选择" : "规划"}）：{issue.reason}</p>)}
      {(memberExecutions.length > 0 || children.length > 0) && <ol>{memberExecutions.map(scopedDelivery)}{children.map((child) => groupNode(child, nextPath))}</ol>}
      <div className="scoped-pr-final">
        <strong>最终 PR → {run.integrationTarget || "目标分支"}</strong><PullLink pull={finalPull} />
        {final ? <small>本地目标分支已同步至 {final.synchronization.localHeadAfter}</small>
          : pendingFinalPull?.status === "merged" ? <small>PR 已合并，等待确认本地目标分支同步</small>
            : run.status === "cancelled" ? <small>组已取消；保留分支及历史 PR 事实，不再发布最终交付</small>
              : issues.some((issue) => issue.kind === "final") ? <small>最终交付暂停，等待 Leader 按权限恢复</small>
                : owner?.status === "integrating" && !pendingFinalPull ? <small>正在准备最终 PR</small> : null}
      </div>
    </li>;
  };
  return <section className="scoped-pr-tree" aria-label="分层 Git 与 PR 树">
    <h3>分层 Git / PR 树</h3>
    {!roots.length ? <p>尚无组运行、分支或 PR 的权威事实；配置图不会被画成已执行结果。</p> : <ol>{roots.map((run) => groupNode(run, new Set()))}</ol>}
  </section>;
}
