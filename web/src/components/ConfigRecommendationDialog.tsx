import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, CheckCircle2, CircleAlert, LoaderCircle, Sparkles, X } from "lucide-react";
import type { ConfigRecommendationProgress } from "../api";
import type { ConfigurationChangeSummary } from "./config-recommendation-summary";

export interface RecommendationOperation {
  status: "running" | "completed" | "failed" | "cancelled";
  phase: ConfigRecommendationProgress["phase"] | "applying";
  stage?: number;
  message: string;
  startedAt: number;
  lastProgressAt?: number;
  advisor?: { gateway: string; model: string };
  finishedAt?: number;
  summary?: ConfigurationChangeSummary;
  warnings?: string[];
}
const steps = ["准备材料", "生成推荐", "校验配置", "应用配置"];

export function ConfigRecommendationDialog({ operation, onClose, onCancel, onRetry, canRetry }: {
  operation: RecommendationOperation;
  onClose(): void;
  onCancel(): void;
  onRetry(): void;
  canRetry: boolean;
}) {
  const headingId = useId();
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const [now, setNow] = useState(Date.now);
  const running = operation.status === "running";
  const completed = operation.status === "completed";
  const stage = completed ? 4 : operation.stage ?? (operation.phase === "preparing" ? 0 : operation.phase === "validation" ? 2 : operation.phase === "applying" ? 3 : 1);
  const percent = stage * 25;
  const elapsed = Math.max(0, Math.floor(((operation.finishedAt ?? now) - operation.startedAt) / 1000));
  const lastUpdateAge = Math.max(0, Math.floor((now - (operation.lastProgressAt ?? operation.startedAt)) / 1000));
  const summary = operation.summary;

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, operation.startedAt]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== "Tab") return;
      const targets = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex="0"]');
      const first = targets?.[0], last = targets?.[targets.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown, true);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", keydown, true); previous?.focus(); };
  }, []);

  return createPortal(<div className="recommendation-dialog-backdrop" onMouseDown={event => event.stopPropagation()}>
    <section ref={panel} tabIndex={-1} className="recommendation-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId}>
      <header className="recommendation-dialog-head">
        <span className={`recommendation-dialog-icon ${operation.status}`}>{completed ? <CheckCircle2 size={22} /> : operation.status === "failed" ? <CircleAlert size={22} /> : <Sparkles size={22} />}</span>
        <div><h2 id={headingId}>{completed ? "推荐配置已完成" : operation.status === "failed" ? "推荐配置生成失败" : operation.status === "cancelled" ? "推荐配置已取消" : "正在生成推荐配置"}</h2>
          {operation.advisor && <p>推荐模型：{operation.advisor.gateway} · {operation.advisor.model}</p>}
          <p>{completed ? "已自动应用到当前草稿，以下是本次修改。" : "根据课题要求、材料与当前配置生成完整方案。"}</p></div>
        <button type="button" className="recommendation-dialog-close" onClick={onClose} aria-label={running ? "取消推荐并关闭弹窗" : "关闭推荐配置弹窗"}><X size={18} /></button>
      </header>
      <div className="recommendation-dialog-body">
        <div className="recommendation-progress-heading"><strong role={operation.status === "failed" ? "alert" : "status"}>{operation.message}</strong><div className="recommendation-progress-meta"><span className="recommendation-progress-percent">{running ? `第 ${Math.min(stage + 1, 4)} / 4 阶段` : `${percent}%`}</span><span>已用时 {Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒</span></div></div>
        <div className={`recommendation-progress ${operation.status}`} role="progressbar" aria-label="推荐配置阶段进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={completed ? "100%，推荐已完成，配置已应用" : `${percent}%，已完成 ${stage} / 4 步，${operation.message}`}>
          <span className="recommendation-progress-fill" style={{ width: `${percent}%` }} />
          {running && <span className="recommendation-progress-active" style={{ left: `${percent}%` }} />}
        </div>
        <ol className="recommendation-progress-steps">{steps.map((step, index) => <li key={step} className={index < stage ? "done" : index === stage && running ? "active" : ""} aria-current={index === stage && running ? "step" : undefined}>
          <span>{index < stage ? <Check size={12} /> : index === stage && running ? <LoaderCircle className="spin" size={12} /> : index + 1}</span>{step}
        </li>)}</ol>
        {running && <><p className="recommendation-progress-help">各阶段耗时不同，模型生成期间按实际活动更新。连续 5 分钟没有模型进度，或总用时达到 10 分钟，会结束等待并显示原因。</p>
          <p className="recommendation-progress-help" aria-live="off">最近收到进度：{lastUpdateAge} 秒前。{lastUpdateAge >= 30 ? "暂未收到新的模型进度，仍在等待；可取消后重试。" : ""}</p></>}
        {completed && summary && <div className="recommendation-change-summary" role="region" aria-label="本次配置修改摘要">
          <section className="recommendation-change-introduction"><h3>本次推荐概述</h3><p>{summary.introduction}</p><p>{summary.workflowOverview}</p></section>
          <div className="recommendation-change-counts"><span>新增 Agent <strong>{summary.addedAgents.length}</strong></span><span>调整 Agent <strong>{summary.updatedAgents.length}</strong></span><span>移除 Agent <strong>{summary.removedAgents.length}</strong></span><span>Workflow 设置 <strong>{summary.workflowChanges.length}</strong></span></div>
          {!!summary.addedAgents.length && <section><h3>新增 Agent</h3><ul>{summary.addedAgents.map(agent => <li key={agent.name}><strong>{agent.name}</strong>{agent.description && <span>{agent.description}</span>}</li>)}</ul></section>}
          {!!summary.updatedAgents.length && <section><h3>调整的 Agent</h3><ul>{summary.updatedAgents.map(agent => <li key={agent.name}><strong>{agent.name}</strong>{agent.description && <span>{agent.description}</span>}<span>{agent.changes.join("；")}</span></li>)}</ul></section>}
          {!!summary.removedAgents.length && <section><h3>移除 Agent</h3><p>{summary.removedAgents.join("、")}</p></section>}
          <section><h3>Workflow 调整</h3>{summary.workflowChanges.length ? <div className="recommendation-change-tags">{summary.workflowChanges.map(change => <span key={change}>{change}</span>)}</div> : <p>执行编排与当前配置一致，本次未修改。</p>}<p>画布布局已自动整理。</p></section>
        </div>}
        {!!operation.warnings?.length && <div className="recommendation-dialog-warnings"><h3>需要留意</h3><ul>{operation.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
      </div>
      <footer className="recommendation-dialog-actions">{running ? <button type="button" onClick={onCancel}>取消推荐</button> : <>
        {(operation.status === "failed" || operation.status === "cancelled") && <button type="button" className="primary" disabled={!canRetry} onClick={onRetry}>重新推荐</button>}
        <button type="button" className={completed ? "primary" : ""} onClick={onClose}>{completed ? "完成，查看配置" : "关闭"}</button>
      </>}</footer>
    </section>
  </div>, document.body);
}
