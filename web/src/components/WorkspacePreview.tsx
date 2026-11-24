import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import type { Project } from "../types";
import { Brand, Button, OverallProgressBar, PageLoader, StatusBadge } from "./Common";

export function WorkspacePreview({ project, onBack, children, onRetry, error }: {
  project?: Project; onBack: () => void; children?: ReactNode; onRetry?: () => void; error?: string;
}) {
  if (!project) return <div className="workspace-loading"><Brand compact /><PageLoader label="正在进入科研工作台…" /></div>;
  return (
    <main className="workspace-page" aria-label="科研工作台">
      <header className="workspace-header">
        <div className="workspace-brand-zone">
          <button className="back-icon-button" onClick={onBack} title="返回项目列表"><ArrowLeft size={18} /></button>
          <Brand compact />
          <div className="workspace-title"><h1>{project.title}</h1>
            <StatusBadge status={project.status} phase={project.phase} runtime={project.runtime} /></div>
        </div>
      </header>
      <div className="workspace-progress-strip" aria-label="项目进度"><OverallProgressBar progress={project.overallProgress} /></div>
      {onRetry && <div className="workspace-progress-strip" role="status">
        <span>{error ? `工作台详情读取失败：${error}` : "正在加载工作台详情和侧栏…"}</span>
        {error && <Button type="button" variant="secondary" onClick={onRetry}>重试加载</Button>}
      </div>}
      {children ?? <PageLoader label="正在读取最近轨迹…" />}
    </main>
  );
}
