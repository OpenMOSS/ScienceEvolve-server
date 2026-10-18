import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, LocateFixed } from "lucide-react";
import { formatClock } from "../../lib";
import type { AgentEvent, Project } from "../../types";
import { buildExecutionPreview, previewText, type ExecutionPreviewStep } from "./core/execution-preview";
import { collaborationProgress } from "./core/collaboration-activity";
import type { WorkflowRuntimeState } from "./core/workflow-runtime";
import { ensureExecutionSummary, type ExecutionSummary } from "../../api";

function OutputSummary({ projectId, invocationId, output }: { projectId: string; invocationId?: string; output: string }) {
  const [summary, setSummary] = useState<ExecutionSummary>();
  const [attempt, setAttempt] = useState(0);
  const [original, setOriginal] = useState(false);
  useEffect(() => {
    if (!invocationId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSummary(undefined);
    const poll = async (retry: boolean) => {
      try {
        const result = await ensureExecutionSummary(projectId, invocationId, retry, controller.signal);
        if (controller.signal.aborted) return;
        setSummary(result);
        if (result.status === "queued" || result.status === "running") timer = setTimeout(() => { void poll(false); }, 2000);
      } catch (error) {
        if (!controller.signal.aborted) setSummary({ invocationId, status: "failed", error: error instanceof Error ? error.message : "无法获取摘要" });
      }
    };
    void poll(attempt > 0);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, invocationId, attempt]);
  return <div className="execution-preview-original">
    <small>AI 执行摘要 · 使用项目解说 Agent · 请以原文为准</small>
    <p aria-live="polite">{!invocationId ? "缺少调用标识，无法生成摘要。" : summary?.status === "completed" ? summary.text : summary?.status === "failed" ? `摘要生成失败：${summary.error ?? "请重试"}` : summary?.status === "running" ? "项目解说模型正在生成摘要，较慢网关可能需要几分钟…" : "摘要等待生成…"}</p>
    {summary?.status === "failed" && <button type="button" onClick={() => setAttempt((value) => value + 1)}>重试摘要</button>}
    <button type="button" aria-expanded={original} onClick={() => setOriginal(!original)}>{original ? "隐藏原文" : "查看原文"}</button>
    {original && <OriginalText text={output} output />}
  </div>;
}

function label(agent?: string): string {
  if (agent === "user" || agent === "input") return "用户";
  if (agent === "finish") return "结束";
  return agent === "main" ? "Main Agent" : agent ? `${agent} Agent` : "调度器";
}

function OriginalText({ text, output = false }: { text: string; output?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const content = previewText(text);
  const canExpand = content.length > 180 || content.split("\n").length > 4;
  return (
    <div className="execution-preview-original">
      {output && <small>Agent 输出原文 · 最多 1,000 字</small>}
      <p className={expanded ? "" : "execution-preview-clamped"}>{content}</p>
      {Array.from(text).length >= 1_000 && <small>仅展示前 1,000 字</small>}
      {canExpand && <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        {expanded ? "收起" : "展开原文"}
      </button>}
    </div>
  );
}

function title(step: ExecutionPreviewStep): string {
  if (step.heading) return step.heading;
  if (step.kind === "input") return "用户输入";
  if (step.kind === "agent") return label(step.agent);
  if (step.kind === "finish") return "流程完成";
  if (step.kind === "route") return `${label(step.source)} → ${label(step.target)}`;
  return step.target === "user" ? "请求用户补充" : "用户补充与回复";
}

const statusLabels = {
  running: "执行中",
  paused: "已暂停",
  stopping: "正在停止",
  stopped: "已停止",
  superseded: "已重新分配",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
  waiting: "状态待确认"
};

export function ExecutionPreview({ project, events, runtime }: {
  project: Project; events: AgentEvent[]; runtime: WorkflowRuntimeState;
}) {
  const steps = useMemo(() => buildExecutionPreview(project, events, runtime), [project, events, runtime]);
  const currentCollaboration = useMemo(() => {
    const progress = (project.orchestration.collaborations ?? [])
      .map((group) => collaborationProgress(project, group));
    return progress.find((item) => item.groupRun?.id === project.runtime?.groupRunId)
      ?? progress.find((item) => item.state !== "waiting" && item.state !== "completed");
  }, [project]);
  const listRef = useRef<HTMLOListElement>(null);
  const current = [...steps].reverse().find((step) => step.kind === "agent" && step.state === "running");
  const locate = () => {
    const target = listRef.current?.querySelector<HTMLElement>('[aria-current="step"]') ?? listRef.current?.lastElementChild;
    target?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  };
  return (
    <section className="execution-preview" aria-label="执行速览">
      <div className="execution-preview-toolbar">
        <div><strong>{current
          ? `当前：${label(current.agent)}`
          : project.status === "completed"
            ? "流程已完成"
            : currentCollaboration
              ? `${currentCollaboration.group.displayName}：${currentCollaboration.phaseLabel}`
              : runtime.queuedNodeId
                ? `等待：${label(runtime.queuedNodeId)}`
                : "关键执行轨迹"}</strong>
          <span>按实际执行顺序 · AI 摘要 · 实时更新</span></div>
        <button type="button" onClick={locate}><LocateFixed size={15} />定位{current ? "当前" : "最新"}</button>
      </div>
      <ol className="execution-preview-list" ref={listRef}>
        {steps.map((step, index) => (
          <li key={step.id} aria-current={current?.id === step.id ? "step" : undefined} className={`execution-preview-step execution-preview-${step.kind}`}>
            <div className="execution-preview-axis"><span>{index + 1}</span>{index < steps.length - 1 && <ArrowDown size={14} />}</div>
            <article>
              <header><strong>{step.url ? <a href={step.url} target="_blank" rel="noreferrer">{title(step)}</a> : title(step)}</strong><span>{step.state && <em data-state={step.state}>{statusLabels[step.state]}</em>}{step.ts && <time>{formatClock(step.ts)}</time>}</span></header>
              {step.kind === "input" && step.target && <small>传入 {label(step.target)}</small>}
              {step.kind === "route" && <small>调度记录{step.target === "finish" ? " · 请求结束流程" : step.target === "user" ? " · 等待用户回复" : " · 安排后续执行"}</small>}
              {step.kind === "commit" && step.commitSha && <small>Commit {step.commitSha.slice(0, 12)}{step.agent ? ` · Agent 作者：${step.agent}` : ""}</small>}
              {(step.kind === "pull_request" || step.kind === "merge") && <small>{step.source && step.target ? `${step.source} → ${step.target}` : "GitHub Pull Request"}{step.agent ? ` · Agent：${step.agent}` : ""}</small>}
              {step.text && <OriginalText text={step.text} />}
              {step.rationale && <div className="execution-preview-reason"><small>调度理由原文</small><OriginalText text={step.rationale} /></div>}
              {step.kind === "agent" && (step.output
                ? <OutputSummary key={`${project.id}/${step.invocationId}`} projectId={project.id} invocationId={step.invocationId} output={step.output} />
                : <p className="execution-preview-empty">{step.state === "running" ? "执行中，尚未提交输出。" : "暂无已保存的输出原文。"}</p>)}
              {Boolean(step.artifacts?.length) && <ul className="execution-preview-artifacts" aria-label="本次成果">{step.artifacts!.map((artifact, i) => <li key={`${artifact.path}-${i}`}>{artifact.title}<code>{artifact.path}</code></li>)}</ul>}
            </article>
          </li>
        ))}
      </ol>
    </section>
  );
}
