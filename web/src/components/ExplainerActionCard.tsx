import type { ExplainerAssistantAction } from "../api";
import { explainerActionHref } from "./project-explainer-events";

export function ExplainerActionCard({ action }: { action: ExplainerAssistantAction }) {
  const href = explainerActionHref(action);
  const saved = action.kind === "draft.saved" || action.kind === "draft.updated" && (action.savedTask || action.context.taskId && !action.context.projectId);
  return <article className="explainer-action-card">
    <strong>{action.kind === "drafts.deleted" ? "项目草稿已删除" : action.kind === "projects.started" ? "批量启动结果" : action.kind === "draft.created" ? "独立项目草稿已新建"
      : action.kind === "workflow.submitted" ? "Workflow 修改已提交" : saved ? "项目草稿已保存" : "草稿已更新"}</strong>
    <p>{action.summary}</p>
    {action.launches?.results.map(result => <div key={result.taskId}>
      <span>{result.title || result.taskId}：{result.status === "started" ? "已提交启动" : result.status === "unconfirmed" ? "结果待核对" : "启动失败"}</span>
      {result.error && <p>{result.error}</p>}
      {result.status === "started" && result.projectId && /^prj_[a-f0-9]{32}$/.test(result.projectId) && <a href={`#/projects/${result.projectId}`}>打开项目</a>}
    </div>)}
    {href && <a href={`#${href}`}>打开{href.startsWith("/saved-tasks/") ? "项目草稿" : "项目"}</a>}
  </article>;
}
