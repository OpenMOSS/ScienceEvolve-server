import { BrainCircuit, CheckCircle2, ChevronDown, CircleAlert, CircleStop, LoaderCircle, Wrench } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { ProjectExplainerEvent } from "../types";
import { explainerReplyProgress } from "./project-explainer-events";
import "./project-explainer-trace.css";

interface Tool { name?: string; status?: string; input?: unknown; outputPreview?: string; isError?: boolean; durationMs?: number; truncated?: boolean }
const toolData = (event?: ProjectExplainerEvent) => (event?.data?.canonicalEvent as { tool?: Tool } | undefined)?.tool;
const labels: Record<string, string> = { get_context: "读取当前配置", update_draft: "修改项目草稿", save_draft: "保存项目草稿",
  undo_draft: "撤销草稿修改", submit_workflow_adjustment: "提交 Workflow 调整" };
export function explainerToolLabel(name: string): string {
  return Object.entries(labels).find(([key]) => name === key || name.endsWith(`__${key}`) || name.endsWith(`/${key}`))?.[1] ?? name;
}
const preview = (value: unknown): string => typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2);

export function ProjectExplainerReplyStatus({ events, active }: { events: ProjectExplainerEvent[]; active: boolean }) {
  const progress = explainerReplyProgress(events, active);
  if (!progress) return null;
  const text = progress.toolName ? `正在${explainerToolLabel(progress.toolName)}…` : progress.text;
  return <p className={`explainer-reply-status phase-${progress.phase}`} role="status" aria-label="Project Explainer 回复状态">
    {progress.phase === "working" ? <LoaderCircle className="spin" size={13} /> : progress.phase === "failed" ? <CircleAlert size={13} />
      : progress.phase === "stopped" ? <CircleStop size={13} /> : <CheckCircle2 size={13} />}
    <span title={text}>{text}</span>
  </p>;
}

export function ProjectExplainerTrace({ event, output, active }: { event: ProjectExplainerEvent; output?: ProjectExplainerEvent; active: boolean }) {
  if (event.kind === "reasoning") return <details className="explainer-trace-summary" open={active}>
    <summary><BrainCircuit size={14} />思考摘要{active && <LoaderCircle className="spin" size={12} />}<ChevronDown className="explainer-trace-chevron" size={13} /></summary>
    <div><ReactMarkdown>{event.text}</ReactMarkdown></div>
  </details>;
  const tool = { ...toolData(event), ...toolData(output) };
  const name = tool.name ?? event.text;
  const failed = tool.status === "failed" || tool.isError === true;
  const completed = event.phase === "completed" || output?.phase === "completed" || tool.status === "completed" || failed;
  const status = failed ? "调用失败" : completed ? "已完成" : active ? "执行中" : "已中断";
  const text = output?.text || tool.outputPreview || "";
  const input = preview(tool.input);
  if (event.kind === "tool_output") return <details className="explainer-trace-output"><summary>查看工具结果</summary><pre>{event.text || "工具未返回文本结果。"}</pre></details>;
  return <div className={`explainer-trace-tool${failed ? " is-failed" : ""}`} aria-label={`${explainerToolLabel(name)}：${status}`}>
    <div className="explainer-trace-tool-heading"><Wrench size={14} /><strong>{explainerToolLabel(name)}</strong>
      <span>{status}</span>{!completed && active ? <LoaderCircle className="spin" size={12} /> : failed ? <CircleAlert size={13} /> : completed ? <CheckCircle2 size={13} /> : null}</div>
    <code className="explainer-trace-tool-name">{name}</code>
    {typeof tool.durationMs === "number" && <small>耗时 {(tool.durationMs / 1000).toFixed(1)} 秒</small>}
    {input && <details><summary>调用参数</summary><pre>{input}</pre></details>}
    {(completed || text) && <details><summary>{failed ? "查看错误详情" : "查看工具结果"}{tool.truncated ? "（已截断）" : ""}</summary><pre>{text || "工具执行已结束，未返回文本结果。"}</pre></details>}
  </div>;
}
