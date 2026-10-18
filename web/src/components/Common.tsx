import type { ButtonHTMLAttributes, ReactNode } from "react";
import {
  Atom,
  Bot,
  BrainCircuit,
  Check,
  FlaskConical,
  LoaderCircle,
  PenLine,
  SearchCheck,
  Sparkles
} from "lucide-react";
import { agentMeta, projectWaitingLabel, STATUS_META } from "../lib";
import type { AgentTemplate, OverallProgress, ProjectRuntimeProjection, ProjectStatus } from "../types";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="ScienceEvolve 首页">
      <span className="brand-mark" aria-hidden="true">
        <Atom size={compact ? 18 : 21} strokeWidth={1.8} />
      </span>
      <span className="brand-copy">
        <strong>ScienceEvolve</strong>
        {!compact && <small>科研智能体工作台</small>}
      </span>
    </div>
  );
}

export function AgentIcon({
  role,
  size = 18
}: {
  role: AgentTemplate | string;
  size?: number;
}) {
  const props = { size, strokeWidth: 1.8, "aria-hidden": true as const };
  if (role === "main") return <BrainCircuit {...props} />;
  if (role === "idea") return <Sparkles {...props} />;
  if (role === "execution") return <FlaskConical {...props} />;
  if (role === "writing") return <PenLine {...props} />;
  if (role === "review") return <SearchCheck {...props} />;
  return <Bot {...props} />;
}

export function AgentBadge({
  role,
  name,
  subtle = false
}: {
  role: AgentTemplate | string;
  name?: string;
  subtle?: boolean;
}) {
  const meta = agentMeta(name ?? role, role);
  return (
    <span className={`agent-badge agent-${meta.color} ${subtle ? "subtle" : ""}`}>
      <AgentIcon role={role} size={14} />
      {meta.shortName}
    </span>
  );
}

export function StatusBadge({
  status,
  runtime,
  withDot = true
}: {
  status: ProjectStatus;
  runtime?: ProjectRuntimeProjection;
  withDot?: boolean;
}) {
  const meta = STATUS_META[status];
  const waitingLabel = projectWaitingLabel(status, runtime);
  const label = waitingLabel ?? meta.label;
  return (
    <span className={`status-badge status-${meta.tone}`} title={waitingLabel ? runtime?.waiting?.reason : undefined}>
      {withDot && <span className="status-dot" aria-hidden="true" />}
      {label}
    </span>
  );
}

export function OverallProgressBar({
  progress,
  compact = false
}: {
  progress?: OverallProgress;
  compact?: boolean;
}) {
  const percent = Math.max(0, Math.min(100, progress?.percent ?? 0));
  const formattedPercent = Number.isInteger(percent)
    ? String(percent)
    : percent.toFixed(1);
  return (
    <div
      className={`overall-progress ${compact ? "overall-progress-compact" : ""}`}
      aria-label={`流程进度 ${formattedPercent}%`}
    >
      <div className="overall-progress-copy">
        <strong>{progress?.label || "等待任务启动"}</strong>
        <span>流程进度 {formattedPercent}%</span>
      </div>
      <div
        className="overall-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <i style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: ReactNode;
  loading?: boolean;
};

export function Button({
  variant = "secondary",
  icon,
  loading,
  children,
  className = "",
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`button button-${variant} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <LoaderCircle className="spin" size={17} /> : icon}
      <span>{children}</span>
    </button>
  );
}

export function PageLoader({ label = "正在加载…" }: { label?: string }) {
  return (
    <div className="page-loader" role="status">
      <span className="loader-orbit">
        <Bot size={24} />
      </span>
      <p>{label}</p>
    </div>
  );
}

export function ErrorPanel({
  title = "暂时无法加载",
  message,
  action
}: {
  title?: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="error-panel" role="alert">
      <span className="error-icon">!</span>
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
      {action}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-visual">{icon ?? <Check size={28} />}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
