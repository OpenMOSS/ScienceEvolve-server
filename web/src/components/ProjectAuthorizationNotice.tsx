import { AlertTriangle } from "lucide-react";
import { githubAuthorizationWaiting } from "../../../server/src/internal/shared/project-runtime-status.js";
import type { Project } from "../types";

export function ProjectAuthorizationNotice({ project, compact = false }: { project: Project; compact?: boolean }) {
  const waiting = githubAuthorizationWaiting(project);
  if (!waiting) return null;
  return (
    <section className={`project-authorization-notice${compact ? " is-compact" : ""}`} role="alert" aria-label="GitHub 授权异常">
      <AlertTriangle size={20} aria-hidden="true" />
      <div>
        <strong>GitHub 授权需要处理{project.git?.account?.login ? ` · ${project.git.account.login}` : ""}</strong>
        <p>{waiting.reason} 当前 Git 操作受阻，项目进度已保留。</p>
      </div>
      <a className="button button-secondary" href="#/github-accounts">前往 GitHub 账号</a>
    </section>
  );
}
