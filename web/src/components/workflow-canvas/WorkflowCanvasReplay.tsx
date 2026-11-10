import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Pause, Play, RotateCcw } from "lucide-react";
import { getWorkflowReplayConfigurationHistory, getWorkflowReplayEventPage } from "../../api";
import type { AgentEvent, Project } from "../../types";
import { buildLiveCanvasSnapshot, WorkflowCanvasLive } from "./WorkflowCanvasLive";
import { buildWorkflowReplay, workflowReplayTimes, WORKFLOW_REPLAY_ROOT_SCOPE } from "./core/workflow-replay";
import { runtimeNodeLabel } from "./core/workflow-runtime";
import { scopedGroupName } from "./core/scoped-runtime-view";
import { canvasContentBounds } from "./core/canvas-viewport";

export function WorkflowCanvasReplay({ project, onClose }: { project: Project; onClose: () => void }) {
  const sourceProject = useRef(project).current;
  const [history, setHistory] = useState<ReturnType<typeof buildWorkflowReplay>>();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [loadingCount, setLoadingCount] = useState(0);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(30_000);
  const [animate, setAnimate] = useState(false);
  const [scopeId, setScopeId] = useState<string>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const elapsed = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    setHistory(undefined); setError(""); setLoadingCount(0); setIndex(0); setPlaying(false);
    elapsed.current = 0;
    void (async () => {
      const first = await getWorkflowReplayEventPage(project.id, {}, controller.signal);
      const [configuration, loaded] = await Promise.all([
        getWorkflowReplayConfigurationHistory(project.id, controller.signal),
        (async () => {
          let page = first;
          const all = [...page.events];
          setLoadingCount(all.length);
          while (page.hasMore) {
            const before = page.events[0]?.seq;
            if (before === undefined) throw new Error("历史分页缺少事件游标，无法继续读取。");
            page = await getWorkflowReplayEventPage(project.id, { before, through: first.throughSeq }, controller.signal);
            if (page.events.some(event => event.seq >= before) || page.hasMore && !page.events.length)
              throw new Error("历史事件分页顺序异常，回顾已停止加载。");
            all.unshift(...page.events);
            if (!controller.signal.aborted) setLoadingCount(all.length);
          }
          return all;
        })()
      ]);
      if (controller.signal.aborted) return;
      const replay = buildWorkflowReplay(configuration, loaded);
      setEvents(loaded); setHistory(replay); setAnimate(false); setPlaying(replay.frames.length > 1);
    })().catch(reason => {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "历史回顾加载失败。");
        controller.abort();
      }
    });
    return () => controller.abort();
  }, [project.id, attempt]);

  const times = useMemo(() => workflowReplayTimes(history?.frames ?? [], duration), [history, duration]);
  useEffect(() => {
    if (!playing || !history) return;
    let handle = 0;
    const started = performance.now(), offset = elapsed.current;
    const tick = (now: number) => {
      elapsed.current = Math.min(duration, offset + now - started);
      let current = 0;
      while (current + 1 < times.length && times[current + 1]! <= elapsed.current) current++;
      setAnimate(true); setIndex(current);
      if (elapsed.current >= duration || current === history.frames.length - 1) setPlaying(false);
      else handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, history, duration, times]);

  const frame = history?.frames[index];
  const effectiveScope = scopeId && frame?.models[scopeId] ? scopeId : undefined;
  const model = frame?.models[effectiveScope ?? WORKFLOW_REPLAY_ROOT_SCOPE];
  const runtime = frame?.scopes[effectiveScope ?? WORKFLOW_REPLAY_ROOT_SCOPE];
  const historicalProject = useMemo<Project | undefined>(() => frame ? ({ ...sourceProject,
    orchestration: frame.orchestration, agents: frame.agents, workflowRevision: frame.revision,
    status: frame.status, cycle: frame.cycle, phase: "history", agentProgress: {},
    currentAgent: undefined, queuedAgent: undefined, activeInvocationId: undefined, activeNodeRunId: undefined,
    runtime: undefined, nodeRuns: [], groupRuns: [], scopedGroupRuns: [], scopedArrivals: [], scopedExecutions: [],
    executions: [], tasks: [], scopedAgentReports: [], scopedGroupIssues: [], scopedManagementTurns: [],
    loopBatches: {}, loopIterations: {}, loopTotalIterations: {}
  }) : undefined, [sourceProject, frame]);
  const frameEvents = useMemo(() => frame?.event ? events.filter(event => event.seq <= frame.event!.seq).slice(-100) : [], [events, frame]);
  const snapshot = useMemo(() => {
    if (!model || !runtime || !historicalProject || !frame) return undefined;
    const next = buildLiveCanvasSnapshot({ model, runtime, project: historicalProject, events: frameEvents,
      selectedNodeId, expandedGroupIds: expandedGroups, scopeId: effectiveScope });
    next.nodeStates = runtime.nodeStates;
    next.nodeLabels = Object.fromEntries(model.nodes.map(node => [node.id, runtimeNodeLabel(runtime.nodeStates[node.id])]));
    for (const node of next.workflow.nodes) if (node.groupId && node.members) {
      const groupRuntime = frame.scopes[node.groupId];
      node.members = node.members.map(member => ({ ...member,
        state: groupRuntime?.nodeStates[member.id] ?? "waiting",
        label: runtimeNodeLabel(groupRuntime?.nodeStates[member.id] ?? "waiting") }));
    }
    return next;
  }, [model, runtime, historicalProject, frame, frameEvents, selectedNodeId, expandedGroups, effectiveScope]);
  const overview = useMemo(() => {
    const models = new Set(history?.frames.map(entry => entry.models[effectiveScope ?? WORKFLOW_REPLAY_ROOT_SCOPE]));
    return canvasContentBounds([...models].flatMap(entry => entry?.nodes ?? []));
  }, [history, effectiveScope]);
  const playback = useMemo(() => frame ? ({ index, playing, reset: !animate, revision: frame.revision, change: frame.change, bounds: overview }) : undefined,
    [index, playing, animate, frame, overview]);
  const jump = useCallback((next: number) => {
    setPlaying(false); setAnimate(false); setIndex(next); elapsed.current = times[next] ?? 0;
  }, [times]);
  const restart = () => { jump(0); setPlaying(true); };
  const toggleGroup = useCallback((id: string) => setExpandedGroups(current => {
    const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next;
  }), []);

  if (error) return <div className="workflow-replay-message" role="alert"><strong>历史回顾加载失败</strong><p>{error}</p>
    <button type="button" onClick={() => setAttempt(value => value + 1)}>重新加载历史</button></div>;
  if (!history || !frame || !model || !runtime || !historicalProject || !snapshot)
    return <div className="workflow-replay-message" role="status">正在读取执行历史… 已读取 {loadingCount} 条事件</div>;
  if (history.frames.length === 1) return <div className="workflow-replay-message" role="status">暂无可回顾的执行记录。</div>;

  const completed = index === history.frames.length - 1 && !playing;
  return <section className="workflow-replay" aria-label="Workflow 历史回顾">
    <div className="workflow-replay-toolbar">
      <button type="button" onClick={() => completed ? restart() : setPlaying(!playing)} aria-label={playing ? "暂停历史回顾" : completed ? "重新播放历史回顾" : "继续历史回顾"}>
        {playing ? <Pause size={14} /> : <Play size={14} />}{playing ? "暂停" : completed ? "重新播放" : "播放"}
      </button>
      <button type="button" onClick={restart} aria-label="从头回顾"><RotateCcw size={14} />从头</button>
      <label>快速回顾<select aria-label="历史回顾时长" value={duration} onChange={event => {
        setDuration(Number(event.target.value)); elapsed.current = 0; setIndex(0); setAnimate(false);
      }}><option value={30000}>30 秒</option><option value={60000}>60 秒</option></select></label>
      <label className="workflow-replay-progress"><span>步骤 {index}/{history.frames.length - 1}</span>
        <input type="range" aria-label="历史回顾进度" min="0" max={history.frames.length - 1} value={index} onChange={event => jump(Number(event.target.value))} />
      </label>
      <span className="workflow-replay-clock">{frame.event ? new Date(frame.event.ts).toLocaleString() : "执行前"} · Workflow v{frame.revision}</span>
    </div>
    {history.notices.map(notice => <p className="workflow-replay-notice" key={notice}>{notice}</p>)}
    {effectiveScope && <nav className="scoped-breadcrumbs" aria-label="历史 Workflow 范围路径">
      <button type="button" onClick={() => setScopeId(frame.orchestration.scopedWorkflow?.groups.find(group => group.id === effectiveScope)?.parentGroupId)}><ArrowLeft size={14} />返回父图</button>
      <button type="button" onClick={() => setScopeId(undefined)}>项目</button><span>› {scopedGroupName(historicalProject, effectiveScope)}</span>
    </nav>}
    <div className="workflow-replay-canvas">
      <WorkflowCanvasLive project={historicalProject} model={model} runtime={runtime} events={frameEvents} snapshot={snapshot}
        playback={playback} title="历史 Workflow 大画布" scopeId={effectiveScope} selectedNodeId={selectedNodeId}
        expandedGroupIds={expandedGroups} onToggleGroup={toggleGroup} onNavigateGroup={id => { setScopeId(id); setSelectedNodeId(undefined); }}
        onSelectNode={node => setSelectedNodeId(node.id)} onClose={onClose} />
    </div>
    <div className="workflow-replay-caption" aria-live="polite">
      <strong>{completed ? "回顾已到达最后一条记录" : "历史回顾"}</strong><span>{frame.event?.message ?? "准备播放已保存的执行过程"}</span>
    </div>
  </section>;
}
