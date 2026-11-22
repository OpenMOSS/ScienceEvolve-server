import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import type { HarnessCatalogEntry, Project } from "../../types";
import { agentMeta } from "../../lib";
import { scopedGroupDisplayState } from "../../scoped-runtime";
import { CanvasEdges, type CanvasEdgeGeometry } from "./CanvasEdges";
import { CanvasNodes, type CanvasNodePresentation } from "./CanvasNodes";
import { CanvasWorld } from "./CanvasWorld";
import { canvasContentBounds, fitCanvasViewport, zoomCanvasViewportAt } from "./core/canvas-viewport";
import { collaborationProgress, type CollaborationDisplayState } from "./core/collaboration-activity";
import { CANVAS_WORLD_HEIGHT, CANVAS_WORLD_WIDTH, type CanvasModel, type CanvasNode, type CanvasSize, type CanvasViewport } from "./core/canvas-model";
import type { EdgeGeometry } from "./core/canvas-router";
import { useCanvasRouting } from "./useCanvasRouting";
import { runtimeNodeLabel, type RuntimeNodeState, type WorkflowRuntimeState } from "./core/workflow-runtime";

export type RuntimeCanvasSurfaceMode = "preview" | "modal";

/**
 * Read-only renderer shared by the runtime preview, live dialog and replay.
 */
export interface RuntimeCanvasSurfaceProps {
  model: CanvasModel;
  geometry: readonly EdgeGeometry[];
  runtime: WorkflowRuntimeState;
  project: Project;
  harnesses?: ReadonlyArray<Pick<HarnessCatalogEntry, "id" | "label">>;
  mode?: RuntimeCanvasSurfaceMode;
  focusNodeId?: string;
  selectedNodeId?: string;
  onSelectNode?: (node: CanvasNode) => void;
  onOpen?: () => void;
  expandedGroupIds?: ReadonlySet<string>;
  onToggleGroup?: (groupId: string) => void;
  scopeId?: string;
  replay?: boolean;
  fitBounds?: ReturnType<typeof canvasContentBounds>;
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
  contentBounds: ReturnType<typeof canvasContentBounds>,
  focusBounds?: ReturnType<typeof canvasContentBounds>
): RuntimeCanvasViewportPlan {
  const width = Math.max(1, viewportSize.width);
  const height = Math.max(1, viewportSize.height);
  const narrowModal = mode === "modal" && width < 620;
  if (!narrowModal || !contentBounds) {
    return {
      viewport: fitCanvasViewport(
        { width, height },
        mode === "preview" ? focusBounds ?? contentBounds : contentBounds,
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
  focusNodeId,
  selectedNodeId,
  onSelectNode,
  onOpen,
  expandedGroupIds,
  onToggleGroup,
  scopeId,
  replay = false,
  fitBounds
}: RuntimeCanvasSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [selectedLoopEdge, setSelectedLoopEdge] = useState<CanvasEdgeGeometry>();
  const selectedEdge = model.edges.find(edge => edge.id === selectedLoopEdge?.id &&
    edge.source === selectedLoopEdge.source && edge.target === selectedLoopEdge.target);
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
    if (replay) return runtime.nodeStates;
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
  }, [collaborationProgressById, project, replay, runtime.nodeStates]);
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
    () => planRuntimeCanvasViewport(
      mode,
      size,
      fitBounds ?? contentBounds,
      canvasContentBounds(surfaceNodes.filter((node) => node.id === focusNodeId))
    ),
    [contentBounds, fitBounds, focusNodeId, mode, size, surfaceNodes]
  );
  const [viewport, setViewport] = useState<CanvasViewport>(viewportPlan.viewport);
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

  // The preview follows content. The full canvas keeps manual framing local.
  useEffect(() => {
    if (mode === "preview" || !userViewportRef.current) {
      setViewport(viewportPlan.viewport);
    }
  }, [mode, viewportPlan.viewport]);

  const resolvePresentation = useCallback((node: CanvasNode): CanvasNodePresentation => {
    if (node.kind === "input") {
      return { title: scopeId ? "进入协作组" : "用户输入", description: "流程输入", modelLabel: "INPUT", color: "#446b9b", softColor: "#eaf0f7" };
    }
    if (node.kind === "finish") {
      return { title: scopeId ? "结束协作组" : "结束", description: "真实终止路径", modelLabel: "END", color: "#a65365", softColor: "#f9eaed" };
    }
    if (node.gate) return { title: node.gate.name, description: node.gate.verifier.kind === "code" ? "前序 Agent 检查" : `检查 Agent：${node.gate.verifier.agentId}`, modelLabel: "GATE", initials: "G", color: "#b56f17", softColor: "#fff2d9" };
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
  }, [collaborationProgressById, project.orchestration.agents, reconciledNodeStates, runtime.nodeStates, scopeId]);

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
    if (mode !== "modal") return;
    event.preventDefault();
    event.stopPropagation();
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
      compact={mode === "preview"}
      worldWidth={CANVAS_WORLD_WIDTH}
      worldHeight={CANVAS_WORLD_HEIGHT}
      className="workflow-runtime-world"
      onWheel={onRuntimeWheel}
      onClick={handleWorldClick}
      data-canvas-layout-phase="idle"
      data-canvas-geometry-valid={geometryValid ? "true" : "false"}
      aria-label={mode === "preview" ? "运行 Workflow 缩略画布，点击打开大画布" : replay ? "历史 Workflow 大画布" : "运行 Workflow 大画布"}
    >
      <CanvasEdges
        edges={renderedEdges}
        nodes={surfaceNodes}
        focusedNodeId={selectedEdge ? undefined : selectedNodeId ?? focusNodeId ?? runtime.currentNodeId}
        selectedLoopId={selectedEdge?.loop?.id}
        selectedEdgeId={selectedEdge?.id}
        focusMode="selected"
        interactive={false}
        flowFixedEdges
        onSelectEdge={setSelectedLoopEdge}
      />
      <CanvasNodes
        nodes={surfaceNodes}
        suppressGroupMembers={mode === "preview"}
        tabbableNodeId={mode === "preview" ? focusNodeId : undefined}
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
          setSelectedLoopEdge(undefined);
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
        data-runtime-focus-node={mode === "preview" ? focusNodeId : undefined}
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
