import { getProjectEventDetails } from "../api";
import { normalizeMarkdownMath } from "../markdown-math";
import {
  canonicalTraceEvent,
  isDiagnosticTraceEvent,
  isGatewayUsageTraceEvent,
  traceDataString,
  isHiddenReasoningTraceEvent,
  thoughtSummary,
  toolCommand,
  toolLabel,
  toolStatus,
  toolOutput,
  traceDetailParts,
  mergeCanonicalToolEvents,
  buildTraceEntries,
  type AgentActivityEntry,
  type AgentExecutionEntry,
  type TraceEntry
} from "../trace-model";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  Clock3,
  ChevronRight,
  CloudOff,
  Code2,
  FileText,
  Filter,
  GitBranch,
  LoaderCircle,
  MessageSquareText,
  Radio,
  RefreshCw,
  Search,
  TerminalSquare
} from "lucide-react";
import { AgentBadge, Button, EmptyState } from "../components/Common";
import { agentTemplateFor, formatClock, normalizeInvocationPerformance } from "../lib";
import type {
  AgentEvent,
  AgentName,
  ConnectionState,
  Project,
  LiveAssistantStream,
  InvocationPerformance
} from "../types";
import { PerformanceMetrics } from "../components/PerformanceMetrics";

const TRACE_DISPLAY_LIMITS = [100, 500, 1_000, 2_000, 5_000] as const;
type TraceDisplayLimit = (typeof TRACE_DISPLAY_LIMITS)[number];
export const DEFAULT_TRACE_DISPLAY_LIMIT: TraceDisplayLimit = 1_000;

function ConnectionBadge({ state }: { state: ConnectionState }) {
  const config = {
    live: { label: "实时连接", icon: <Radio size={13} /> },
    connecting: { label: "连接中", icon: <LoaderCircle className="spin" size={13} /> },
    reconnecting: {
      label: "正在重连",
      icon: <RefreshCw className="spin-slow" size={13} />
    },
    offline: { label: "连接断开", icon: <CloudOff size={13} /> }
  }[state];
  return (
    <span className={`connection-badge connection-${state}`}>
      {config.icon}
      {config.label}
    </span>
  );
}

function InvocationPerformanceReport({ performance }: { performance: InvocationPerformance }) {
  return (
    <div className="trace-performance" aria-label="单次调用性能">
      <PerformanceMetrics performance={performance} />
      <small>
        Attempt {performance.attempt + 1} · 输出 {performance.outputTokens.toLocaleString()} tokens ·
        {performance.tokenSource === "official" ? " Provider usage" : " 本地估算"}
        {performance.streaming ? " · 真实流式" : " · 缓冲/非流式"}
      </small>
    </div>
  );
}

function eventPresentation(event: AgentEvent): {
  title: string;
  icon: React.ReactNode;
  tone: string;
  diagnosticOnly?: true;
} {
  const type = event.type.toLowerCase();
  const traceKind =
    typeof event.data?.kind === "string" ? event.data.kind.toLowerCase() : "";
  const canonical = canonicalTraceEvent(event);
  if (isGatewayUsageTraceEvent(event)) {
    return { title: "网关 Token 计量", icon: <Activity size={16} />, tone: "neutral" };
  }
  if (type === "control.action.staged") {
    return { title: "操作待提交", icon: <Activity size={16} />, tone: "neutral" };
  }
  if (canonical?.kind === "diagnostic") {
    return { title: "运行诊断", icon: <Activity size={16} />, tone: "neutral" };
  }
  if (canonical?.kind.startsWith("tool.")) {
    return { title: "工具调用", icon: <TerminalSquare size={16} />, tone: "tool" };
  }
  if (canonical?.kind === "assistant.message" || canonical?.kind === "assistant.delta") {
    return { title: "Agent 过程文字", icon: <BrainCircuit size={16} />, tone: "neutral" };
  }
  if (type === "main.assignment.queued") {
    return { title: "Main 正在评估当前结果并决定下一步", icon: <GitBranch size={16} />, tone: "decision" };
  }
  if (type === "main.assignment.committed") {
    const target = traceDataString(event, "target");
    const message = event.message.toLowerCase();
    const title = target === "user" || message.includes("user intervention")
      ? "Main 正在等待用户处理"
      : target === "finish" || message.includes("completed")
        ? "Main 已确认项目完成"
        : `Main 已将下一步任务交给 ${target || "指定 Agent"}`;
    return { title, icon: <GitBranch size={16} />, tone: "decision" };
  }
  if (type === "workflow.reconfigured") {
    return { title: "Workflow 已重新配置", icon: <GitBranch size={16} />, tone: "decision" };
  }
  if (type === "workflow.tick") {
    return { title: "流程进展", icon: <Activity size={16} />, tone: "neutral" };
  }
  if (type.includes("error") || type.includes("failed")) {
    return { title: "运行异常", icon: <AlertTriangle size={16} />, tone: "error" };
  }
  if (type.includes("intervention")) {
    return {
      title: type.includes("answered") ? "用户已回复" : "等待用户介入",
      icon: <MessageSquareText size={16} />,
      tone: "decision"
    };
  }
  if (type.includes("user.input")) {
    return {
      title: type.includes("delivered")
        ? "用户需求已送达 main"
        : "用户新增科研需求",
      icon: <MessageSquareText size={16} />,
      tone: "decision"
    };
  }
  if (type.includes("artifact") || type.includes("file")) {
    return { title: "研究产物已写入", icon: <FileText size={16} />, tone: "artifact" };
  }
  if (traceKind === "stderr") {
    return { title: "运行诊断", icon: <AlertTriangle size={16} />, tone: "error" };
  }
  if (traceKind === "output" || type === "agent.output") {
    return { title: "智能体输出", icon: <Activity size={16} />, tone: "neutral" };
  }
  if (traceKind === "tool") {
    return { title: "工具调用", icon: <TerminalSquare size={16} />, tone: "tool" };
  }
  const lifecycleTitles: Record<string, string> = {
    "invocation.started": "Agent 本轮开始", "agent.started": "Agent 本轮开始",
    "collaboration.execution.started": "成员执行开始", "agent.execution.started": "成员执行开始",
    "invocation.completed": "Agent 本轮处理结束", "agent.completed": "Agent 本轮处理结束",
    "collaboration.execution.completed": "成员执行结束", "agent.execution.ended": "成员执行结束",
    "workflow.node.started": "Workflow 节点已激活", "workflow.node.completed": "Workflow 节点完成",
    "collaboration.group.started": "协作组开始", "collaboration.group.completed": "协作组完成",
    "session.started": "会话已建立", "iteration.started": "迭代开始",
    "project.completed": "项目已完成", "agent.interrupted": "Agent 本轮已中断"
  };
  if (lifecycleTitles[type]) {
    return { title: lifecycleTitles[type], icon: <Activity size={16} />, tone: "neutral" };
  }
  if (type.includes("tool")) {
    return { title: "工具调用", icon: <TerminalSquare size={16} />, tone: "tool" };
  }
  if (type.includes("decision") || type.includes("state")) {
    return { title: "流程安排更新", icon: <GitBranch size={16} />, tone: "decision" };
  }
  return { title: "运行记录", icon: <Activity size={16} />, tone: "neutral", diagnosticOnly: true };
}

function TraceDisclosure({
  projectId, events, className, icon, label, children
}: {
  projectId: string;
  events: AgentEvent[];
  className: string;
  icon: React.ReactNode;
  label: string;
  children: (events: AgentEvent[]) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; events?: Map<number, AgentEvent>; error?: true }>();
  const sequenceKey = [...new Set(events.flatMap(event => event.data?.traceDetailDeferred === true
    ? traceDetailParts(event).filter(part => part.data?.traceDetailDeferred === true).map(part => part.seq)
    : []))].sort((left, right) => left - right).join(",");
  const key = `${projectId}:${sequenceKey}:${retry}`;
  const current = result?.key === key ? result : undefined;
  const ready = current?.events;
  const failed = current?.error;
  useEffect(() => {
    if (!open || !sequenceKey || ready || failed) return;
    const controller = new AbortController();
    void getProjectEventDetails(projectId, sequenceKey.split(",").map(Number), controller.signal)
      .then(details => {
        if (!controller.signal.aborted) setResult({ key, events: new Map(details.map(event => [event.seq, event])) });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key, error: true });
      });
    return () => controller.abort();
  }, [failed, key, open, projectId, ready, sequenceKey]);

  return <details className={className} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="trace-disclosure-toggle">
      <ChevronRight size={14} className="trace-disclosure-chevron" aria-hidden="true" />
      {icon}<strong>{label}</strong><span>{events.length}</span>
    </summary>
    {!sequenceKey ? children(events) : open && (ready
      ? children(events.map(event => event.data?.traceDetailDeferred === true
        ? traceDetailParts(event).map(part => ready.get(part.seq) ?? part).reduce(mergeCanonicalToolEvents)
        : event))
      : failed
        ? <div className="trace-history-feedback" role="alert">详情加载失败 <Button variant="secondary" onClick={() => setRetry(value => value + 1)}>重试</Button></div>
        : <div className="trace-history-feedback" role="status">正在加载详情…</div>)}
  </details>;
}

export const AgentActivityCard = memo(function AgentActivityCard({
  entry,
  projectCycle,
  projectId
}: {
  entry: AgentActivityEntry;
  projectCycle: number;
  projectId?: string;
}) {
  const event = entry.thought ?? entry.event;
  const canonical = canonicalTraceEvent(event);
  const data = event.data ?? {};
  const cycle =
    typeof data.cycle === "number" || typeof data.cycle === "string"
      ? String(data.cycle)
      : String(projectCycle);
  const heading = entry.displayState === "streaming" ? "Agent 正在输出"
    : entry.contentKind === "summary" ? "可见思考摘要"
    : entry.displayState === "final"
      ? "Agent 最终结果"
      : entry.displayState === "incomplete"
        ? "Agent 未完成输出"
        : "Agent 过程文字";
  const thought = entry.thought
    ? thoughtSummary(entry.thought.message)
    : "";
  const streaming = entry.displayState === "streaming" && entry.contentKind !== "summary";
  const outputRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  useLayoutEffect(() => {
    const output = outputRef.current;
    if (output && followOutput.current) output.scrollTop = Math.max(0, output.scrollHeight - output.clientHeight);
    if (!streaming) followOutput.current = true;
  }, [streaming, thought]);
  return (
    <article className="trace-event trace-action-event" data-trace-message-seq={entry.thought?.seq}>
      <div className="trace-axis">
        <span><BrainCircuit size={16} /></span>
        <i />
      </div>
      <div className="trace-body">
        <div className="trace-meta">
          {event.agent && <AgentBadge name={event.agent} role={event.agent} subtle />}
          <time>{formatClock(event.ts)}</time>
          <span>Cycle {cycle}</span>
          {!event.data?.liveEphemeral && <span>#{event.seq}</span>}
          {canonical?.harnessId && <span className="trace-harness-tag">{canonical.harnessId}</span>}
        </div>
        <div className="agent-action-row">
          {thought && <section className="agent-thought-panel">
            <header>
              <BrainCircuit size={15} />
              <strong>{heading}</strong>
              {entry.displayState === "streaming" && <span className="agent-streaming-dot" />}
            </header>
            {entry.contentKind === "summary" ? (
              <details className="agent-visible-summary">
                <summary>阅读摘要</summary>
                <div className="agent-message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeSanitize, rehypeKatex]}>{normalizeMarkdownMath(thought)}</ReactMarkdown></div>
              </details>
            ) : (
              <div
                className={streaming ? "agent-message-markdown agent-streaming-output" : "agent-message-markdown"}
                ref={streaming ? outputRef : undefined}
                role={streaming ? "region" : undefined}
                aria-label={streaming ? "Agent 正在输出的正文" : undefined}
                tabIndex={streaming ? 0 : undefined}
                onScroll={streaming ? ({ currentTarget }) => {
                  followOutput.current = currentTarget.scrollHeight - currentTarget.clientHeight - currentTarget.scrollTop <= 8;
                } : undefined}
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeSanitize, rehypeKatex]}
                >
                  {normalizeMarkdownMath(thought)}
                </ReactMarkdown>
              </div>
            )}
            {canonical?.messageTruncated && (
              <div className="agent-message-truncated" role="note">
                正文展示已截断至 200,000 字符；完整内容已保存到同一调用的 Handoff，
                可从右侧评审卡或对应“交接已保存”轨迹进入。
              </div>
            )}
          </section>}
          {entry.tools.length > 0 && <TraceDisclosure projectId={projectId ?? event.projectId ?? ""} events={entry.tools}
            className="agent-tools-panel" label="工具调用" icon={<TerminalSquare size={15} aria-hidden="true" />}>
            {tools => (
              <div className="agent-tool-list" role="region" aria-label="工具调用列表" tabIndex={0}>
                {tools.map((tool, index) => {
                  const status = toolStatus(tool);
                  const result = toolOutput(tool);
                  const canonicalTool = canonicalTraceEvent(tool)?.tool;
                  const emptyResult = canonicalTool?.status === "completed" &&
                    canonicalTool.outputPreview === "" && !canonicalTool.truncated;
                  const command = canonicalTool?.name && canonicalTool.input === undefined
                    ? ""
                    : toolCommand(tool);
                  const label = toolLabel(tool);
                  const preview = (
                    <>
                      <strong title={label}>{label === "command_execution" ? "Shell 命令" : label}</strong>
                      <code>{command}</code>
                      <span className={`tool-status tool-status-${status.tone}`}>{status.label}</span>
                    </>
                  );
                  return (
                    <div className="agent-tool-item" key={canonicalTool?.callId ?? `${tool.seq}-${index}`} data-tool-status={canonicalTool?.status ?? status.tone}>
                      {command || result ? (
                        <details className="agent-tool-disclosure">
                          <summary className="agent-tool-preview">
                            <ChevronRight size={14} aria-hidden="true" />
                            {preview}
                          </summary>
                          <div className="agent-tool-content">
                            {command && <pre aria-label="工具输入">{command}</pre>}
                            {emptyResult && !result && <small>（空结果）</small>}
                            {result && (
                              <div className="agent-tool-output">
                                <strong>工具结果</strong>
                                {result.truncated && <small>已截断至 40,000 字符</small>}
                                <pre>{result.text}</pre>
                              </div>
                            )}
                          </div>
                        </details>
                      ) : <div className="agent-tool-preview">{preview}{emptyResult && <small>（空结果）</small>}</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </TraceDisclosure>}
        </div>
      </div>
    </article>
  );
}, (previous, next) => {
  if (previous.projectCycle !== next.projectCycle || previous.projectId !== next.projectId) return false;
  if (
    previous.entry.displayState !== next.entry.displayState ||
    previous.entry.contentKind !== next.entry.contentKind ||
    previous.entry.event.seq !== next.entry.event.seq ||
    previous.entry.thought?.seq !== next.entry.thought?.seq ||
    previous.entry.thought?.message !== next.entry.thought?.message ||
    previous.entry.tools.length !== next.entry.tools.length
  ) {
    return false;
  }
  return previous.entry.tools.every((tool, index) => {
    const nextTool = next.entry.tools[index]!;
    if (tool === nextTool) return true;
    if (tool.seq !== nextTool.seq || tool.message !== nextTool.message) return false;
    if (tool.data?.traceDetailDeferred || nextTool.data?.traceDetailDeferred) return false;
    const before = canonicalTraceEvent(tool)?.tool;
    const after = canonicalTraceEvent(nextTool)?.tool;
    return before?.name === after?.name && before?.status === after?.status &&
      before?.input === after?.input && before?.outputPreview === after?.outputPreview &&
      before?.truncated === after?.truncated && before?.isError === after?.isError;
  });
});

function AgentExecutionCard({ entry }: { entry: AgentExecutionEntry }) {
  const [now, setNow] = useState(Date.now());
  const active = entry.state === "waiting" || entry.state === "processing";
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  const titles = {
    waiting: "Agent 本轮开始", processing: "Agent 正在处理", completed: "Agent 本轮处理结束",
    failed: "Agent 本轮执行失败", interrupted: "Agent 本轮已中断", incomplete: "Agent 本轮处理未完成"
  };
  const agent = entry.event.agent ?? entry.event.agentId;
  const task = entry.updates.map(event => traceDataString(event, "assignedTask")).find(Boolean);
  const reason = traceDataString(entry.event, "reason") || traceDataString(entry.event, "triggerReason");
  const performances = useMemo(() => {
    const byAttempt = new Map<number, InvocationPerformance>();
    for (const { data } of entry.updates) {
      if (!data?.performance) continue;
      const sample = normalizeInvocationPerformance(data.performance);
      if (sample) byAttempt.set(sample.attempt, sample);
    }
    return Array.from(byAttempt.values());
  }, [entry.updates]);
  const duration = Math.max(0, Math.round(((active ? now : Date.parse(entry.updatedAt)) - Date.parse(entry.event.ts)) / 1000));
  return <article className={`trace-event trace-execution trace-${entry.state}`}>
    <div className="trace-axis"><span><Activity size={16} /></span><i /></div>
    <div className="trace-body">
      <div className="trace-meta"><time>{formatClock(entry.event.ts)}</time><span>最近活动 {formatClock(entry.updatedAt)}</span>
        {Number.isFinite(duration) && <span>{duration} 秒</span>}{agent && <AgentBadge role={agent} subtle />}</div>
      <div className="trace-title-row"><strong>{titles[entry.state]}</strong></div>
      {task && <p>{task}</p>}
      {reason && <p>唤醒原因：{reason}</p>}
      {performances.map(performance => <InvocationPerformanceReport key={performance.attempt} performance={performance} />)}
      {entry.updates.length > 0 && (
        <details className="trace-execution-details">
          <summary className="trace-disclosure-toggle">
            <ChevronRight size={14} className="trace-disclosure-chevron" aria-hidden="true" />
            <strong>本轮执行记录</strong><span>{entry.updates.length}</span>
          </summary>
          <ul aria-label="本轮执行记录">
            {entry.updates.map(event => (
              <li key={event.seq}><time>{formatClock(event.ts)}</time> · {event.type}{event.message && ` · ${event.message}`}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  </article>;
}

const EventCard = memo(function EventCard({ event, projectCycle }: { event: AgentEvent; projectCycle: number }) {
  const presentation = eventPresentation(event);
  const data = event.data ?? {};
  const detail =
    data.path ??
    data.tool ??
    data.toolName ??
    (event.type === "main.assignment.committed" ? data.target : undefined) ??
    data.band;
  const cycle =
    typeof data.cycle === "number" || typeof data.cycle === "string"
      ? String(data.cycle)
      : String(projectCycle);
  const performance = normalizeInvocationPerformance(data.performance);
  return (
    <article className={`trace-event trace-${presentation.tone}`}>
      <div className="trace-axis">
        <span>{presentation.icon}</span>
        <i />
      </div>
      <div className="trace-body">
        <div className="trace-meta">
          <time>{formatClock(event.ts)}</time>
          <span>Cycle {cycle}</span>
          {!event.data?.liveEphemeral && <span>#{event.seq}</span>}
        </div>
        <div className="trace-title-row">
          <strong>{presentation.title}</strong>
          {event.agent && <AgentBadge role={event.agent} subtle />}
        </div>
        <p>{event.message || "状态已更新，等待下一步调度。"}</p>
        {detail !== undefined && detail !== "" && (
          <span className="trace-detail">
            <Code2 size={13} />
            {String(detail)}
          </span>
        )}
        {performance && <InvocationPerformanceReport performance={performance} />}
      </div>
    </article>
  );
});

function liveAssistantEvent(stream: LiveAssistantStream, index: number): AgentEvent {
  const streaming = stream.phase === "streaming";
  return {
    seq: 9_000_000_000 + stream.attempt * 10_000 + index,
    type: "agent.trace",
    agent: stream.agent,
    message: stream.content,
    ts: stream.updatedAt,
    data: {
      kind: "message",
      invocationId: stream.invocationId,
      liveEphemeral: true,
      livePhase: stream.phase,
      liveRole: stream.role,
      canonicalEvent: {
        schemaVersion: 1,
        eventId: `${stream.invocationId}:live:${stream.attempt}:${stream.itemId}`,
        invocationId: stream.invocationId,
        harnessId: stream.harnessId,
        kind: streaming ? "assistant.delta" : "assistant.message",
        attempt: stream.attempt,
        itemId: stream.itemId,
        sourceType: "live.assistant",
        message: stream.content,
        ...(stream.truncated ? { messageTruncated: true } : {})
      }
    }
  };
}

function canScrollTraceHistory(container: HTMLElement | null, target: EventTarget | null): boolean {
  if (!container || container.scrollTop <= 0) return false;
  // Let an inner code/result panel consume its own scroll before treating
  // the gesture as navigation in the outer trace.
  for (let element = target instanceof Element ? target : null;
    element && element !== container; element = element.parentElement) {
    if (element.scrollHeight <= element.clientHeight) continue;
    const style = window.getComputedStyle(element);
    if (/^(auto|scroll)$/.test(style.overflowY) &&
      (element.scrollTop > 0 || /^(contain|none)$/.test(style.overscrollBehaviorY))) return false;
  }
  return true;
}

function artifactWritePath(event: AgentEvent): string {
  const artifact = event.data?.artifact as { path?: unknown } | undefined;
  const path = event.data?.path ?? artifact?.path;
  return typeof path === "string" && path ? path : event.message;
}

function ArtifactWriteGroup({ events, projectCycle }: { events: AgentEvent[]; projectCycle: number }) {
  const first = events[0]!;
  if (events.length === 1) return <EventCard event={first} projectCycle={projectCycle} />;
  const agent = first.agent ?? first.agentId;
  return (
    <article className="trace-event trace-artifact">
      <div className="trace-axis"><span><FileText size={16} /></span><i /></div>
      <div className="trace-body trace-artifact-group">
        <details>
          <summary className="trace-disclosure-toggle">
            <ChevronRight size={14} className="trace-disclosure-chevron" aria-hidden="true" />
            <strong>研究产物已写入</strong>
            <span>{events.length}</span>
            {agent && <span className="trace-artifact-agent"><AgentBadge role={agent} subtle /></span>}
          </summary>
          <div className="trace-artifact-list" role="region" aria-label="研究产物写入列表" tabIndex={0}>
            <ul>
              {events.map(event => (
                <li key={event.seq}>
                  <time dateTime={event.ts}>{formatClock(event.ts)}</time>
                  <span>#{event.seq}</span>
                  <span className="trace-artifact-path">{artifactWritePath(event)}</span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      </div>
    </article>
  );
}

export const TraceView = memo(function TraceView({
  events,
  liveStreams,
  liveEvents,
  project,
  connection,
  totalEventCount,
  hasOlder,
  historyLoading,
  historyError,
  onLoadOlder
}: {
  events: AgentEvent[];
  liveStreams: LiveAssistantStream[];
  liveEvents: AgentEvent[];
  project: Project;
  connection: ConnectionState;
  totalEventCount: number;
  hasOlder: boolean;
  historyLoading: boolean;
  historyError: string;
  onLoadOlder: (filters?: { agent?: string; keyword?: string }) => Promise<number | void>;
}) {
  const [agentFilter, setAgentFilter] = useState<"all" | AgentName>("all");
  const [displayLimit, setDisplayLimit] = useState<TraceDisplayLimit>(
    DEFAULT_TRACE_DISPLAY_LIMIT
  );
  const [search, setSearch] = useState("");
  const [historyCount, setHistoryCount] = useState<number>();
  const [historyBeforeSeq, setHistoryBeforeSeq] = useState<number>();
  const [extraHistory, setExtraHistory] = useState(0);
  const historyAnchor = useRef<{ node?: Element; position: number; height: number; beforeSeq?: number }>();
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const visibleLimit = displayLimit + extraHistory;
  const followRef = useRef(follow);
  const autoScrollRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);

  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  const keyword = search.trim().toLowerCase();
  const matchesTrace = useCallback((event: AgentEvent) =>
    !isHiddenReasoningTraceEvent(event) && (agentFilter === "all" || event.agent === agentFilter),
  [agentFilter]);
  const matchesMessageText = useCallback((event: AgentEvent) => {
    const text = thoughtSummary(event.message);
    return Boolean(text && (!keyword || text.toLowerCase().includes(keyword)));
  }, [keyword]);
  const matchingEvents = useMemo(() => events.filter(matchesTrace), [events, matchesTrace]);
  const matchingDiagnosticEvents = useMemo(
    () => matchingEvents.filter(isDiagnosticTraceEvent),
    [matchingEvents]
  );
  const matchingPrimaryEvents = useMemo(
    () => matchingEvents.filter((event) => !isDiagnosticTraceEvent(event)),
    [matchingEvents]
  );
  const diagnosticEvents = useMemo(
    () => matchingDiagnosticEvents.slice(-visibleLimit),
    [visibleLimit, matchingDiagnosticEvents]
  );
  const primaryEvents = useMemo(
    () => matchingPrimaryEvents.slice(-visibleLimit),
    [visibleLimit, matchingPrimaryEvents]
  );
  const liveAssistantEvents = useMemo(() => {
    return liveStreams
      .filter((stream) =>
        agentFilter === "all" || stream.agent === agentFilter
      )
      .map(liveAssistantEvent);
  }, [agentFilter, liveStreams]);
  const entries = useMemo(
    () => buildTraceEntries([
      ...primaryEvents,
      ...[...liveEvents.filter(event => matchesTrace(event) && !isDiagnosticTraceEvent(event)), ...liveAssistantEvents].sort((left, right) =>
        left.ts.localeCompare(right.ts) || left.seq - right.seq
      )
    ]),
    [liveAssistantEvents, liveEvents, matchesTrace, primaryEvents]
  );
  const timeline = useMemo(() => {
    if (keyword) return entries.filter(entry =>
      entry.kind === "activity" && entry.thought && matchesMessageText(entry.thought));
    type DiagnosticGroup = { kind: "diagnostics"; id: string; events: AgentEvent[] };
    type ArtifactGroup = { kind: "artifact-writes"; id: string; events: AgentEvent[] };
    const items = [
      ...entries.map(entry => ({
        event: entry.event,
        entry: entry.kind === "event" && eventPresentation(entry.event).diagnosticOnly ? undefined : entry
      })),
      ...diagnosticEvents.map(event => ({ event, entry: undefined })),
      ...liveEvents.filter(event => matchesTrace(event) && isDiagnosticTraceEvent(event))
        .map(event => ({ event, entry: undefined }))
    ].sort((left, right) =>
      left.event.ts.localeCompare(right.event.ts) || left.event.seq - right.event.seq
    );
    const groups: (TraceEntry | DiagnosticGroup | ArtifactGroup)[] = [];
    for (const { entry, event } of items) {
      const previous = groups.at(-1);
      if (entry?.kind === "event" && event.type === "artifact.published") {
        const first = previous?.kind === "artifact-writes" ? previous.events[0] : undefined;
        if (previous?.kind === "artifact-writes" && first &&
          (first.agent ?? first.agentId) === (event.agent ?? event.agentId) &&
          String(first.data?.cycle ?? "") === String(event.data?.cycle ?? "") &&
          (first.invocationId ?? first.data?.invocationId) === (event.invocationId ?? event.data?.invocationId) &&
          (first.executionId ?? first.data?.executionId) === (event.executionId ?? event.data?.executionId)) {
          previous.events.push(event);
        } else {
          groups.push({ kind: "artifact-writes", id: entry.id, events: [event] });
        }
        continue;
      }
      if (entry) {
        groups.push(entry);
        continue;
      }
      if (previous?.kind === "diagnostics") {
        previous.events.push(event);
      } else {
        groups.push({ kind: "diagnostics", id: `diagnostics-${event.seq}`, events: [event] });
      }
    }
    if (!extraHistory) return groups;
    const firstMessage = groups.findIndex(entry => entry.kind === "activity" &&
      entry.thought && matchesMessageText(entry.thought));
    return firstMessage > 0 ? groups.slice(firstMessage) : groups;
  }, [entries, diagnosticEvents, liveEvents, matchesTrace, keyword, matchesMessageText, extraHistory]);
  const earlierMessages = useMemo(() => {
    if (historyBeforeSeq === undefined) return [];
    return timeline.filter(entry => {
      const message = entry.kind === "activity" ? entry.thought : undefined;
      return message && !message.data?.liveEphemeral && message.seq < historyBeforeSeq && matchesMessageText(message);
    });
  }, [historyBeforeSeq, matchesMessageText, timeline]);
  const visibleEventCount = primaryEvents.length + diagnosticEvents.length;
  const latestVisibleSeq = Math.max(
    primaryEvents.at(-1)?.seq ?? 0,
    diagnosticEvents.at(-1)?.seq ?? 0
  );
  // The live snapshot is sorted by timestamp, but more than one invocation
  // can be active at once. Looking only at the last stream misses a delta
  // that belongs to an older stream, and live tool events are not streams at
  // all. Track a compact version of every live item so any visible update can
  // keep the viewport pinned while follow mode is enabled.
  const liveStreamVersion = liveStreams
    .map((stream) =>
      [
        stream.invocationId,
        stream.attempt,
        stream.itemId,
        stream.phase,
        stream.role,
        stream.updatedAt,
        stream.content.length
      ].join(":"))
    .join("|");
  const liveEventVersion = liveEvents
    .map((event) =>
      [event.seq, event.ts, event.type, event.message.length].join(":")
    )
    .join("|");

  const scrollToBottom = useCallback(() => {
    if (!followRef.current || !scrollRef.current) return;
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }

    autoScrollRef.current = true;
    let remainingFrames = 2;
    const settle = () => {
      const container = scrollRef.current;
      if (!container || !followRef.current) {
        autoScrollRef.current = false;
        scrollFrameRef.current = null;
        return;
      }

      container.scrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight
      );
      if (remainingFrames > 0) {
        remainingFrames -= 1;
        scrollFrameRef.current = window.requestAnimationFrame(settle);
        return;
      }

      // Markdown/content-visibility can settle one frame after React has
      // committed. Do one final bottom assignment before releasing the
      // programmatic scroll guard.
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        const latest = scrollRef.current;
        if (latest && followRef.current) {
          latest.scrollTop = Math.max(
            0,
            latest.scrollHeight - latest.clientHeight
          );
        }
        scrollFrameRef.current = null;
        autoScrollRef.current = false;
      });
    };

    scrollFrameRef.current = window.requestAnimationFrame(settle);
  }, []);

  const pauseFollowing = useCallback(() => {
    followRef.current = false;
    setFollow(false);
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    autoScrollRef.current = false;
  }, []);

  const pauseForHistoryNavigation = useCallback((target: EventTarget | null) => {
    if (followRef.current && canScrollTraceHistory(scrollRef.current, target)) pauseFollowing();
  }, [pauseFollowing]);

  const keepFollowingAfterLayoutScroll = useCallback(() => {
    const container = scrollRef.current;
    // Focus restoration, scroll anchoring and viewport/content resizing also
    // emit scroll events. Only explicit navigation gestures may pause follow.
    if (!container || autoScrollRef.current || !followRef.current) return;
    if (container.scrollHeight - container.scrollTop - container.clientHeight > 1) scrollToBottom();
  }, [scrollToBottom]);

  const toggleFollow = useCallback(() => {
    setFollow((current) => {
      const next = !current;
      followRef.current = next;
      return next;
    });
  }, []);

  const hasBufferedHistory = matchingPrimaryEvents.length > visibleLimit || matchingDiagnosticEvents.length > visibleLimit;
  const loadEarlier = async () => {
    const container = scrollRef.current;
    if (!container || historyLoading || historyAnchor.current) return;
    const top = container.getBoundingClientRect().top;
    const node = Array.from(container.querySelector(".trace-list")?.children ?? [])
      .find(child => child.getBoundingClientRect().bottom > top);
    const beforeSeq = events[0]?.seq;
    historyAnchor.current = {
      node, position: node ? node.getBoundingClientRect().top - top + container.scrollTop : 0,
      height: container.scrollHeight, beforeSeq: hasBufferedHistory ? undefined : beforeSeq
    };
    pauseFollowing();
    setHistoryCount(undefined);
    setHistoryBeforeSeq(undefined);
    const count = hasBufferedHistory
      ? Math.min(200, Math.max(matchingPrimaryEvents.length, matchingDiagnosticEvents.length) - visibleLimit)
      : await onLoadOlder({ agent: agentFilter === "all" ? undefined : agentFilter, keyword: keyword || undefined });
    if (count === undefined) return;
    if (count > 0) {
      setExtraHistory(current => hasBufferedHistory ? current + count : Math.max(current + count, events.length + count - displayLimit));
    }
    setHistoryCount(count);
    setHistoryBeforeSeq(beforeSeq);
  };

  useLayoutEffect(() => {
    const anchor = historyAnchor.current;
    const container = scrollRef.current;
    if (!anchor || !container) return;
    if (historyError) { historyAnchor.current = undefined; return; }
    if (historyCount === undefined && !(anchor.beforeSeq !== undefined && events[0] && events[0].seq < anchor.beforeSeq)) return;
    historyAnchor.current = undefined;
    if (anchor.node?.isConnected) {
      container.scrollTop += anchor.node.getBoundingClientRect().top -
        container.getBoundingClientRect().top + container.scrollTop - anchor.position;
    } else {
      container.scrollTop += Math.max(0, container.scrollHeight - anchor.height);
    }
  }, [events, historyCount, historyError, extraHistory]);

  useEffect(() => {
    if (historyCount === undefined) return;
    const timeout = window.setTimeout(() => setHistoryCount(undefined), 6_000);
    return () => window.clearTimeout(timeout);
  }, [historyCount]);

  useEffect(() => {
    if (!follow) {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
      autoScrollRef.current = false;
      return;
    }
    if (!timeline.length) return;
    scrollToBottom();
  }, [
    agentFilter,
    diagnosticEvents.length,
    displayLimit,
    entries.length,
    follow,
    liveEventVersion,
    liveStreamVersion,
    latestVisibleSeq,
    search,
    scrollToBottom,
    timeline.length
  ]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      scrollFrameRef.current = null;
      autoScrollRef.current = false;
    };
  }, []);

  useEffect(() => {
    // ResizeObserver catches the delayed height change caused by streamed
    // Markdown and `content-visibility`, which can happen after the React
    // commit/effect that scheduled the initial scroll. Observe the viewport
    // too: opening a dialog or resizing the page can change its dimensions.
    const container = scrollRef.current;
    const content = container?.querySelector<HTMLElement>(".trace-list");
    if (!container || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followRef.current) scrollToBottom();
    });
    observer.observe(content);
    observer.observe(container);
    return () => observer.disconnect();
  }, [
    entries.length,
    diagnosticEvents.length,
    liveEventVersion,
    liveStreamVersion,
    scrollToBottom
  ]);

  const loadedHistorySuffix =
    totalEventCount > events.length
      ? ` · 已加载 ${events.length.toLocaleString()} / 全部 ${totalEventCount.toLocaleString()}`
      : "";
  const allEventsSuffix =
    matchingEvents.length !== events.length
      ? ` · 当前已加载范围 ${events.length.toLocaleString()}`
      : loadedHistorySuffix;
  const eventCountLabel =
    keyword ? `${timeline.length.toLocaleString()} 条 Agent 消息` :
    matchingEvents.length > visibleEventCount
      ? `显示最新 ${visibleEventCount.toLocaleString()} / ${matchingEvents.length.toLocaleString()} 条${allEventsSuffix}`
      : `${visibleEventCount.toLocaleString()} 条事件${allEventsSuffix}`;

  return (
    <div className="trace-view">
      <div className="trace-toolbar">
        <div className="trace-status">
          <ConnectionBadge state={connection} />
          <span>{eventCountLabel}</span>
        </div>
        <div className="trace-tools">
          <label className="compact-search">
            <Search size={15} />
            <input
              value={search}
              onChange={(event) => {
                setHistoryBeforeSeq(undefined);
                setHistoryCount(undefined);
                setSearch(event.target.value);
              }}
              disabled={historyLoading}
              placeholder="搜索 Agent 消息"
              maxLength={300}
            />
          </label>
          <label className="compact-select">
            <Filter size={14} />
            <select
              value={agentFilter}
              onChange={(event) => {
                setHistoryBeforeSeq(undefined);
                setHistoryCount(undefined);
                setAgentFilter(event.target.value as "all" | AgentName);
              }}
              disabled={historyLoading}
              aria-label="按智能体筛选"
            >
              <option value="all">全部 Agent</option>
              {project.orchestration.agents.map((definition) => (
                <option value={definition.name} key={definition.name}>
                  {definition.name} · {agentTemplateFor(project.orchestration, definition.name)}
                </option>
              ))}
              {[...new Set((project.archivedAgentSessions ?? []).map(entry => entry.agentId))]
                .filter(agent => !project.orchestration.agents.some(definition => definition.name === agent))
                .map(agent => <option value={agent} key={agent}>{agent} · 已退役{project.archivedAgentSessions?.some(entry => entry.agentId === agent && entry.sessionCount > 0) ? "（原会话保留）" : ""}</option>)}
            </select>
          </label>
          <label
            className="compact-select trace-limit-select"
            title="控制前端显示的最新轨迹条数"
          >
            <Clock3 size={14} />
            <select
              value={displayLimit}
              disabled={historyLoading}
              onChange={(event) => {
                setExtraHistory(0);
                setHistoryCount(undefined);
                setHistoryBeforeSeq(undefined);
                setDisplayLimit(
                  Number(event.target.value) as TraceDisplayLimit
                );
              }}
              aria-label="显示最新轨迹条数"
            >
              {TRACE_DISPLAY_LIMITS.map((limit) => (
                <option value={limit} key={limit}>
                  最新 {limit.toLocaleString()} 条
                </option>
              ))}
            </select>
          </label>
          <button
            className={`follow-button ${follow ? "active" : ""}`}
            onClick={toggleFollow}
            aria-pressed={follow}
            title="自动跟随最新事件"
          >
            <Radio size={14} />
            跟随
          </button>
        </div>
      </div>
      {(hasOlder || hasBufferedHistory || historyError) && (
        <div className="trace-history-loader">
          <Button variant="ghost" disabled={historyLoading} onClick={() => void loadEarlier()}>
            查找更早正文
          </Button>
        </div>
      )}
      {historyError && <div className="trace-history-feedback" role="alert">{historyError}</div>}
      {(historyLoading || historyCount !== undefined) && (
        <div className="trace-history-feedback" role="status">
          {historyLoading ? "正在查找更早的正文…" :
            earlierMessages.length ? `找到 ${earlierMessages.length.toLocaleString()} 条更早的 Agent 消息` :
              hasOlder ? "这批记录中没有匹配的正文" : "没有更早的匹配消息"}
        </div>
      )}
      <div
        className="trace-scroll"
        ref={scrollRef}
        role="region"
        aria-label="实时轨迹内容"
        tabIndex={0}
        onScroll={keepFollowingAfterLayoutScroll}
        onWheel={(event) => {
          if (!event.defaultPrevented && !event.ctrlKey && event.deltaY < 0) pauseForHistoryNavigation(event.target);
        }}
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.altKey || event.metaKey ||
            (event.target instanceof Element && event.target.closest("input, textarea, select, button, a, summary, [contenteditable]:not([contenteditable='false'])"))) return;
          if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) pauseForHistoryNavigation(event.target);
        }}
        onTouchStart={(event) => { touchStartYRef.current = event.touches.length === 1 ? event.touches[0]?.clientY ?? null : null; }}
        onTouchMove={(event) => {
          if (event.touches.length !== 1) { touchStartYRef.current = null; return; }
          const currentY = event.touches[0]?.clientY;
          if (!event.defaultPrevented && currentY !== undefined && touchStartYRef.current !== null &&
            currentY > touchStartYRef.current + 4) pauseForHistoryNavigation(event.target);
        }}
        onTouchEnd={() => { touchStartYRef.current = null; }}
        onTouchCancel={() => { touchStartYRef.current = null; }}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.pointerType !== "mouse" || event.target !== event.currentTarget) return;
          const container = event.currentTarget, bounds = container.getBoundingClientRect();
          const gutter = Math.max(12, container.offsetWidth - container.clientWidth);
          if (bounds.width > 0 && container.scrollHeight > container.clientHeight &&
            event.clientX >= bounds.right - gutter && followRef.current) pauseFollowing();
        }}
      >
        {timeline.length ? (
          <div className="trace-list">
            {timeline.map((entry) => (
              entry.kind === "diagnostics" ? (
                <TraceDisclosure projectId={project.id} events={entry.events} className="trace-diagnostics"
                  label="运行诊断" icon={<Activity size={15} aria-hidden="true" />} key={entry.id}>
                  {diagnostics => (
                  <div className="trace-diagnostic-list" role="region" aria-label="运行诊断列表" tabIndex={0}>
                    {diagnostics.map(event => (
                      <EventCard event={event} projectCycle={project.cycle} key={event.seq} />
                    ))}
                  </div>
                  )}
                </TraceDisclosure>
              ) :
              entry.kind === "artifact-writes" ? (
                <ArtifactWriteGroup events={entry.events} projectCycle={project.cycle} key={entry.id} />
              ) : entry.kind === "activity" ? (
                <AgentActivityCard
                  entry={entry}
                  projectId={project.id}
                  projectCycle={project.cycle}
                  key={entry.id}
                />
              ) : entry.kind === "execution" ? <AgentExecutionCard entry={entry} key={entry.id} /> : (
                <EventCard
                  event={entry.event}
                  projectCycle={project.cycle}
                  key={entry.id}
                />
              )
            ))}
            {connection === "live" && project.status === "running" && (
              <div className="trace-waiting">
                <span><i /><i /><i /></span>
                等待智能体的下一条更新
              </div>
            )}
          </div>
        ) : (
          <EmptyState
            icon={<Activity size={27} />}
            title={events.length ? "没有匹配的轨迹" : "等待第一条 Agent 轨迹"}
            description={
              events.length
                ? "调整搜索词或 Agent 筛选条件。"
                : "项目启动后，Idea Agent 的动作会实时出现在这里。"
            }
          />
        )}
      </div>
    </div>
  );
});
