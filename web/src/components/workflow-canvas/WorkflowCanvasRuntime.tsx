import { currentScopedGroupRun, scopedGroupDisplayState } from "../../scoped-runtime";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from "react";
import {
  Activity,
  ArrowLeft,
  ExternalLink,
  GitBranch,
  GitGraph,
  GitPullRequest,
  Maximize,
  Minus,
  Plus,
  Trash2,
  X
} from "lucide-react";
import type { AgentEvent, HarnessCatalogEntry, Project } from "../../types";
import { agentMeta } from "../../lib";
import { CanvasEdges, type CanvasEdgeGeometry } from "./CanvasEdges";
import { CanvasNodes, type CanvasNodePresentation } from "./CanvasNodes";
import { CanvasWorld } from "./CanvasWorld";
import {
  CollaborationActivityFeed,
  FailureAttemptHistory
} from "./CollaborationActivityFeed";
import { ExecutionPreview } from "./ExecutionPreview";
import { CopyableTechnicalValue } from "./CopyableTechnicalValue";
import { GitTreeDialog } from "./GitTreeDialog";
import { RuntimeAgentNodeDetail } from "./RuntimeAgentNodeDetail";
import { WorkflowCanvasLive } from "./WorkflowCanvasLive";
import { buildScopedRuntimeView, scopedGroupName, scopedReferenceDisplayState } from "./core/scoped-runtime-view";
import { adaptWorkflowToCanvas } from "./core/canvas-adapter";
import { canvasContentBounds, fitCanvasViewport, zoomCanvasViewportAt } from "./core/canvas-viewport";
import {
  COLLABORATION_STATE_LABELS,
  collaborationExecutionState,
  collaborationProgress,
  type CollaborationDisplayState
} from "./core/collaboration-activity";
import {
  CANVAS_WORLD_HEIGHT,
  CANVAS_WORLD_WIDTH,
  type CanvasModel,
  type CanvasNode,
  type CanvasPoint,
  type CanvasSize,
  type CanvasViewport
} from "./core/canvas-model";
import type { EdgeGeometry } from "./core/canvas-router";
import { useCanvasRouting } from "./useCanvasRouting";
import {
  buildWorkflowRuntimeState,
  runtimeNodeLabel,
  type RuntimeNodeState,
  type WorkflowRuntimeState
} from "./core/workflow-runtime";
import "./workflow-canvas.css";

export interface WorkflowCanvasRuntimeProps {
  project: Project;
  events: AgentEvent[];
  harnesses?: ReadonlyArray<Pick<HarnessCatalogEntry, "id" | "label">>;
  /** Optional host-level snapshot shared with the rail and invocation ledger. */
  runtime?: WorkflowRuntimeState;
}

export type RuntimeCanvasSurfaceMode = "preview" | "modal";

/**
 * Passive renderer shared by the embedded runtime preview and the large
 * runtime dialog. It receives one model and one geometry snapshot from its
 * owner; it never creates an editor model, mutates orchestration, or exposes
 * ports/edge hit targets.
 */
export interface RuntimeCanvasSurfaceProps {
  model: CanvasModel;
  geometry: readonly EdgeGeometry[];
  runtime: WorkflowRuntimeState;
  project: Project;
  harnesses?: ReadonlyArray<Pick<HarnessCatalogEntry, "id" | "label">>;
  mode?: RuntimeCanvasSurfaceMode;
  selectedNodeId?: string;
  onSelectNode?: (node: CanvasNode) => void;
  onOpen?: () => void;
  expandedGroupIds?: ReadonlySet<string>;
  onToggleGroup?: (groupId: string) => void;
}

interface RuntimeCanvasViewportPlan {
  viewport: CanvasViewport;
  scrollable: boolean;
  frameWidth: number;
  frameHeight: number;
}

export function runtimeGroupMemberStates(project: Project): Record<string, Record<string, string>> {
  if (project.orchestration.schemaVersion === 3) return {};
  const result: Record<string, Record<string, string>> = {};
  for (const group of project.orchestration.collaborations ?? []) {
    const progress = collaborationProgress(project, group);
    result[group.id] = Object.fromEntries(progress.members.map((member) => {
      const leader = progress.groupRun?.leaderAgentId === member.agentId ? "leader · " : "";
      return [member.agentId, `${leader}${member.state}`];
    }));
  }
  return result;
}

function runtimeStateForCollaboration(state: CollaborationDisplayState): RuntimeNodeState {
  return state;
}

/**
 * Keep the runtime dialog readable on narrow screens without inventing a
 * second graph.  The same world coordinates are fitted into a wider,
 * horizontally scrollable frame; the page itself remains width-locked.
 */
export function planRuntimeCanvasViewport(
  mode: RuntimeCanvasSurfaceMode,
  viewportSize: { width: number; height: number },
  contentBounds: ReturnType<typeof canvasContentBounds>
): RuntimeCanvasViewportPlan {
  const width = Math.max(1, viewportSize.width);
  const height = Math.max(1, viewportSize.height);
  const narrowModal = mode === "modal" && width < 620;
  if (!narrowModal || !contentBounds) {
    return {
      viewport: fitCanvasViewport(
        { width, height },
        contentBounds,
        mode === "modal"
          ? { padding: 52, boundsPadding: 24, minZoom: 0.08, maxZoom: 1.35 }
          : { padding: 22, boundsPadding: 14, minZoom: 0.14, maxZoom: 1.08 }
      ),
      scrollable: false,
      frameWidth: width,
      frameHeight: height
    };
  }

  const boundsPadding = 24;
  const padding = 22;
  const graphWidth = Math.max(1, contentBounds.maxX - contentBounds.minX + boundsPadding * 2);
  const graphHeight = Math.max(1, contentBounds.maxY - contentBounds.minY + boundsPadding * 2);
  // A 0.62 zoom keeps a reference card's 12px title near 7.5px on a phone;
  // the enlarged card typography below brings the readable text back to
  // ordinary mobile sizing.  If the dialog is unusually short, height wins.
  const heightFit = Math.max(0.46, (height - padding * 2) / graphHeight);
  const zoom = Math.min(0.62, heightFit);
  const frameWidth = Math.max(width, Math.ceil(graphWidth * zoom + padding * 2));
  const frameHeight = Math.max(height, Math.ceil(graphHeight * zoom + padding * 2));
  return {
    viewport: fitCanvasViewport(
      { width: frameWidth, height: frameHeight },
      contentBounds,
      { padding, boundsPadding, minZoom: zoom, maxZoom: zoom }
    ),
    scrollable: frameWidth > width + 1,
    frameWidth,
    frameHeight
  };
}

export function RuntimeCanvasSurface({
  model,
  geometry,
  runtime,
  project,
  mode = "preview",
  selectedNodeId,
  onSelectNode,
  onOpen,
  expandedGroupIds,
  onToggleGroup
}: RuntimeCanvasSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [nodeSizes, setNodeSizes] = useState<Record<string, CanvasSize>>({});
  const surfaceNodes = useMemo(
    () => model.nodes.map((node) => nodeSizes[node.id] ? { ...node, ...nodeSizes[node.id] } : node),
    [model.nodes, nodeSizes]
  );
  const measuredRouting = useCanvasRouting(model.edges, surfaceNodes, { enabled: Object.keys(nodeSizes).length > 0 });
  const surfaceGeometry = Object.keys(nodeSizes).length ? measuredRouting.geometry : geometry;
  const collaborationProgressById = useMemo(() => Object.fromEntries(
    (project.orchestration.schemaVersion === 3 ? [] : project.orchestration.collaborations ?? []).map((group) => [
      group.id,
      collaborationProgress(project, group)
    ])
  ), [project]);
  const reconciledNodeStates = useMemo(() => {
    const states = { ...runtime.nodeStates };
    for (const [groupId, progress] of Object.entries(collaborationProgressById)) {
      states[groupId] = runtimeStateForCollaboration(progress.state);
    }
    if (project.orchestration.schemaVersion === 3) {
      for (const group of project.orchestration.scopedWorkflow?.groups ?? []) {
        states[group.id] = scopedGroupDisplayState(project, group.id);
      }
    }
    return states;
  }, [collaborationProgressById, project, runtime.nodeStates]);
  const handleNodeResize = useCallback((nodeId: string, nextSize: CanvasSize) => {
    setNodeSizes((current) => {
      const previous = current[nodeId];
      if (previous?.width === nextSize.width && previous.height === nextSize.height) return current;
      return { ...current, [nodeId]: nextSize };
    });
  }, []);
  const contentBounds = useMemo(
    () => canvasContentBounds(surfaceNodes, surfaceGeometry.flatMap((edge) => edge.samples)),
    [surfaceGeometry, surfaceNodes]
  );
  const viewportPlan = useMemo(
    () => planRuntimeCanvasViewport(mode, size, contentBounds),
    [contentBounds, mode, size.height, size.width]
  );
  const savedViewport = model.presentationLayout.viewport;
  const defaultViewport = mode === "modal" ? savedViewport : viewportPlan.viewport;
  const [viewport, setViewport] = useState<CanvasViewport>(defaultViewport);
  const pointerMovedRef = useRef(false);
  const userViewportRef = useRef(false);
  const panRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    viewport: CanvasViewport;
  }>();
  const geometryValid = useMemo(() => surfaceGeometry.every((edge) => (
    edge.samples.length > 1
    && edge.samples.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
  )), [surfaceGeometry]);

  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Preview always follows content. The modal starts from the project-saved
  // editor viewport and keeps later pan/zoom changes session-local.
  useEffect(() => {
    if (mode === "preview") {
      setViewport(viewportPlan.viewport);
    } else if (!userViewportRef.current) {
      setViewport(savedViewport);
    }
  }, [mode, savedViewport.x, savedViewport.y, savedViewport.zoom, viewportPlan.viewport]);

  const resolvePresentation = useCallback((node: CanvasNode): CanvasNodePresentation => {
    if (node.kind === "input") {
      return { title: "用户输入", description: "本次项目输入", modelLabel: "INPUT", color: "#446b9b", softColor: "#eaf0f7" };
    }
    if (node.kind === "finish") {
      return { title: "结束", description: "真实终止路径", modelLabel: "END", color: "#a65365", softColor: "#f9eaed" };
    }
    if (node.collaboration) {
      return { title: node.displayName ?? node.name, description: `${node.memberAgentIds?.length ?? 0} 名成员协作`, modelLabel: collaborationProgressById[node.id]?.phaseLabel ?? runtimeNodeLabel(reconciledNodeStates[node.id]), initials: "组", color: "#5c5bd6", softColor: "#eeedff" };
    }
    const definition = project.orchestration.agents.find((entry) => entry.name === node.name);
    const meta = agentMeta(node.name, node.template ?? "general");
    const isMain = node.name === "main";
    return {
      title: isMain ? "Main Agent" : meta.name,
      description: definition?.description ?? meta.description,
      modelLabel: runtimeNodeLabel(runtime.nodeStates[node.id]),
      initials: isMain ? "MA" : meta.shortName.slice(0, 2).toUpperCase(),
      color: isMain ? "#25714e" : "#526674",
      softColor: isMain ? "#e7f1e9" : "#eaf0f3"
    };
  }, [collaborationProgressById, project.orchestration.agents, reconciledNodeStates]);

  const renderedEdges: CanvasEdgeGeometry[] = useMemo(
    () => surfaceGeometry.map((edge) => {
      const loop = model.edges.find((item) => item.id === edge.id)?.loop;
      const loopState = loop ? runtime.loopStates[loop.id] : undefined;
      return {
        ...edge,
        loop,
        label: loop
          ? loop.role === "return"
            ? `↻ ${loop.id} · B${loopState?.batch ?? 0} · ${(loopState?.iteration ?? 0)}/${loop.maxIterations} · Σ${loopState?.totalIterations ?? 0}`
            : `批次退出 · ${loop.id}`
          : edge.label,
        runtimeState: runtime.edgeStates[edge.id] ?? "configured"
      };
    }),
    [surfaceGeometry, model.edges, runtime.edgeStates, runtime.loopStates]
  );

  const onRuntimeWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (mode !== "modal") return;
    const rect = event.currentTarget.getBoundingClientRect();
    userViewportRef.current = true;
    setViewport((current) => zoomCanvasViewportAt(
      current,
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      current.zoom * Math.exp(-Math.max(-240, Math.min(240, event.deltaY)) * .0015)
    ));
  }, [mode]);

  const handleRuntimePointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.type === "pointerdown") {
      pointerMovedRef.current = false;
      const target = event.target as Element | null;
      if (
        mode === "modal"
        && !viewportPlan.scrollable
        && event.button === 0
        && !target?.closest(".agent-node")
      ) {
        panRef.current = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          viewport
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }
    }
    if (event.type === "pointermove" && panRef.current?.pointerId === event.pointerId) {
      pointerMovedRef.current = true;
      userViewportRef.current = true;
      const gesture = panRef.current;
      setViewport({
        ...gesture.viewport,
        x: gesture.viewport.x + event.clientX - gesture.clientX,
        y: gesture.viewport.y + event.clientY - gesture.clientY
      });
      event.preventDefault();
    }
    if ((event.type === "pointerup" || event.type === "pointercancel") && panRef.current?.pointerId === event.pointerId) {
      panRef.current = undefined;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    event.stopPropagation();
  }, [mode, viewport, viewportPlan.scrollable]);

  const zoomRuntime = useCallback((delta: number) => {
    userViewportRef.current = true;
    setViewport((current) => zoomCanvasViewportAt(
      current,
      { x: size.width / 2, y: size.height / 2 },
      current.zoom + delta
    ));
  }, [size.height, size.width]);

  const fitRuntime = useCallback(() => {
    // Fit is the runtime surface's only explicit viewport recomputation. Keep
    // that result for this modal session without writing it back to the project.
    userViewportRef.current = true;
    setViewport(viewportPlan.viewport);
  }, [viewportPlan.viewport]);

  const handleWorldClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (mode !== "preview") return;
    if (pointerMovedRef.current) {
      pointerMovedRef.current = false;
      return;
    }
    // Node clicks are handled by CanvasNodes and should invoke onOpen once;
    // blank and passive-edge clicks open the same dialog.
    const target = event.target as Element | null;
    if (target?.closest(".agent-node")) return;
    onOpen?.();
  }, [mode, onOpen]);

  const canvas = (
    <CanvasWorld
      viewport={viewport}
      worldWidth={CANVAS_WORLD_WIDTH}
      worldHeight={CANVAS_WORLD_HEIGHT}
      className="workflow-runtime-world"
      onWheel={onRuntimeWheel}
      onClick={handleWorldClick}
      data-canvas-layout-phase="idle"
      data-canvas-geometry-valid={geometryValid ? "true" : "false"}
      aria-label={mode === "preview" ? "运行 Workflow 缩略画布，点击打开大画布" : "运行 Workflow 大画布"}
    >
      <CanvasEdges
        edges={renderedEdges}
        nodes={surfaceNodes}
        focusedNodeId={runtime.currentNodeId}
        interactive={false}
      />
      <CanvasNodes
        nodes={surfaceNodes}
        suppressGroupMembers={mode === "preview"}
        readOnly
        showPorts={false}
        selectedNodeId={selectedNodeId}
        runtimeNodeStates={reconciledNodeStates}
        runtimeExecutionCounts={runtime.executionCounts}
        expandedGroupIds={expandedGroupIds}
        onToggleGroup={onToggleGroup}
        onNodeResize={handleNodeResize}
        groupMemberStates={runtimeGroupMemberStates(project)}
        resolvePresentation={resolvePresentation}
        onSelectNode={(node) => {
          onSelectNode?.(node);
          if (mode === "preview") onOpen?.();
        }}
      />
    </CanvasWorld>
  );

  return (
    <div className="runtime-canvas-surface-shell">
      <div
        ref={hostRef}
        className={`runtime-canvas-surface runtime-canvas-surface-${mode}${viewportPlan.scrollable ? " is-runtime-scrollable" : ""}`}
        data-runtime-surface-mode={mode}
        data-runtime-node-count={model.nodes.length}
        data-runtime-edge-count={model.edges.length}
        data-runtime-scrollable={viewportPlan.scrollable ? "true" : "false"}
        onPointerDown={handleRuntimePointer}
        onPointerMove={handleRuntimePointer}
        onPointerUp={handleRuntimePointer}
        onPointerCancel={handleRuntimePointer}
        onDragStart={(event) => event.preventDefault()}
      >
        {viewportPlan.scrollable ? (
          <div
            className="runtime-canvas-scroll-frame"
            style={{ width: viewportPlan.frameWidth, height: viewportPlan.frameHeight }}
            data-runtime-scroll-width={viewportPlan.frameWidth}
          >
            {canvas}
          </div>
        ) : canvas}
      </div>
      {mode === "modal" && (
        <div className="runtime-canvas-controls" role="group" aria-label="运行画布视口控制">
          <button type="button" aria-label="缩小运行画布" title="缩小" onClick={() => zoomRuntime(-.1)}><Minus size={14} /></button>
          <span aria-label={`当前缩放 ${Math.round(viewport.zoom * 100)}%`}>{Math.round(viewport.zoom * 100)}%</span>
          <button type="button" aria-label="放大运行画布" title="放大" onClick={() => zoomRuntime(.1)}><Plus size={14} /></button>
          <button type="button" aria-label="适应运行画布" title="适应画布" onClick={fitRuntime}><Maximize size={14} /></button>
        </div>
      )}
      {viewportPlan.scrollable && (
        <span className="workflow-runtime-scroll-hint" aria-hidden="true">左右滑动查看完整拓扑</span>
      )}
    </div>
  );
}

function RuntimeNodeDetail({
  node,
  runtime,
  project,
  events = [],
  harnesses,
  resolvePresentation
}: {
  node: CanvasNode;
  runtime: WorkflowRuntimeState;
  project: Project;
  events?: readonly AgentEvent[];
  harnesses?: ReadonlyArray<Pick<HarnessCatalogEntry, "id" | "label">>;
  resolvePresentation: (node: CanvasNode) => CanvasNodePresentation;
}) {
  const presentation = resolvePresentation(node);
  const state = runtime.nodeStates[node.id] ?? "waiting";
  if (node.collaboration) {
    return <CollaborationRuntimeDetail node={node} runtime={runtime} project={project} events={events} />;
  }
  return <RuntimeAgentNodeDetail node={node} project={project} title={presentation.title} state={state}
    executionCount={runtime.executionCounts[node.id] ?? 0} reason={runtime.nodeReasons[node.id]}
    invocationId={runtime.currentNodeId === node.id ? runtime.currentInvocationId : undefined} harnesses={harnesses} />;
}

function ScopedCollaborationRuntimeDetail({ node, runtime, project, expanded, onToggle, onEnter }: {
  node: CanvasNode; runtime: WorkflowRuntimeState; project: Project;
  expanded: boolean; onToggle: () => void; onEnter: () => void;
}) {
  const groupId = node.collaboration?.id ?? node.id;
  const group = project.orchestration.scopedWorkflow?.groups.find((entry) => entry.id === groupId);
  const run = currentScopedGroupRun(project, groupId);
  const state = run ? scopedGroupDisplayState(project, groupId) : runtime.nodeStates[node.id] ?? "waiting";
  return <aside className="workflow-runtime-detail collaboration-runtime-detail" aria-label="协作组运行详情" data-collaboration-state={state}>
    <strong>{scopedGroupName(project, groupId)}</strong>
    <span>{runtimeNodeLabel(state)}</span>
    <small>累计执行 {runtime.executionCounts[node.id] ?? 0} 次</small>
    <small>Leader：{run?.leaderAgentId ?? group?.leaderAgentId ?? "未配置"}</small>
    <div className="workflow-runtime-group-actions">
      <button type="button" aria-expanded={expanded} onClick={onToggle}>{expanded ? "收起子节点" : "查看子 Agent"}</button>
      <button type="button" onClick={onEnter}>进入组内运行 Workflow</button>
    </div>
    {expanded && <ul className="workflow-runtime-group-members" aria-label="协作组成员状态">
      {group?.workflow.nodes.map((ref) => <li key={ref.nodeId}>
        {ref.kind === "collaboration" ? scopedGroupName(project, ref.groupId) : agentMeta(ref.agentId,
          project.orchestration.agents.find((agent) => agent.name === ref.agentId)?.template).name}
        <small>{runtimeNodeLabel(scopedReferenceDisplayState(project, groupId, ref.nodeId))}</small>
      </li>)}
    </ul>}
    {run && <details className="workflow-runtime-group-facts"><summary>执行详情</summary>
      <small>分支：{run.groupBranch || "等待创建"}</small>
      <small>目标：{run.integrationTarget || "等待观测"}</small>
      <small>Workflow revision：{run.workflowRevision}</small>
    </details>}
  </aside>;
}

function CollaborationRuntimeDetail({ node, runtime, project, events }: {
  node: CanvasNode;
  runtime: WorkflowRuntimeState;
  project: Project;
  events: readonly AgentEvent[];
}) {
  const nodeRuns = (project.nodeRuns ?? []).filter((run) => run.node.nodeId === node.id);
  const activeNodeRun = nodeRuns.find((run) => run.id === project.activeNodeRunId) ?? nodeRuns.at(-1);
  const groupRuns = (project.groupRuns ?? []).filter((run) => nodeRuns.some((nodeRun) => nodeRun.id === run.nodeRunId));
  const collaboration = (project.orchestration.collaborations ?? []).find((entry) => entry.id === node.id);
  const progress = collaboration ? collaborationProgress(project, collaboration) : undefined;
  const groupRun = progress?.groupRun
    ?? groupRuns.find((run) => run.nodeRunId === activeNodeRun?.id)
    ?? groupRuns.at(-1);
  const tasks = (project.tasks ?? [])
    .filter((task) => task.groupRunId === groupRun?.id)
    .sort((left, right) => left.queueOrdinal - right.queueOrdinal);
  const executions = (project.executions ?? []).filter((execution) => execution.groupRunId === groupRun?.id);
  const pullRequests = project.pullRequests ?? [];
  const finalPullRequest = pullRequests.find((pull) => pull.id === groupRun?.finalPullRequestId)
    ?? pullRequests.find((pull) => executions.some((execution) => execution.purpose === "final-integration" && execution.id === pull.ownerExecutionId));
  const completed = groupRun?.status === "completed" || activeNodeRun?.status === "completed";
  return <aside
    className="workflow-runtime-detail collaboration-runtime-detail"
    aria-label="协作组运行详情"
    data-collaboration-state={progress?.state ?? "waiting"}
  >
    <header><span>COLLABORATION RUN</span><strong>{node.displayName ?? node.name}</strong><small>{progress?.phaseLabel ?? (completed ? "协作组已完成" : runtimeNodeLabel(runtime.nodeStates[node.id]))}</small></header>
    {groupRun ? <>
      {progress && <div className="collaboration-progress-summary" data-state={progress.state}>
        <strong>成员进度 {progress.completedMembers}/{progress.totalMembers}</strong>
        <span><i style={{ width: `${Math.round(progress.completedMembers / Math.max(1, progress.totalMembers) * 100)}%` }} /></span>
      </div>}
      {groupRun.failureReason && <p className="workflow-runtime-detail-reason">{groupRun.failureReason}</p>}
      <section className="collaboration-task-queue">
        <h3>成员分工</h3>
        {tasks.length ? tasks.map((task) => {
          const rounds = executions.filter((execution) => execution.taskId === task.id);
          return <article key={task.id} data-task-id={task.id}>
            <div><span>#{task.queueOrdinal}</span><strong>{task.assigneeAgentId ?? "等待分配"}</strong><em>{taskStatusLabel(task.status)}</em></div>
            <p>{task.assignment || "未记录分工"}</p>
            {task.waitReason && <small>等待：{task.waitReason}</small>}
            {task.failureReason && <small className="workflow-runtime-detail-reason">故障：{task.failureReason}</small>}
            {rounds.length > 0 && <ol className="collaboration-execution-rounds">
              {rounds.map((execution, index) => {
                const pull = pullRequests.find((entry) => entry.id === execution.pullRequestId);
                const displayState = collaborationExecutionState(project, execution, pull);
                return <li key={execution.id} data-execution-id={execution.id}>
                  <span>第 {index + 1} 轮 · {execution.agentId}</span>
                  <strong data-state={displayState}>{displayState === "waiting"
                    ? executionStatusLabel(execution.status)
                    : COLLABORATION_STATE_LABELS[displayState]}</strong>
                  <small>{execution.purpose === "final-integration" ? "最终集成" : "成员交付"}</small>
                  {execution.waitReason && <small>等待：{execution.waitReason}</small>}
                  {execution.failureReason && <small className="workflow-runtime-detail-reason">{execution.failureReason}</small>}
                  {pull && <a href={pull.htmlUrl} target="_blank" rel="noreferrer">PR #{pull.providerNumber} · {pull.status === "merged" ? "已合并" : pull.status}</a>}
                </li>;
              })}
            </ol>}
          </article>;
        }) : <p>正在拆分任务，成员按队列等待。</p>}
      </section>
      <section className="collaboration-runtime-activity">
        <h3>最近大动作</h3>
        <CollaborationActivityFeed project={project} events={events} groupRunId={groupRun.id} limit={8} />
      </section>
      <section className="collaboration-integration-progress">
        <h3>最终集成</h3>
        <p>{completed
          ? "最终集成已完成，协作组直接进入完成态。"
          : progress?.state === "paused"
            ? "项目已暂停，最终集成不会继续显示为执行中。"
            : progress?.state === "stopping"
              ? "正在安全停止最终集成。"
              : progress?.state === "running" && groupRun.status === "integrating"
                ? "最终集成正在进行。"
                : "等待成员交付与最终集成事实。"}</p>
        {finalPullRequest && <PullRequestFacts pull={finalPullRequest} />}
      </section>
      <details className="collaboration-technical-details">
        <summary>技术详情</summary>
        <dl className="collaboration-run-facts">
          <div><dt>Group Run</dt><dd><CopyableTechnicalValue value={groupRun.id} /></dd></div>
          <div><dt>协调者</dt><dd>{groupRun.leaderAgentId}</dd></div>
          <div><dt>协调轮次</dt><dd>{groupRun.coordinatorEpoch}</dd></div>
          <div><dt>集成分支</dt><dd><CopyableTechnicalValue value={groupRun.groupBranch || "等待创建"} /></dd></div>
          <div><dt>Base</dt><dd><CopyableTechnicalValue value={groupRun.baseCommit || "等待观测"} /></dd></div>
        </dl>
        {tasks.filter((task) => task.predecessorTaskId || task.successorTaskId).map((task) => <div className="collaboration-technical-execution" key={task.id}>
          <strong>{task.assigneeAgentId ?? "未分配成员"} · 任务关系</strong>
          <CopyableTechnicalValue value={task.id} />
          {task.predecessorTaskId && <small>接续自任务：{task.predecessorTaskId}</small>}
          {task.successorTaskId && <small>接续任务：{task.successorTaskId}</small>}
        </div>)}
        {executions.map((execution) => <div className="collaboration-technical-execution" key={execution.id}>
          <strong>{execution.agentId}</strong>
          <CopyableTechnicalValue value={execution.id} />
          <CopyableTechnicalValue value={execution.executionBranch || "等待分支"} />
          <CopyableTechnicalValue value={execution.worktreePath || "等待 worktree"} />
          <small>ownership epoch {execution.ownershipEpoch}</small>
          {execution.predecessorExecutionId && <small>接续自执行：{execution.predecessorExecutionId}</small>}
          {execution.successorExecutionId && <small>故障后接续：{execution.successorExecutionId}</small>}
        </div>)}
      </details>
    </> : <p>等待服务端创建 Group Run 快照。</p>}
  </aside>;
}

function taskStatusLabel(status: NonNullable<Project["tasks"]>[number]["status"]): string {
  return ({ pending: "等待", assigned: "已分配", working: "运行", waiting: "等待", continuation_pending: "等待接续", succeeded: "完成", failed: "故障", cancelled: "取消" } as const)[status];
}

function executionStatusLabel(status: NonNullable<Project["executions"]>[number]["status"]): string {
  return ({ queued: "FIFO 等待", working: "运行", waiting_authorization: "等待授权", waiting_review: "等待 PR 评审", pr_open: "PR 已打开", resolving: "冲突修复中", merged: "已集成", stop_requested: "等待停止", stopped: "已停止", superseded: "已重新分配", succeeded: "完成", failed: "故障", cancelled: "取消" } as const)[status];
}

function PullRequestFacts({ pull }: { pull: NonNullable<Project["pullRequests"]>[number] }) {
  return <div className="pull-request-facts" data-pull-request-id={pull.id}>
    <a href={pull.htmlUrl} target="_blank" rel="noreferrer">PR #{pull.providerNumber} · {pull.status}</a>
    <small>{pull.head} → {pull.base}</small>
    {(pull.headSha || pull.baseSha) && <small>head {pull.headSha ?? "?"} · base {pull.baseSha ?? "?"}</small>}
    <small>可合并性：{pull.mergeable === true ? "可合并" : pull.mergeable === false ? "不可合并" : "尚未确认"} · 观测于 {pull.observedAt}</small>
    {pull.mergeCommitSha && <small>merge commit {pull.mergeCommitSha}</small>}
    {pull.diffUrl && <a href={pull.diffUrl} target="_blank" rel="noreferrer">查看 diff</a>}
    {pull.headCommitUrl && <a href={pull.headCommitUrl} target="_blank" rel="noreferrer">查看 head commit</a>}
    {pull.conflictPaths?.length ? <small className="workflow-runtime-detail-reason">冲突：{pull.conflictPaths.join("、")}</small> : null}
    {pull.blockers?.map((blocker) => <small className="workflow-runtime-detail-reason" key={blocker}>{blocker}</small>)}
    {pull.checks?.map((check) => <span key={check.id}>{check.name} · {check.conclusion ?? check.status}</span>)}
    {pull.reconciliation && <small>事实核对：{pull.reconciliation.status}{pull.reconciliation.message ? ` · ${pull.reconciliation.message}` : ""}</small>}
  </div>;
}

function RuntimeCanvasDialog({
  model,
  runtime,
  project,
  harnesses,
  selectedNodeId,
  events,
  onSelectNode,
  onClose,
  expandedGroupIds,
  onToggleGroup
}: RuntimeCanvasSurfaceProps & { events: AgentEvent[]; onClose: () => void }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [activeScopedGroupId, setActiveScopedGroupId] = useState<string>();
  const [scopeSelections, setScopeSelections] = useState<Record<string, string>>({});
  const scopedView = useMemo(() => activeScopedGroupId && project.orchestration.schemaVersion === 3
    ? buildScopedRuntimeView(project, activeScopedGroupId) : undefined, [project, activeScopedGroupId]);
  const viewModel = scopedView?.model ?? model;
  const viewRuntime = scopedView?.runtime ?? runtime;
  const viewSelectedId = scopedView ? scopeSelections[scopedView.group.id] : selectedNodeId;
  const closeRef = useRef<HTMLButtonElement>(null);
  const selectedNode = viewModel.nodes.find((node) => node.id === viewSelectedId);
  const selectedGroupId = selectedNode?.collaboration?.id ?? (scopedView ? undefined : selectedNode?.id);
  const selectedScopedGroup = project.orchestration.schemaVersion === 3 &&
    project.orchestration.scopedWorkflow?.groups.find((group) => group.id === selectedGroupId);
  const selectNode = useCallback((node: CanvasNode) => {
    if (scopedView) setScopeSelections((current) => ({ ...current, [scopedView.group.id]: node.id }));
    else onSelectNode?.(node);
  }, [scopedView, onSelectNode]);
  // Main can dissolve the open group or remove a selected reference while live.
  useEffect(() => {
    if (activeScopedGroupId && !scopedView) setActiveScopedGroupId(undefined);
    setScopeSelections((current) => {
      const remaining = Object.entries(current).filter(([groupId, nodeId]) => {
        const group = project.orchestration.scopedWorkflow?.groups.find((entry) => entry.id === groupId);
        return group && (nodeId === "input" || nodeId === "finish" || group.workflow.nodes.some((node) => node.nodeId === nodeId));
      });
      return remaining.length === Object.keys(current).length ? current : Object.fromEntries(remaining);
    });
  }, [project.orchestration.scopedWorkflow, activeScopedGroupId, scopedView?.group.id]);

  useEffect(() => {
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const resolvePresentation = useCallback((node: CanvasNode): CanvasNodePresentation => {
    if (node.kind === "input") return { title: scopedView ? "进入协作组" : "用户输入", description: "流程输入", modelLabel: "INPUT", color: "#446b9b", softColor: "#eaf0f7" };
    if (node.kind === "finish") return { title: scopedView ? "结束协作组" : "结束", description: "真实终止路径", modelLabel: "END", color: "#a65365", softColor: "#f9eaed" };
    if (node.collaboration) return { title: node.displayName ?? node.name, description: `${node.memberAgentIds?.length ?? 0} 名成员协作`, modelLabel: runtimeNodeLabel(viewRuntime.nodeStates[node.id]), initials: "组", color: "#5c5bd6", softColor: "#eeedff" };
    const definition = project.orchestration.agents.find((entry) => entry.name === node.name);
    const meta = agentMeta(node.name, node.template ?? "general");
    return {
      title: node.name === "main" ? "Main Agent" : meta.name,
      description: definition?.description ?? meta.description,
      modelLabel: runtimeNodeLabel(viewRuntime.nodeStates[node.id]),
      initials: node.name === "main" ? "MA" : meta.shortName.slice(0, 2).toUpperCase(),
      color: node.name === "main" ? "#25714e" : "#526674",
      softColor: node.name === "main" ? "#e7f1e9" : "#eaf0f3"
    };
  }, [project.orchestration.agents, viewRuntime.nodeStates, scopedView]);

  return (
    <div
      className="workflow-runtime-modal-backdrop"
      data-runtime-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="workflow-runtime-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-runtime-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="workflow-runtime-dialog-head">
          <div>
            <span className="panel-kicker">RUNTIME WORKFLOW</span>
            <h2 id="workflow-runtime-dialog-title">{previewOpen ? "执行速览" : activeScopedGroupId ? "组内运行 Workflow" : "运行 Workflow 画布"}</h2>
            <small>{previewOpen ? "用户输入 → Agent 执行与输出 → 调度交接" : "动态 Workflow · 当前课题实时执行状态"}</small>
          </div>
          <div className="workflow-runtime-dialog-actions">
          <button type="button" className="workflow-runtime-preview-toggle" aria-pressed={previewOpen} onClick={() => setPreviewOpen(!previewOpen)}>
            {previewOpen ? "返回 Workflow" : "执行速览"}
          </button>
          <button
            ref={closeRef}
            type="button"
            className="workflow-runtime-dialog-close"
            aria-label="关闭运行 Workflow 画布"
            title="关闭"
            onClick={onClose}
          ><X size={18} /></button>
          </div>
        </header>
        {previewOpen && <ExecutionPreview project={project} events={events} runtime={runtime} />}
        {scopedView && !previewOpen && <nav className="scoped-breadcrumbs" aria-label="运行 Workflow 范围路径">
          <button type="button" className="scoped-parent-link" onClick={() => setActiveScopedGroupId(scopedView.group.parentGroupId)}><ArrowLeft size={14} />返回父图</button>
          <button type="button" onClick={() => setActiveScopedGroupId(undefined)}>项目</button>
          {scopedView.path.map((group, index) => <span key={group.id}><span aria-hidden="true">›</span><button type="button" aria-current={index === scopedView.path.length - 1 ? "page" : undefined} onClick={() => setActiveScopedGroupId(group.id)}>{scopedGroupName(project, group.id)}</button></span>)}
        </nav>}
        <div className="workflow-runtime-dialog-canvas" hidden={previewOpen} aria-label={scopedView ? `${scopedGroupName(project, scopedView.group.id)} 组内运行 Workflow` : "项目运行 Workflow"}>
          <WorkflowCanvasLive
            model={viewModel}
            runtime={viewRuntime}
            scopeId={scopedView?.group.id}
            project={project}
            events={events}
            selectedNodeId={selectedNode?.id}
            onSelectNode={selectNode}
            expandedGroupIds={expandedGroupIds}
            onToggleGroup={onToggleGroup}
            onNavigateGroup={setActiveScopedGroupId}
            onClose={onClose}
          />
          {selectedNode && selectedScopedGroup && <ScopedCollaborationRuntimeDetail node={selectedNode} runtime={viewRuntime} project={project}
            expanded={expandedGroupIds?.has(selectedScopedGroup.id) ?? false}
            onToggle={() => onToggleGroup?.(selectedScopedGroup.id)} onEnter={() => setActiveScopedGroupId(selectedScopedGroup.id)} />}
          {selectedNode && !selectedScopedGroup && (
            <RuntimeNodeDetail node={selectedNode} runtime={viewRuntime} project={project} events={events} harnesses={harnesses} resolvePresentation={resolvePresentation} />
          )}
        </div>
        <div className="workflow-runtime-dialog-path" aria-label="实际执行路径">
          <span>Cycle {project.cycle}</span>
          {viewRuntime.recentInvocationPath.length
            ? viewRuntime.recentInvocationPath.slice(-12).map((entry, index) => (
              <span key={`${entry.invocationId ?? entry.nodeId}-${index}`}>
                {index ? " → " : ""}{entry.nodeId}{entry.state === "completed" ? " ✓" : entry.state === "running" ? " ·" : ""}
              </span>
            ))
            : <span>尚无实际调用</span>}
        </div>
      </div>
    </div>
  );
}

function ProjectGitReadonlyFacts({ project, onOpenGitTree }: { project: Project; onOpenGitTree: () => void }) {
  const git = project.git ?? { enabled: false as const, status: "disabled" as const };
  const statusLabel: Record<string, string> = {
    disabled: "未启用",
    authorizing: "等待 GitHub 授权",
    creating_repository: "正在创建仓库",
    initializing_local: "正在初始化本地仓库",
    pushing_main: "正在推送 main",
    ready: "已就绪",
    waiting_for_github: "等待 GitHub 响应",
    failed: "初始化失败"
  };
  return <section className="project-git-readonly" aria-label="Git 与 Pull Request 只读事实" data-git-readonly="true">
    <header><span><GitBranch size={15} /> GIT / PR</span><strong>{statusLabel[git.status] ?? git.status}</strong><em>只读</em></header>
    {!git.enabled ? <p>此项目创建时未启用 Git。</p> : <>
      {git.account && <dl className="project-git-repository">
        <div><dt>GitHub account</dt><dd>{git.account.login}</dd></div>
        <div><dt>Account binding</dt><dd>{git.account.id}</dd></div>
      </dl>}
      {git.repository && <>
        <dl className="project-git-repository">
          <div><dt>Repository</dt><dd><a href={git.repository.htmlUrl} target="_blank" rel="noreferrer">{git.repository.owner}/{git.repository.name}</a></dd></div>
          <div><dt>Visibility</dt><dd>{git.repository.private ? "Private" : "Public"}</dd></div>
          <div><dt>Default branch</dt><dd>{git.repository.defaultBranch}</dd></div>
        </dl>
        <div className="project-git-external-actions" aria-label="GitHub 仓库快捷入口">
          <a href={`${git.repository.htmlUrl.replace(/\/+$/, "")}/tree/${encodeURIComponent(git.repository.defaultBranch)}`} target="_blank" rel="noreferrer"><ExternalLink size={12} />查看代码</a>
          <button type="button" onClick={onOpenGitTree} title="在 ScienceEvolve 查看 Agent 分支、commit 与合并拓扑"><GitGraph size={12} />Git 提交图</button>
          <a href={`${git.repository.htmlUrl.replace(/\/+$/, "")}/activity`} target="_blank" rel="noreferrer" title="在 GitHub 查看 push、分支与合并时间线"><Activity size={12} />活动</a>
          <a href={`${git.repository.htmlUrl.replace(/\/+$/, "")}/network`} target="_blank" rel="noreferrer" title="GitHub repository network，包括真正的 Fork 仓库"><GitGraph size={12} />GitHub Network</a>
          <a href={project.pullRequests?.at(-1)?.htmlUrl ?? `${git.repository.htmlUrl.replace(/\/+$/, "")}/pulls`} target="_blank" rel="noreferrer"><GitPullRequest size={12} />查看 PR</a>
          <a className="danger" href={`${git.repository.htmlUrl.replace(/\/+$/, "")}/settings`} target="_blank" rel="noreferrer" title="在 GitHub Settings 的 Danger Zone 中删除仓库"><Trash2 size={12} />前往 GitHub 删除</a>
        </div>
      </>}
      {git.initialization && <div className={`project-git-initialization is-${git.status}`}><strong>初始化 attempt {git.initialization.attempt}</strong><small>Operation {git.initialization.operationId}</small><span>{git.initialization.completedSteps.length ? git.initialization.completedSteps.join(" → ") : "等待首个步骤"}</span>{git.initialization.error && <p>{git.initialization.error}<small>服务端可沿用同一 operationId 原位重试；页面不会创建新的写操作。</small></p>}</div>}
      {git.blockers?.map((blocker) => <p className="workflow-runtime-detail-reason" key={blocker}>{blocker}</p>)}
      {git.capacity && <p>保留 worktree：{git.capacity.retainedWorktreeCount}{git.capacity.warningThreshold !== undefined ? ` / 提醒阈值 ${git.capacity.warningThreshold}` : ""}{git.capacity.warning ? ` · ${git.capacity.warning}` : ""}</p>}
      {git.branches?.length ? <div className="project-git-fact-list"><h3>Branches</h3>{git.branches.map((branch) => <article key={`${branch.name}:${branch.ownerExecutionId ?? "project"}`}><strong>{branch.name}</strong><span>{branch.status}</span>{branch.base && <small>base {branch.base}</small>}{branch.head && <small>head {branch.head}</small>}{branch.retained && <em>retained</em>}</article>)}</div> : null}
      {git.commits?.length ? <div className="project-git-fact-list"><h3>Commits</h3>{git.commits.map((commit) => <article key={commit.sha}><strong>{commit.sha.slice(0, 12)}</strong>{commit.message && <span>{commit.message}</span>}{commit.htmlUrl && <a href={commit.htmlUrl} target="_blank" rel="noreferrer">查看 commit</a>}</article>)}</div> : null}
      {(project.pullRequests?.length ?? 0) > 0 && <div className="project-git-fact-list"><h3>Pull Requests / checks</h3>{project.pullRequests!.map((pull) => <PullRequestFacts pull={pull} key={pull.id} />)}</div>}
      {git.repository && <details className="project-git-technical-details">
        <summary>技术详情</summary>
        <dl className="project-git-repository">
          <div><dt>Local path</dt><dd>{git.repository.localPath}</dd></div>
          {git.branches?.filter((branch) => branch.worktreePath).map((branch) => <div key={`${branch.name}:worktree`}><dt>{branch.name}</dt><dd>{branch.worktreePath}</dd></div>)}
        </dl>
      </details>}
      {git.observedAt && <small>最后观测：{git.observedAt}</small>}
    </>}
  </section>;
}

/** Read-only runtime map with a fixed embedded preview and a large canvas dialog. */
export function WorkflowCanvasRuntime({ project, events, harnesses, runtime: runtimeProp }: WorkflowCanvasRuntimeProps) {
  const derivedRuntime = useMemo(() => buildWorkflowRuntimeState(project, events), [events, project]);
  const runtime = runtimeProp ?? derivedRuntime;
  const model = useMemo(
    () => adaptWorkflowToCanvas(project.orchestration, project.orchestration.canvas),
    [project.orchestration]
  );
  const { geometry } = useCanvasRouting(model.edges, model.nodes);
  const [modalOpen, setModalOpen] = useState(false);
  const [gitTreeOpen, setGitTreeOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (selectedNodeId && !model.nodes.some((node) => node.id === selectedNodeId)) setSelectedNodeId(undefined);
  }, [model.nodes, selectedNodeId]);
  const toggleGroup = useCallback((groupId: string) => {
    setExpandedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const openModal = useCallback(() => setModalOpen(true), []);
  const closeModal = useCallback(() => {
    setModalOpen(false);
    setSelectedNodeId(undefined);
  }, []);

  return (
    <>
      <section className="workflow-canvas-runtime" aria-label="运行中 Workflow 画布">
        <div className="workflow-runtime-map-header">
          <div>
            <span className="panel-kicker">RUNTIME WORKFLOW</span>
            <strong>配置拓扑 · 实际执行覆盖层</strong>
          </div>
          <span>
            {runtime.currentNodeId
              ? `${runtimeNodeLabel(runtime.nodeStates[runtime.currentNodeId])} · ${runtime.currentNodeId}`
              : runtime.queuedNodeId
                ? `${runtimeNodeLabel(runtime.nodeStates[runtime.queuedNodeId])} · ${runtime.queuedNodeId}`
                : "等待运行"}
          </span>
        </div>
        {Object.values(runtime.loopStates).length > 0 && (
          <div className="workflow-runtime-loop-summary" aria-label="Loop 运行计数">
            {Object.values(runtime.loopStates).map((loop) => (
              <span key={loop.id} data-loop-phase={loop.phase}>
                <strong>{loop.id}</strong>
                {` batch ${loop.batch} · iteration ${loop.iteration}/${loop.maxIterations} · total ${loop.totalIterations}`}
              </span>
            ))}
          </div>
        )}
        <div
          role="button"
          tabIndex={0}
          className="workflow-runtime-preview-button"
          aria-label="打开大型运行 Workflow 画布"
          onClick={(event) => {
            if (event.target === event.currentTarget) openModal();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openModal();
            }
          }}
        >
          <RuntimeCanvasSurface
            model={model}
            geometry={geometry}
            runtime={runtime}
            project={project}
            mode="preview"
            selectedNodeId={selectedNodeId}
            onSelectNode={(node) => {
              setSelectedNodeId(node.id);
              openModal();
            }}
            onOpen={openModal}
            expandedGroupIds={expandedGroupIds}
            onToggleGroup={toggleGroup}
          />
        </div>
        <div className="workflow-runtime-path" aria-label="最近实际路径">
          <span>Cycle {project.cycle}</span>
          {runtime.recentInvocationPath.length
            ? runtime.recentInvocationPath.slice(-8).map((entry, index) => (
              <span key={`${entry.invocationId ?? entry.nodeId}-${index}`} className={`runtime-path-state-${entry.state}`}>
                {index ? " → " : ""}{entry.nodeId}{entry.state === "completed" ? " ✓" : entry.state === "running" ? " ·" : ""}
              </span>
            ))
            : <span>尚无实际调用</span>}
        </div>
        <ProjectGitReadonlyFacts project={project} onOpenGitTree={() => setGitTreeOpen(true)} />
        <FailureAttemptHistory project={project} />
      </section>
      {modalOpen && (
        <RuntimeCanvasDialog
          model={model}
          geometry={geometry}
          runtime={runtime}
          project={project}
          events={events}
          harnesses={harnesses}
          mode="modal"
          selectedNodeId={selectedNodeId}
          onSelectNode={(node) => setSelectedNodeId(node.id)}
          expandedGroupIds={expandedGroupIds}
          onToggleGroup={toggleGroup}
          onClose={closeModal}
        />
      )}
      {gitTreeOpen && <GitTreeDialog project={project} onClose={() => setGitTreeOpen(false)} />}
    </>
  );
}

/** Small helper used by browser audits and tests to inspect curve bounds. */
export function runtimeGeometryPoints(geometry: readonly EdgeGeometry[]): CanvasPoint[] {
  return geometry.flatMap((edge) => edge.samples);
}
