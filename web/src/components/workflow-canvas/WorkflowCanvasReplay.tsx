import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Pause, Play, RotateCcw } from "lucide-react";
import { getWorkflowReplayConfigurationHistory, getWorkflowReplayEventPage } from "../../api";
import type { Project } from "../../types";
import { RuntimeCanvasSurface } from "./RuntimeCanvasSurface";
import { useCanvasRouting } from "./useCanvasRouting";
import { buildWorkflowReplay, workflowReplayTimes, WORKFLOW_REPLAY_ROOT_SCOPE } from "./core/workflow-replay";
import { runtimeNodeLabel } from "./core/workflow-runtime";
import { scopedGroupName } from "./core/scoped-runtime-view";
import { adaptWorkflowToCanvas } from "./core/canvas-adapter";
import { scopedCanvasPlanningOrchestration } from "./core/scoped-canvas-layout";
import { defaultScopedCanvas } from "./core/scoped-workflow";
import { canvasContentBounds } from "./core/canvas-viewport";
import { CANVAS_NODE_HEIGHT, CANVAS_NODE_WIDTH, type CanvasModel } from "./core/canvas-model";

function compactReplayAxis(values: number[], maxGap: number): Map<number, number> {
  const positions = new Map<number, number>();
  let previous = Math.min(...values);
  let removed = 0;
  for (const value of [...new Set(values)].sort((a, b) => a - b)) {
    removed += Math.max(0, value - previous - maxGap);
    positions.set(value, value - removed);
    previous = value;
  }
  return positions;
}

function replayPresentation(model: CanvasModel, current?: CanvasModel): CanvasModel {
  if (current) {
    const positions = current.presentationLayout.nodes;
    const currentEdges = new Map(current.edges.map(edge => [edge.id, edge]));
    const bounds = canvasContentBounds(current.nodes)!;
    const stepX = CANVAS_NODE_WIDTH + 68;
    const columns = Math.max(1, Math.floor((bounds.maxX - bounds.minX) / stepX));
    let archived = 0;
    const nodes = model.nodes.map(node => {
      const position = Object.hasOwn(positions, node.id) ? positions[node.id] : undefined;
      if (position) return { ...node, ...position };
      const index = archived++;
      return { ...node, x: bounds.minX + (index % columns) * stepX,
        y: bounds.maxY + 120 + Math.floor(index / columns) * (CANVAS_NODE_HEIGHT + 68) };
    });
    const edges = model.edges.map(edge => {
      const reference = currentEdges.get(edge.id);
      if (!reference || reference.source !== edge.source || reference.target !== edge.target || reference.kind !== edge.kind) return edge;
      const { sourcePort, targetPort, sourcePortPinned, targetPortPinned } = reference;
      return { ...edge, sourcePort, targetPort, sourcePortPinned, targetPortPinned };
    });
    return { ...model, nodes, edges };
  }
  const xs = compactReplayAxis(model.nodes.map(node => node.x), CANVAS_NODE_WIDTH + 136);
  const ys = compactReplayAxis(model.nodes.map(node => node.y), CANVAS_NODE_HEIGHT + 136);
  const nodes = model.nodes.map(node => ({ ...node, x: xs.get(node.x)!, y: ys.get(node.y)! }));
  return { ...model, nodes };
}

export function WorkflowCanvasReplay({ project }: { project: Project; onClose: () => void }) {
  const sourceProject = useRef(project).current;
  const [history, setHistory] = useState<ReturnType<typeof buildWorkflowReplay>>();
  const [loadingCount, setLoadingCount] = useState(0);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(30_000);
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
      setHistory(replay); setPlaying(replay.frames.length > 1);
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
      setIndex(current);
      if (elapsed.current >= duration || current === history.frames.length - 1) setPlaying(false);
      else handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, history, duration, times]);

  const frame = history?.frames[index];
  const effectiveScope = scopeId && frame?.models[scopeId] ? scopeId : undefined;
  const historicalModel = frame?.models[effectiveScope ?? WORKFLOW_REPLAY_ROOT_SCOPE];
  const currentLayout = useMemo(() => {
    if (!effectiveScope) return adaptWorkflowToCanvas(project.orchestration);
    const group = project.orchestration.scopedWorkflow?.groups.find(entry => entry.id === effectiveScope);
    if (!group) return undefined;
    const { workflow } = group;
    const layout = workflow.canvas ?? defaultScopedCanvas(workflow.nodes.map(node => node.nodeId), workflow.input.edges.map(edge => edge.target));
    return adaptWorkflowToCanvas(scopedCanvasPlanningOrchestration(workflow), layout);
  }, [effectiveScope, project.orchestration]);
  const model = useMemo(() => historicalModel && replayPresentation(historicalModel, currentLayout), [historicalModel, currentLayout]);
  const runtime = frame?.scopes[effectiveScope ?? WORKFLOW_REPLAY_ROOT_SCOPE];
  const historicalProject = useMemo<Project | undefined>(() => frame ? ({ ...sourceProject,
    orchestration: frame.orchestration, agents: frame.agents, workflowRevision: frame.revision,
    status: frame.status, cycle: frame.cycle, phase: "history", agentProgress: {},
    currentAgent: undefined, queuedAgent: undefined, activeInvocationId: undefined, activeNodeRunId: undefined,
    runtime: undefined, nodeRuns: [], groupRuns: [], scopedGroupRuns: [], scopedArrivals: [], scopedExecutions: [],
    executions: [], tasks: [], scopedAgentReports: [], scopedGroupIssues: [], scopedManagementTurns: [],
    loopBatches: {}, loopIterations: {}, loopTotalIterations: {}
  }) : undefined, [sourceProject, frame]);
  const { geometry } = useCanvasRouting(model?.edges ?? [], model?.nodes ?? [], { enabled: Boolean(model) });
  const overview = useMemo(() => model && canvasContentBounds(model.nodes), [model]);
  const jump = useCallback((next: number) => {
    setPlaying(false); setIndex(next); elapsed.current = times[next] ?? 0;
  }, [times]);
  const restart = () => { jump(0); setPlaying(true); };
  const toggleGroup = useCallback((id: string) => setExpandedGroups(current => {
    const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next;
  }), []);

  if (error) return <div className="workflow-replay-message" role="alert"><strong>历史回顾加载失败</strong><p>{error}</p>
    <button type="button" onClick={() => setAttempt(value => value + 1)}>重新加载历史</button></div>;
  if (!history || !frame || !model || !runtime || !historicalProject)
    return <div className="workflow-replay-message" role="status">正在读取执行历史… 已读取 {loadingCount} 条事件</div>;
  if (history.frames.length === 1) return <div className="workflow-replay-message" role="status">暂无可回顾的执行记录。</div>;

  const completed = index === history.frames.length - 1 && !playing;
  const selectedNode = model.nodes.find(node => node.id === selectedNodeId);
  const groupId = selectedNode?.collaboration?.id;
  const canEnter = groupId && !!frame.models[groupId];
  return <section className="workflow-replay" aria-label="Workflow 历史回顾">
    <div className="workflow-replay-toolbar">
      <button type="button" onClick={() => completed ? restart() : setPlaying(!playing)} aria-label={playing ? "暂停历史回顾" : completed ? "重新播放历史回顾" : "继续历史回顾"}>
        {playing ? <Pause size={14} /> : <Play size={14} />}{playing ? "暂停" : completed ? "重新播放" : "播放"}
      </button>
      <button type="button" onClick={restart} aria-label="从头回顾"><RotateCcw size={14} />从头</button>
      <label>快速回顾<select aria-label="历史回顾时长" value={duration} onChange={event => {
        setDuration(Number(event.target.value)); elapsed.current = 0; setIndex(0);
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
      <RuntimeCanvasSurface key={effectiveScope ?? "root"} project={historicalProject} model={model} geometry={geometry} runtime={runtime}
        mode="modal" replay fitBounds={overview} scopeId={effectiveScope} selectedNodeId={selectedNode?.id}
        expandedGroupIds={expandedGroups} onToggleGroup={toggleGroup} onSelectNode={node => { setPlaying(false); setSelectedNodeId(node.id); }} />
      {canEnter && <aside className="runtime-agent-rail" aria-label="历史协作组详情">
        <div className="runtime-agent-rail-content">
          <strong>{scopedGroupName(historicalProject, groupId)}</strong>
          <span>{runtimeNodeLabel(runtime.nodeStates[selectedNode!.id])}</span>
          <button type="button" onClick={() => { setScopeId(groupId); setSelectedNodeId(undefined); }}>进入组内历史 Workflow</button>
        </div>
      </aside>}
    </div>
    <div className="workflow-replay-caption" aria-live="polite">
      <strong>{completed ? "回顾已到达最后一条记录" : "历史回顾"}</strong><span>{frame.event?.message ?? "准备播放已保存的执行过程"}</span>
      {frame.change && <details><summary>{frame.change.title}</summary><p>{frame.change.reason}</p><pre>{frame.change.content}</pre></details>}
    </div>
  </section>;
}
