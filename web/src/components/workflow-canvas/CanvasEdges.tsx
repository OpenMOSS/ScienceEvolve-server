import { memo, useCallback, useId, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { canvasNodeSize, type CanvasEdge as CanvasModelEdge, type CanvasNode } from "./core/canvas-model";
import { canvasPortPoint } from "./core/canvas-router";
import type { WorkflowCanvasPort } from "../../types";
import type { RuntimeEdgeState } from "./core/workflow-runtime";

export type CanvasEdgeKind = "strong" | "weak" | "parallel" | "termination" | "main-dispatch";
export type CanvasEdgeFocusMode = "selected" | "hover";

export interface CanvasEdgeGeometry {
  id: string;
  path: string;
  midpoint: { x: number; y: number };
  kind: CanvasEdgeKind;
  source?: string;
  target?: string;
  label?: string;
  fixed?: boolean;
  sourcePort?: string;
  targetPort?: string;
  sourcePortPinned?: boolean;
  targetPortPinned?: boolean;
  points?: readonly { x: number; y: number }[];
  samples?: readonly { x: number; y: number }[];
  reroutedBecauseBlocked?: boolean;
  runtimeState?: RuntimeEdgeState;
  /** Used only while atomically cross-fading a required port change. */
  visualOpacity?: number;
  transitionGhost?: boolean;
  loop?: CanvasModelEdge["loop"];
}

export interface CanvasEdgesProps {
  edges: CanvasEdgeGeometry[];
  selectedEdgeId?: string;
  selectedEdgeIds?: ReadonlySet<string>;
  selectedLoopId?: string;
  relatedEdgeIds?: ReadonlySet<string>;
  mutedEdgeIds?: ReadonlySet<string>;
  focusedNodeId?: string;
  focusMode?: CanvasEdgeFocusMode;
  nodes?: readonly CanvasNode[];
  pendingPath?: string;
  pendingKind?: Exclude<CanvasEdgeKind, "main-dispatch">;
  pendingInvalid?: boolean;
  onSelectEdge?: (edge: CanvasEdgeGeometry) => void;
  /** Runtime surfaces render edges as a passive overlay, without hit targets. */
  interactive?: boolean;
  /** Passive runtime edges still show their information direction on selection. */
  flowFixedEdges?: boolean;
  /** Suppress decorative filters/particles during large-graph gestures. */
  moving?: boolean;
}

export const CanvasEdges = memo(function CanvasEdges({
  edges,
  selectedEdgeId,
  selectedEdgeIds,
  selectedLoopId,
  relatedEdgeIds,
  mutedEdgeIds,
  focusedNodeId,
  focusMode,
  nodes = [],
  pendingPath,
  pendingKind = "strong",
  pendingInvalid = false,
  onSelectEdge,
  interactive = true,
  flowFixedEdges = false,
  moving = false
}: CanvasEdgesProps) {
  const prefix = `canvas-${useId().replace(/:/g, "")}`;
  const [hoveredControlId, setHoveredControlId] = useState<string>();
  const mainControls = useMemo(() => interactive
    ? buildMainControls(edges.filter((edge) => !edge.transitionGhost), nodes, focusedNodeId, relatedEdgeIds)
    : [], [edges, focusedNodeId, interactive, nodes, relatedEdgeIds]);
  const orderedEdges = useMemo(() => [...edges].sort((left, right) => {
    const leftLayer = left.kind === "main-dispatch" ? 0 : 1;
    const rightLayer = right.kind === "main-dispatch" ? 0 : 1;
    return leftLayer - rightLayer || left.id.localeCompare(right.id);
  }), [edges]);
  const loopStyles = useMemo(() => {
    const ids = [...new Set(edges.flatMap((edge) => edge.loop ? [edge.loop.id] : []))].sort();
    return new Map(ids.map((id, index) => {
      const hue = 185 + (index * 170) / Math.max(1, ids.length);
      return [id, {
        color: `hsl(${hue} 62% 43%)`,
        glow: `hsl(${hue} 70% 48% / .6)`,
        marker: `${prefix}-loop-${index}`
      }] as const;
    }));
  }, [edges, prefix]);
  const dispatchEdges = useMemo(() => edges.filter((edge) => edge.kind === "main-dispatch" && !edge.transitionGhost), [edges]);
  const dispatchBadge = useMemo(() => {
    if (!dispatchEdges.length) return undefined;
    const main = nodes.find((node) => node.id === "main");
    if (!main) return undefined;
    const sourcePort = (dispatchEdges[0].sourcePort ?? "right") as WorkflowCanvasPort;
    const anchor = canvasPortPoint(main, sourcePort);
    const offset = sourcePort === "left"
      ? { x: -38, y: -28 }
      : sourcePort === "top"
        ? { x: 30, y: -23 }
        : sourcePort === "bottom"
          ? { x: 30, y: 29 }
          : { x: 38, y: -28 };
    return { x: anchor.x + offset.x, y: anchor.y + offset.y };
  }, [dispatchEdges, nodes]);
  const selectionRef = useRef(onSelectEdge);
  selectionRef.current = onSelectEdge;
  const select = useCallback((edge: CanvasEdgeGeometry) => {
    if (!edge.fixed) selectionRef.current?.(edge);
  }, []);
  const dense = edges.length >= 40;

  return (
    <svg className={`edge-layer${dense ? " is-dense" : ""}${moving ? " is-moving" : ""}`} width="100%" height="100%" aria-label="Agent 连接">
      <defs>
        <EdgeMarker id={`${prefix}-strong`} color="#25714e" />
        <EdgeMarker id={`${prefix}-weak`} color="#b56f17" />
        <ParallelEdgeMarker id={`${prefix}-parallel`} color="#2159b5" />
        <EdgeMarker id={`${prefix}-termination`} color="#a65365" />
        <EdgeMarker id={`${prefix}-main-dispatch`} color="#607968" size={12} />
        <EdgeMarker id={`${prefix}-loop-exit`} color="#247b8a" />
        <EdgeMarker id={`${prefix}-strong-highlight`} color="#25714e" size={18} />
        <EdgeMarker id={`${prefix}-weak-highlight`} color="#b56f17" size={18} />
        <ParallelEdgeMarker id={`${prefix}-parallel-highlight`} color="#174b9e" size={18} />
        <EdgeMarker id={`${prefix}-termination-highlight`} color="#a65365" size={18} />
        <EdgeMarker id={`${prefix}-main-dispatch-highlight`} color="#4f7c61" size={16} />
        <EdgeMarker id={`${prefix}-loop-exit-highlight`} color="#167184" size={18} />
        {[...loopStyles.values()].map((style) => <EdgeMarker key={style.marker} id={style.marker} color={style.color} />)}
        {[...loopStyles.values()].map((style) => <EdgeMarker key={`${style.marker}-highlight`} id={`${style.marker}-highlight`} color={style.color} size={18} />)}
      </defs>
      <g className="main-control-layer" aria-hidden="true">
        {mainControls.map((control) => {
          const revealed = control.revealed || hoveredControlId === control.id;
          return (
            <g
              key={control.id}
              className={`main-control-hub ${revealed ? "is-revealed" : ""}`}
              data-control-group={control.id}
              onMouseEnter={() => setHoveredControlId(control.id)}
              onMouseLeave={() => setHoveredControlId((current) => current === control.id ? undefined : current)}
            >
              <path className="main-control-link" d={control.path} />
              {control.branches.map((branch, index) => <path key={index} className={`main-control-branch ${branch.termination ? "termination" : ""}`} d={branch.path} />)}
              <circle className="main-control-hub-hit" cx={control.hub.x} cy={control.hub.y} r="22" />
              <circle className="main-control-hub-ring" cx={control.hub.x} cy={control.hub.y} r="14" />
              <circle className="main-control-hub-core" cx={control.hub.x} cy={control.hub.y} r="9" />
              <text x={control.hub.x} y={control.hub.y + 4} textAnchor="middle">M</text>
              <text className="main-control-hub-caption" x={control.hub.x} y={control.hub.y + 27} textAnchor="middle">MAIN 决策</text>
            </g>
          );
        })}
      </g>
      {dispatchBadge && (
        <g className="main-dispatch-badge" transform={`translate(${round(dispatchBadge.x)} ${round(dispatchBadge.y)})`} role="img" aria-label="系统调度：Main 固定调度出口">
          <rect x={-29} y={-9} width={58} height={18} rx={5} />
          <text x={0} y={3} textAnchor="middle">系统调度</text>
          <title>Main 到外层节点的固定调度边</title>
        </g>
      )}
      <g className="edges">
        {orderedEdges.map((edge) => <CanvasEdgeView
          key={edge.id} edge={edge} prefix={prefix}
          selected={selectedEdgeId === edge.id || Boolean(selectedEdgeIds?.has(edge.id)) || Boolean(selectedLoopId && edge.loop?.id === selectedLoopId)}
          related={relatedEdgeIds?.has(edge.id) ?? false} muted={mutedEdgeIds?.has(edge.id) ?? false}
          focusedNodeId={focusedNodeId} focusMode={focusMode} interactive={interactive} select={select}
          loopStyle={edge.loop && edge.loop.role !== "exit" ? loopStyles.get(edge.loop.id) : undefined}
        />)}
      </g>
      <g className="flow-particle-layer" aria-hidden="true">
        {(!moving ? edges : []).map((edge) => {
          const relatedToNode = Boolean(focusedNodeId && relatedEdgeIds?.has(edge.id));
          const selectedLoopEdge = Boolean(selectedLoopId && edge.loop?.id === selectedLoopId);
          const selectedLoopExit = selectedLoopEdge && edge.loop?.role === "exit";
          const selectedEdge = selectedEdgeId === edge.id || Boolean(selectedEdgeIds?.has(edge.id));
          if (dense && selectedEdgeId !== edge.id) return null;
          if ((!relatedToNode && !selectedLoopEdge && !selectedEdge) || (edge.fixed && !selectedLoopExit && !flowFixedEdges) || edge.transitionGhost) return null;
          const pathId = `${prefix}-path-${sanitizeId(edge.id)}`;
          const direction = relatedToNode && edge.target === focusedNodeId ? "incoming" : "outgoing";
          const loopStyle = edge.loop && edge.loop.role !== "exit" ? loopStyles.get(edge.loop.id) : undefined;
          return <FlowParticle key={edge.id} routeId={edge.id} pathId={pathId} kind={edge.kind} direction={direction} loopColor={selectedLoopExit ? "#247b8a" : loopStyle?.color} loopGlow={selectedLoopExit ? "rgba(36,123,138,.58)" : loopStyle?.glow} />;
        })}
      </g>
      {pendingPath && <path className={`pending-edge ${pendingInvalid ? "invalid" : pendingKind}`} d={pendingPath} markerEnd={`url(#${prefix}-${pendingInvalid ? "termination" : pendingKind})`} />}
    </svg>
  );
});

type CanvasEdgeViewProps = {
  edge: CanvasEdgeGeometry;
  prefix: string;
  selected: boolean;
  related: boolean;
  muted: boolean;
  focusedNodeId?: string;
  focusMode?: CanvasEdgeFocusMode;
  interactive: boolean;
  select: (edge: CanvasEdgeGeometry) => void;
  loopStyle?: { color: string; glow: string; marker: string };
};

const CanvasEdgeView = memo(function CanvasEdgeView({
  edge, prefix, selected, related, muted, focusedNodeId, focusMode, interactive, select, loopStyle
}: CanvasEdgeViewProps) {
  const pointsJson = useMemo(() => edge.points ? JSON.stringify(edge.points) : undefined, [edge.points]);
  const samplesJson = useMemo(() => edge.samples ? JSON.stringify(edge.samples) : undefined, [edge.samples]);
  const outgoing = related && edge.source === focusedNodeId;
  const incoming = related && edge.target === focusedNodeId;
  const focusClass = related
    ? focusMode === "hover"
      ? outgoing
        ? "is-outgoing-highlight"
        : incoming
          ? "is-incoming-context"
          : "is-related-highlight"
      : "is-related-highlight"
    : undefined;
  const focusStateClasses = [
    selected && "is-selected",
    focusClass,
    muted && "is-unrelated-muted"
  ].filter(Boolean).join(" ");
  const highlighted = related || selected;
  const edgeLabel = edge.kind === "main-dispatch"
    ? (focusedNodeId && focusedNodeId !== "main" && focusedNodeId === edge.target ? `目标：${edge.target}` : undefined)
    : edge.label;
  const visualKind = edge.loop?.role === "return"
    ? "loop-return"
    : edge.loop?.role === "member"
      ? "loop-member"
    : edge.loop?.role === "exit"
      ? "loop-exit"
      : edge.kind;
  const pathId = `${prefix}-path-${sanitizeId(edge.id)}`;
  const classes = [
    "workflow-edge-group",
    `is-${edge.kind}`,
    edge.loop && `is-${visualKind}`,
    edge.fixed && "is-fixed",
    edge.runtimeState && `runtime-edge-${edge.runtimeState}`,
    focusStateClasses
  ].filter(Boolean).join(" " );
  const markerId = loopStyle
    ? `${loopStyle.marker}${highlighted ? "-highlight" : ""}`
    : `${prefix}-${visualKind}${highlighted ? "-highlight" : ""}`;
  return (
    <g
      className={classes}
      data-edge-id={edge.id}
      data-edge-source={edge.source}
      data-edge-target={edge.target}
      data-loop-id={edge.loop?.id}
      data-loop-role={edge.loop?.role}
      data-edge-source-port={edge.sourcePort}
      data-edge-target-port={edge.targetPort}
      data-route-points={edge.points ? pointsJson : undefined}
      data-route-samples={edge.samples ? samplesJson : undefined}
      data-route-midpoint={JSON.stringify(edge.midpoint)}
      data-route-change-reason={edge.reroutedBecauseBlocked ? "blocked-by-dragged-node" : undefined}
      data-layout-transition={edge.transitionGhost ? "exiting" : edge.visualOpacity !== undefined ? "entering" : undefined}
      style={{
        ...(edge.visualOpacity === undefined ? {} : { opacity: edge.visualOpacity }),
        ...(loopStyle ? { "--loop-color": loopStyle.color, "--loop-glow": loopStyle.glow } : {})
      } as CSSProperties}
      role={interactive && !edge.fixed && !edge.transitionGhost ? "button" : undefined}
      tabIndex={interactive && !edge.fixed && !edge.transitionGhost ? 0 : undefined}
      aria-label={`${edge.loop && edge.loop.role !== "exit" ? `Loop ${edge.loop.id}：${edge.source} → ${edge.target}` : edge.label ?? edgeKindLabel(edge.kind)}${edge.loop?.role === "exit" ? "，只读批次退出边" : edge.fixed ? "，系统固定连线" : ""}`}
      onClick={(event: ReactMouseEvent<SVGGElement>) => { if (!interactive) return; event.stopPropagation(); select(edge); }}
      onKeyDown={(event) => { if (interactive && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); select(edge); } }}
    >
      <path className={`workflow-edge-halo ${edge.kind} ${visualKind} ${focusStateClasses}`} d={edge.path} />
      <path id={pathId} className={`workflow-edge ${edge.kind} ${visualKind} ${focusStateClasses}`} d={edge.path} markerEnd={`url(#${markerId})`} />
      {interactive && !edge.fixed && !edge.transitionGhost && <path className="edge-hit" d={edge.path} />}
      {edgeLabel && !edge.transitionGhost && (
        <g className={`edge-label ${edge.kind} ${visualKind} ${focusStateClasses}`} transform={`translate(${edge.midpoint.x} ${edge.midpoint.y})`}>
          <rect x={-Math.max(19, edgeLabel.length * 4.8)} y={-9} width={Math.max(38, edgeLabel.length * 9.6)} height={18} rx={5} />
          <text textAnchor="middle" dominantBaseline="central">{edgeLabel}</text>
        </g>
      )}
    </g>
  );
}, (before, after) => {
  if (before.prefix !== after.prefix || before.selected !== after.selected || before.related !== after.related
    || before.muted !== after.muted || before.focusedNodeId !== after.focusedNodeId || before.focusMode !== after.focusMode
    || before.interactive !== after.interactive || before.select !== after.select
    || before.loopStyle?.color !== after.loopStyle?.color || before.loopStyle?.marker !== after.loopStyle?.marker) return false;
  const a = before.edge;
  const b = after.edge;
  return a === b || (a.id === b.id && a.path === b.path && a.kind === b.kind && a.fixed === b.fixed
    && a.source === b.source && a.target === b.target && a.label === b.label && a.runtimeState === b.runtimeState
    && a.sourcePort === b.sourcePort && a.targetPort === b.targetPort
    && a.sourcePortPinned === b.sourcePortPinned && a.targetPortPinned === b.targetPortPinned
    && a.points === b.points && a.samples === b.samples && a.midpoint.x === b.midpoint.x && a.midpoint.y === b.midpoint.y
    && a.reroutedBecauseBlocked === b.reroutedBecauseBlocked && a.transitionGhost === b.transitionGhost
    && a.visualOpacity === b.visualOpacity && a.loop?.id === b.loop?.id && a.loop?.role === b.loop?.role);
});

function FlowParticle({ routeId, pathId, kind, direction, loopColor, loopGlow }: {
  routeId: string;
  pathId: string;
  kind: CanvasEdgeKind;
  direction: "incoming" | "outgoing";
  loopColor?: string;
  loopGlow?: string;
}) {
  const duration = kind === "termination" ? "2.65s" : kind === "weak" ? "2.9s" : "2.35s";
  return (
    <g className={`flow-particle ${kind} is-${direction}-flow is-related-flow${loopColor ? " is-loop-flow" : ""}`} data-flow-edge={pathId} data-flow-route={routeId} style={loopColor ? { "--loop-color": loopColor, "--loop-glow": loopGlow } as CSSProperties : undefined}>
      <line className="flow-particle-tail-line" x1="-21" x2="-4" y1="0" y2="0" />
      <circle className="flow-particle-tail" r="2.7" cx="-13" cy="0" />
      <circle className="flow-particle-halo" r="11.5" cx="0" cy="0" />
      <circle className="flow-particle-core" r="5.1" cx="0" cy="0" />
      <circle className="flow-particle-glint" r="1.25" cx="-1.4" cy="-1.4" />
      <animateMotion calcMode="linear" dur={duration} repeatCount="indefinite" rotate="auto"><mpath href={`#${pathId}`} /></animateMotion>
    </g>
  );
}

type MainControl = {
  id: string;
  path: string;
  hub: { x: number; y: number };
  branches: { path: string; termination: boolean }[];
  revealed: boolean;
};

function buildMainControls(
  edges: readonly CanvasEdgeGeometry[],
  nodes: readonly CanvasNode[],
  focusedNodeId: string | undefined,
  relatedEdgeIds: ReadonlySet<string> | undefined
): MainControl[] {
  const main = nodes.find((node) => node.id === "main");
  // Direct-edge workflows expose Main's fixed fan-out as the visible control
  // rail. Selector-mode workflows use the separate decision hubs below.
  if (!main || edges.some((edge) => edge.fixed && edge.kind === "main-dispatch")) return [];
  const grouped = new Map<string, CanvasEdgeGeometry[]>();
  for (const edge of edges) {
    if (edge.kind !== "weak" || edge.fixed || !edge.source || edge.source === "input") continue;
    const group = grouped.get(edge.source) ?? [];
    group.push(edge);
    grouped.set(edge.source, group);
  }
  const mainSize = canvasNodeSize(main);
  const mainCenter = { x: main.x + mainSize.width / 2, y: main.y + mainSize.height / 2 };
  return Array.from(grouped.entries()).flatMap(([source, group]) => {
    const hub = group.reduce((sum, edge) => ({ x: sum.x + edge.midpoint.x, y: sum.y + edge.midpoint.y }), { x: 0, y: 0 });
    hub.x /= group.length;
    hub.y /= group.length;
    const dx = hub.x - mainCenter.x;
    const dy = hub.y - mainCenter.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const clearance = Math.max(mainSize.width, mainSize.height) / 2 + 28;
    if (distance < clearance) {
      hub.x = mainCenter.x + (dx || 1) / distance * clearance;
      hub.y = mainCenter.y + dy / distance * clearance;
    }
    const anchor = controlAnchor(main, hub);
    const branches = group.map((edge) => ({
      path: controlCurvePath(hub, edge.midpoint),
      termination: edge.kind === "termination"
    }));
    return [{
      id: source,
      path: controlCurvePath(anchor, hub),
      hub,
      branches,
      revealed: focusedNodeId === "main" || group.some((edge) => relatedEdgeIds?.has(edge.id))
    }];
  });
}

function controlAnchor(node: CanvasNode, target: { x: number; y: number }) {
  const size = canvasNodeSize(node);
  const center = { x: node.x + size.width / 2, y: node.y + size.height / 2 };
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: dx >= 0 ? node.x + size.width : node.x, y: center.y };
  return { x: center.x, y: dy >= 0 ? node.y + size.height : node.y };
}

function controlCurvePath(start: { x: number; y: number }, end: { x: number; y: number }): string {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.max(24, Math.min(120, Math.hypot(dx, dy) * .36));
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const control1 = horizontal ? { x: start.x + Math.sign(dx || 1) * distance, y: start.y } : { x: start.x, y: start.y + Math.sign(dy || 1) * distance };
  const control2 = horizontal ? { x: end.x - Math.sign(dx || 1) * distance, y: end.y } : { x: end.x, y: end.y - Math.sign(dy || 1) * distance };
  return `M ${round(start.x)} ${round(start.y)} C ${round(control1.x)} ${round(control1.y)}, ${round(control2.x)} ${round(control2.y)}, ${round(end.x)} ${round(end.y)}`;
}

function round(value: number): number { return Math.round(value * 10) / 10; }
function sanitizeId(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, "_"); }

function EdgeMarker({ id, color, size = 14 }: { id: string; color: string; size?: number }) {
  return (
    <marker id={id} markerWidth={size} markerHeight={size} refX={size - 2} refY={size / 2} orient="auto" markerUnits="userSpaceOnUse">
      <path d={`M 0 0 L ${size} ${size / 2} L 0 ${size} z`} fill={color} />
    </marker>
  );
}

function ParallelEdgeMarker({ id, color, size = 14 }: { id: string; color: string; size?: number }) {
  return (
    <marker id={id} markerWidth={size} markerHeight={size} refX={size - 2} refY={size / 2} orient="auto" markerUnits="userSpaceOnUse">
      <path d={`M 1 1 L ${size / 2} ${size / 2} L 1 ${size - 1} M ${size / 2 - 2} 1 L ${size - 2} ${size / 2} L ${size / 2 - 2} ${size - 1}`} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </marker>
  );
}

function edgeKindLabel(kind: CanvasEdgeKind): string {
  if (kind === "strong") return "强边";
  if (kind === "weak") return "弱边";
  if (kind === "parallel") return "并行入口";
  if (kind === "termination") return "结束连线";
  return "Main 固定调度连线";
}
