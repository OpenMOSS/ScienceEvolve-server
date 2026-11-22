import {
  canonicalTraceEvent,
  isDiagnosticTraceEvent,
  traceDataString,
  isHiddenReasoningTraceEvent,
  thoughtSummary,
  toolCommand,
  toolLabel,
  toolStatus,
  toolOutput,
  buildTraceEntries,
  type AgentActivityEntry,
  type AgentExecutionEntry
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
} {
  const type = event.type.toLowerCase();
  const traceKind =
    typeof event.data?.kind === "string" ? event.data.kind.toLowerCase() : "";
  const canonical = canonicalTraceEvent(event);
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
  if (traceKind === "output") {
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
  return { title: "过程更新", icon: <Activity size={16} />, tone: "neutral" };
}

export const AgentActivityCard = memo(function AgentActivityCard({
  entry,
  projectCycle
}: {
  entry: AgentActivityEntry;
  projectCycle: number;
}) {
  const event = entry.thought ?? entry.event;
  const canonical = canonicalTraceEvent(event);
  const data = event.data ?? {};
  const cycle =
    typeof data.cycle === "number" || typeof data.cycle === "string"
      ? String(data.cycle)
      : String(projectCycle);
  const heading = entry.contentKind === "summary" ? "可见思考摘要" : entry.displayState === "streaming"
    ? "Agent 正在输出"
    : entry.displayState === "final"
      ? "Agent 最终结果"
      : entry.displayState === "incomplete"
        ? "Agent 未完成输出"
        : "Agent 过程文字";
  const thought = entry.thought
    ? thoughtSummary(entry.thought.message)
    : "";
  return (
    <article className="trace-event trace-action-event">
      <div className="trace-axis">
        <span><BrainCircuit size={16} /></span>
        <i />
      </div>
      <div className="trace-body">
        <div className="trace-meta">
          <time>{formatClock(event.ts)}</time>
          <span>Cycle {cycle}</span>
          <span>#{event.seq}</span>
          {canonical?.harnessId && <span className="trace-harness-tag">{canonical.harnessId}</span>}
          {event.agent && <AgentBadge role={event.agent} subtle />}
        </div>
        <div className={`agent-action-row${!thought || !entry.tools.length ? " is-single-panel" : ""}`}>
          {thought && <section className="agent-thought-panel">
            <header>
              <BrainCircuit size={15} />
              <strong>{heading}</strong>
              {entry.displayState === "streaming" && <span className="agent-streaming-dot" />}
            </header>
            {entry.contentKind === "summary" ? (
              <details className="agent-visible-summary">
                <summary>阅读摘要</summary>
                <div className="agent-message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeSanitize, rehypeKatex]}>{thought}</ReactMarkdown></div>
              </details>
            ) : entry.displayState === "streaming" ? (
              <p className="agent-streaming-text">{thought}</p>
            ) : (
              <div className="agent-message-markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeSanitize, rehypeKatex]}
                >
                  {thought}
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
          {entry.tools.length > 0 && <section className="agent-tools-panel">
            <header>
              <TerminalSquare size={15} />
              <strong>工具调用</strong>
              <span>{entry.tools.length}</span>
            </header>
              <div className="agent-tool-list">
                {entry.tools.map((tool, index) => {
                  const status = toolStatus(tool);
                  const command = toolCommand(tool);
                  const result = toolOutput(tool);
                  const canonicalTool = canonicalTraceEvent(tool)?.tool;
                  const emptyResult = canonicalTool?.status === "completed" &&
                    canonicalTool.outputPreview === "" && !canonicalTool.truncated;
                  return (
                    <div className="agent-tool-item" key={canonicalTool?.callId ?? `${tool.seq}-${index}`} data-tool-status={canonicalTool?.status ?? status.tone}>
                      <div>
                        <strong>{toolLabel(tool)}</strong>
                        <span className={`tool-status tool-status-${status.tone}`}>
                          {status.label}
                        </span>
                      </div>
                      <code title={command}>{command || "等待工具详情"}</code>
                      {result ? (
                        <details className="agent-tool-result">
                          <summary>
                            查看工具结果
                            {result.truncated && <span>已截断至 40,000 字符</span>}
                          </summary>
                          <pre>{result.text}</pre>
                        </details>
                      ) : emptyResult && (
                        <small className="agent-tool-result">（空结果）</small>
                      )}
                    </div>
                  );
                })}
              </div>
          </section>}
        </div>
      </div>
    </article>
  );
}, (previous, next) => {
  if (previous.projectCycle !== next.projectCycle) return false;
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
      {entry.updates.length > 0 && <details className="trace-execution-details"><summary>本轮执行记录 · {entry.updates.length}</summary>
        {entry.updates.map(event => <p key={event.seq}><time>{formatClock(event.ts)}</time> · {event.type}{event.message && ` · ${event.message}`}</p>)}
      </details>}
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
          <span>#{event.seq}</span>
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
    if (element.scrollTop > 0 && element.scrollHeight > element.clientHeight &&
      /^(auto|scroll)$/.test(window.getComputedStyle(element).overflowY)) return false;
  }
  return true;
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
  onLoadOlder: () => Promise<void>;
}) {
  const [agentFilter, setAgentFilter] = useState<"all" | AgentName>("all");
  const [displayLimit, setDisplayLimit] = useState<TraceDisplayLimit>(
    DEFAULT_TRACE_DISPLAY_LIMIT
  );
  const [search, setSearch] = useState("");
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [extraHistory, setExtraHistory] = useState(0);
  const visibleLimit = displayLimit + extraHistory;
  const anchor = useRef<{ element: Element; position: number; beforeSeq?: number }>();
  const followRef = useRef(follow);
  const autoScrollRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);

  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  const matchingEvents = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return events.filter(
      (event) =>
        !isHiddenReasoningTraceEvent(event) &&
        (agentFilter === "all" || event.agent === agentFilter) &&
        (!keyword ||
          event.message.toLowerCase().includes(keyword) ||
          event.type.toLowerCase().includes(keyword))
    );
  }, [agentFilter, events, search]);
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
    const keyword = search.trim().toLowerCase();
    return liveStreams
      .filter((stream) =>
        (agentFilter === "all" || stream.agent === agentFilter) &&
        (!keyword || stream.content.toLowerCase().includes(keyword))
      )
      .map(liveAssistantEvent);
  }, [agentFilter, liveStreams, search]);
  const entries = useMemo(
    () => buildTraceEntries([
      ...primaryEvents,
      ...[...liveEvents, ...liveAssistantEvents].sort((left, right) =>
        left.ts.localeCompare(right.ts) || left.seq - right.seq
      )
    ]),
    [liveAssistantEvents, liveEvents, primaryEvents]
  );
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
  function readEarlier() {
    if (historyLoading) return;
    pauseFollowing();
    const container = scrollRef.current;
    if (container) {
      const top = container.getBoundingClientRect().top;
      const first = Array.from(container.querySelectorAll(".trace-list > article")).find(row => row.getBoundingClientRect().bottom > top);
      if (first) anchor.current = { element: first, position: first.getBoundingClientRect().top - top + container.scrollTop,
        beforeSeq: hasBufferedHistory ? undefined : events[0]?.seq };
    }
    setExtraHistory(count => count + 200);
    if (!hasBufferedHistory) void onLoadOlder();
  }
  useLayoutEffect(() => {
    const saved = anchor.current, container = scrollRef.current;
    if (!saved || !container || !saved.element.isConnected) return;
    const top = container.getBoundingClientRect().top;
    const position = saved.element.getBoundingClientRect().top - top + container.scrollTop;
    container.scrollTop += position - saved.position;
    saved.position = position;
    if (saved.beforeSeq === undefined || (events[0] && events[0].seq < saved.beforeSeq) || historyError || !hasOlder) anchor.current = undefined;
  }, [visibleLimit, events, historyError, hasOlder]);

  useEffect(() => {
    if (!follow) {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
      autoScrollRef.current = false;
      return;
    }
    if (!entries.length && !diagnosticEvents.length) return;
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
    scrollToBottom
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
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索轨迹"
            />
          </label>
          <label className="compact-select">
            <Filter size={14} />
            <select
              value={agentFilter}
              onChange={(event) =>
                setAgentFilter(event.target.value as "all" | AgentName)
              }
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
              onChange={event => {
                setExtraHistory(0);
                setDisplayLimit(Number(event.target.value) as TraceDisplayLimit);
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
          {(hasOlder || hasBufferedHistory) && (
            <Button
              variant="ghost"
              loading={historyLoading}
              onClick={readEarlier}
            >
              加载更早轨迹
            </Button>
          )}
          {historyError && <span role="alert">{historyError}</span>}
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
        {entries.length || diagnosticEvents.length ? (
          <div className="trace-list">
            {entries.map((entry) => (
              entry.kind === "activity" ? (
                <AgentActivityCard
                  entry={entry}
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
            {diagnosticEvents.length > 0 && (
              <details className="trace-diagnostics">
                <summary>
                  <Activity size={14} />
                  运行诊断
                  <span>{diagnosticEvents.length}</span>
                </summary>
                <div className="trace-diagnostic-list">
                  {diagnosticEvents.map((event) => (
                    <EventCard
                      event={event}
                      projectCycle={project.cycle}
                      key={`diagnostic-${event.seq}`}
                    />
                  ))}
                </div>
              </details>
            )}
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
