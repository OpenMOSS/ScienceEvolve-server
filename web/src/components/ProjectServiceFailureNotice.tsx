import { AlertTriangle } from "lucide-react";
import type { Project } from "../types";

export function ProjectServiceFailureNotice({ project, compact = false }: { project: Project; compact?: boolean }) {
  if (["draft", "completed", "cancelled", "stopped"].includes(project.status) || project.phase !== "collaboration:writer-lease-lost") return null;
  const waiting = project.runtime?.waiting;
  return <section className={`project-authorization-notice project-service-failure${compact ? " is-compact" : ""}`}
    role="alert" aria-label="服务写入租约失效">
    <AlertTriangle size={20} aria-hidden="true" />
    <div><strong>服务写入租约失效，项目暂时无法继续</strong>
      <p>{waiting?.kind === "service" ? waiting.reason : "需要恢复后端服务后接续原任务，项目记录和原会话已保留。"}</p>
      {waiting?.failedAt && <p>发生时间：<time dateTime={waiting.failedAt}>{new Date(waiting.failedAt).toLocaleString("zh-CN")}</time>
        {waiting.errorCode ? ` · ${waiting.errorCode}` : ""}</p>}
    </div>
  </section>;
}
