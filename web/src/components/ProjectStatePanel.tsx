import type { Project } from "../types";
import "./project-state-panel.css";

const experimentStatus: Record<string, string> = { submission_unknown: "提交结果待确认", queued: "已排队", running: "执行中",
  resource_ready: "资源已就绪", succeeded: "执行成功", failed: "执行失败", cancelled: "已取消", unknown: "待确认" };
const terminal = new Set(["resource_ready", "succeeded", "failed", "cancelled"]);

export function ProjectStatePanel({ project }: { project: Project }) {
  const state = project.collaboration;
  if (!state) return null;
  const records = state.businessState ?? [];
  const formal = state.formalState, experiments = formal?.experiments.ledger.experiments ?? [];
  return <details className="project-state-panel">
    <summary>协作状态 · 版本 {state.stateRevision} · {records.length} 条业务记录{experiments.length ? ` · ${experiments.length} 项实验记录` : ""}</summary>
    <p>状态在本项目内共享。Main 可维护全项目；Leader 可维护本组及全部嵌套子组；Worker 可维护自身和当前任务。文件访问范围不改变这些权限。</p>
    <p>业务记录由 Agent 维护，正式交付与结束以实际执行结果为准。Memory 保留业务上下文。</p>
    {formal?.invocationCommit.status !== undefined && formal.invocationCommit.status !== "idle" && <p>
      本轮结果提交：{formal.invocationCommit.status === "in_progress" ? "待完成提交" : "已登记"}
    </p>}
    {experiments.length > 0 && <section aria-label="实验状态">
      <p>资源就绪、平台执行结果和任务完成分别核对。</p>
      {experiments.map(experiment => <details key={experiment.id}>
        <summary>{experiment.agent} · {experimentStatus[experiment.status] ?? experiment.status}
          {experiment.required ? " · 本任务必需" : ""}</summary>
        <dl className="project-state-facts">
          <dt>实验</dt><dd><code>{experiment.id}</code></dd>
          <dt>所属任务</dt><dd><code>{experiment.taskId}</code></dd>
          <dt>本轮运行</dt><dd><code>{experiment.runId}</code></dd>
          {terminal.has(experiment.status) && <><dt>当前阶段返回</dt><dd>{experiment.resultReceived ? "原会话已实收" : "尚未实收"}</dd></>}
          {experiment.observedAt && <><dt>观察时间</dt><dd><time dateTime={experiment.observedAt}>{new Date(experiment.observedAt).toLocaleString()}</time></dd></>}
        </dl>
      </details>)}
    </section>}
    {records.length ? records.map(record => <details key={JSON.stringify(record.object)}>
      <summary><code>{record.object.kind} / {record.object.id}</code><time dateTime={record.updatedAt}>{new Date(record.updatedAt).toLocaleString()}</time></summary>
      <pre>{JSON.stringify(record.extensions, null, 2)}</pre>
    </details>) : <p>尚无 Agent 登记业务协作记录。</p>}
  </details>;
}
