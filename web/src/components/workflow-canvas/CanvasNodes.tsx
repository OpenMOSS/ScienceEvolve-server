import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, type RefCallback } from "react";
import type { WorkflowCanvasPort } from "../../types";
import type { CanvasNode as WorkflowCanvasNode } from "./core/canvas-model";
import { runtimeNodeLabel, type RuntimeNodeState } from "./core/workflow-runtime";

const PORTS: WorkflowCanvasPort[] = ["top", "right", "bottom", "left"];

export interface CanvasNodePresentation {
  title: string;
  description: string;
  modelLabel: string;
  initials?: string;
  color?: string;
  softColor?: string;
  accentClassName?: string;
}

export interface CanvasNodesProps {
  nodes: WorkflowCanvasNode[];
  terminalNodeIds?: ReadonlySet<string>;
  selectedNodeId?: string;
  draggingNodeId?: string;
  connectionSourceId?: string;
  connectionTargetId?: string;
  invalidTargetId?: string;
  rejectedConnectionNodeId?: string;
  rejectedConnectionPulse?: number;
  usedPorts?: ReadonlySet<string>;
  compact?: boolean;
  /** Hide group member rows without changing node keyboard affordances. */
  suppressGroupMembers?: boolean;
  readOnly?: boolean;
  /** Runtime layout gestures move presentation only; editing stays disabled. */
  allowLayoutDragging?: boolean;
  resolvePresentation?: (node: WorkflowCanvasNode) => CanvasNodePresentation;
  onSelectNode?: (node: WorkflowCanvasNode) => void;
  onNodePointerDown?: (event: ReactPointerEvent<HTMLElement>, node: WorkflowCanvasNode) => void;
  onNodePointerEnter?: (node: WorkflowCanvasNode) => void;
  onNodePointerLeave?: (node: WorkflowCanvasNode) => void;
  onPortPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>, node: WorkflowCanvasNode, port: WorkflowCanvasPort) => void;
  onPortPointerEnter?: (node: WorkflowCanvasNode, port: WorkflowCanvasPort) => void;
  onPortPointerLeave?: (node: WorkflowCanvasNode, port: WorkflowCanvasPort) => void;
  onEditNode?: (node: WorkflowCanvasNode) => void;
  onNodeResize?: (nodeId: string, size: { width: number; height: number }) => void;
  runtimeNodeStates?: Readonly<Record<string, RuntimeNodeState>>;
  runtimeExecutionCounts?: Readonly<Record<string, number>>;
  /** Shared side used by Main's fixed system fan-out. */
  dispatchPort?: WorkflowCanvasPort;
  /** Hide editor-only port affordances in read-only runtime surfaces. */
  showPorts?: boolean;
  expandedGroupIds?: ReadonlySet<string>;
  onToggleGroup?: (groupId: string) => void;
  groupMemberStates?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export function CanvasNodes({
  nodes,
  terminalNodeIds,
  selectedNodeId,
  draggingNodeId,
  connectionSourceId,
  connectionTargetId,
  invalidTargetId,
  rejectedConnectionNodeId,
  rejectedConnectionPulse = 0,
  usedPorts,
  compact = false,
  suppressGroupMembers = false,
  readOnly = false,
  allowLayoutDragging = false,
  resolvePresentation = defaultPresentation,
  onSelectNode,
  onNodePointerDown,
  onNodePointerEnter,
  onNodePointerLeave,
  onPortPointerDown,
  onPortPointerEnter,
  onPortPointerLeave,
  onEditNode,
  onNodeResize,
  runtimeNodeStates,
  runtimeExecutionCounts,
  dispatchPort = "right",
  showPorts = true
  , expandedGroupIds
  , onToggleGroup
  , groupMemberStates
}: CanvasNodesProps) {
  const nodeElementsRef = useRef(new Map<string, HTMLElement>());
  const resizeObserverRef = useRef<ResizeObserver>();
  const onNodeResizeRef = useRef(onNodeResize);
  onNodeResizeRef.current = onNodeResize;
  // Layout previews update every animation frame, so `nodes` is intentionally
  // a new array while coordinates interpolate.  Rebuilding the ResizeObserver
  // for every one of those frames forces the browser to disconnect/reconnect
  // every card and can turn a 240ms transition into a visibly stuttering long
  // task.  Only the set of mounted node ids needs to drive observer lifecycle.
  const nodeIdsKey = useMemo(
    () => nodes.map((node) => node.id).sort().join("\0"),
    [nodes]
  );

  const measure = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    const nodeId = element.dataset.nodeId;
    if (!nodeId) return;
    nodeElementsRef.current.set(nodeId, element);
    notifyNodeResize(nodeId, element, onNodeResizeRef.current);
    resizeObserverRef.current?.observe(element);
  }, []);

  useLayoutEffect(() => {
    const activeIds = new Set(nodeIdsKey ? nodeIdsKey.split("\0") : []);
    for (const id of nodeElementsRef.current.keys()) {
      if (!activeIds.has(id)) nodeElementsRef.current.delete(id);
    }
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const nodeId = element.dataset.nodeId;
        if (nodeId) notifyNodeResize(nodeId, element, onNodeResizeRef.current);
      }
    });
    resizeObserverRef.current = observer;
    for (const element of nodeElementsRef.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      if (resizeObserverRef.current === observer) resizeObserverRef.current = undefined;
    };
  }, [nodeIdsKey]);

  return (
    <div className="nodes-layer">
      {nodes.map((node) => {
        const view = resolvePresentation(node);
        const connectionRejected = rejectedConnectionNodeId === node.id;
        const isMain = node.kind === "agent" && node.name === "main";
        const isCollaboration = Boolean(node.collaboration);
        // Compact cards intentionally never render member rows. The owning
        // page keeps the preference in `expandedGroupIds`, so reopening the
        // full canvas restores the user's previous expansion state.
        const groupExpanded = isCollaboration && !compact && !suppressGroupMembers && (expandedGroupIds?.has(node.id) ?? false);
        const isSystem = node.kind !== "agent" || isMain;
        const isTerminal = terminalNodeIds?.has(node.id) ?? false;
        const runtimeState = runtimeNodeStates?.[node.id];
        const runtimeCount = runtimeExecutionCounts?.[node.id] ?? 0;
        const isAnchor = node.kind !== "agent" || isMain;
        const style = {
          left: node.x,
          top: node.y,
          "--agent-color": view.color,
          "--agent-soft": view.softColor
        } as CSSProperties;
        return (
          <article
            key={node.id}
            className={[
              "agent-node",
              node.kind === "input" && "is-input",
              node.kind === "finish" && "is-end",
              isMain && "is-main",
              isCollaboration && "is-collaboration",
              groupExpanded && "is-group-expanded",
              isAnchor && "is-anchor-free",
              isTerminal && "is-terminal",
              selectedNodeId === node.id && "is-selected",
              draggingNodeId === node.id && "is-dragging",
              connectionSourceId === node.id && "is-connection-source",
              connectionTargetId === node.id && "is-link-target",
              invalidTargetId === node.id && "is-link-invalid",
              connectionRejected && "is-connection-rejected",
              connectionRejected && `is-connection-rejected-${rejectedConnectionPulse % 2 === 0 ? "even" : "odd"}`,
              runtimeState && `runtime-node-${runtimeState}`,
              view.accentClassName
            ].filter(Boolean).join(" ")}
            style={style}
            data-node-id={node.id}
            ref={measure as RefCallback<HTMLElement>}
            aria-label={`${view.title} ${nodeBadge(node)}`}
            aria-selected={selectedNodeId === node.id}
            aria-invalid={invalidTargetId === node.id || connectionRejected || undefined}
            tabIndex={!compact && onSelectNode ? 0 : -1}
            onClick={() => onSelectNode?.(node)}
            onKeyDown={(event: ReactKeyboardEvent<HTMLElement>) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectNode?.(node);
              }
            }}
            onPointerDown={(event) => (!readOnly || allowLayoutDragging) && onNodePointerDown?.(event, node)}
            onPointerEnter={() => onNodePointerEnter?.(node)}
            onPointerLeave={() => onNodePointerLeave?.(node)}
          >
            <div className="node-avatar" aria-hidden="true">
              {node.kind === "input" ? <ArrowRight size={15} /> : node.kind === "finish" ? "✓" : view.initials ?? node.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="node-copy">
              <div className="node-title-row">
                <strong title={view.title}>{view.title}</strong>
                <em className={`node-badge ${node.kind === "input" ? "input" : node.kind === "finish" ? "terminal" : ""}`}>{nodeBadge(node)}</em>
                {node.kind === "agent" && isTerminal && <em className="node-badge terminal" title="已连接结束节点">✓</em>}
                {runtimeState && <em className="node-badge runtime-status" data-runtime-state={runtimeState}>{runtimeNodeLabel(runtimeState)}</em>}
              </div>
              <span title={view.description}>{view.description}</span>
              <small title={view.modelLabel}>{runtimeState ? `${runtimeNodeLabel(runtimeState)}${runtimeCount ? ` · ${runtimeCount} 次` : ""}` : view.modelLabel}</small>
              {isCollaboration && !compact && !suppressGroupMembers && <button
                type="button"
                className="collaboration-expand-button"
                aria-expanded={groupExpanded}
                aria-label={`${groupExpanded ? "收起" : "展开"}${view.title}成员`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => { event.stopPropagation(); onToggleGroup?.(node.id); }}
              >{groupExpanded ? "收起成员" : node.memberNodeRefs ? `查看 ${node.memberNodeRefs.length} 个直接节点` : `查看 ${node.memberAgentIds?.length ?? 0} 名成员`}</button>}
              {groupExpanded && <ul className="collaboration-member-list" aria-label={`${view.title}成员摘要`}>
                {node.memberNodeRefs ? node.memberNodeRefs.map((ref) => <li key={ref.nodeId}>
                  <span aria-hidden="true">•</span><strong>{ref.kind === "agent" ? ref.agentId : ref.groupId}</strong>
                  <small>{ref.kind === "agent" ? "Agent" : "协作组"} · {ref.nodeId}</small>
                </li>) : (node.memberAgentIds ?? []).map((memberId) => <li key={memberId}>
                  <span aria-hidden="true">•</span><strong>{memberId}</strong>
                  {groupMemberStates?.[node.id]?.[memberId] && <small>{groupMemberStates[node.id]![memberId]}</small>}
                </li>)}
              </ul>}
            </div>
            {!isSystem && !readOnly ? (
              <button
                type="button"
                className="node-more"
                title={`编辑 ${view.title}`}
                aria-label={`编辑 ${view.title}`}
                disabled={readOnly}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => { event.stopPropagation(); onEditNode?.(node); }}
              >⋮</button>
            ) : <span className="node-fixed-mark" title="系统节点">{node.kind === "finish" ? "✓" : isMain ? "🔒" : "•"}</span>}
            {showPorts && isMain && <span className={`main-dispatch-port ${dispatchPort}`} title="系统固定调度出口" aria-hidden="true"><i /></span>}
            {showPorts && PORTS.map((port) => {
              // Finish ports may be valid connection targets. The gesture
              // controller rejects an attempt to start from finish, while
              // keeping the target hit area visible and keyboard reachable.
              const disabled = readOnly;
              const active = usedPorts?.has(`${node.id}:${port}`);
              return (
                <button
                  key={port}
                  type="button"
                  className={`node-port ${port} ${active ? "is-used" : ""}`}
                  data-port={port}
                  title={disabled ? undefined : `从${portLabel(port)}端口连接`}
                  aria-label={`${view.title}${portLabel(port)}连接点`}
                  tabIndex={disabled ? -1 : 0}
                  disabled={disabled}
                  onPointerDown={(event) => { event.stopPropagation(); onPortPointerDown?.(event, node, port); }}
                  onPointerEnter={() => onPortPointerEnter?.(node, port)}
                  onPointerLeave={() => onPortPointerLeave?.(node, port)}
                />
              );
            })}
          </article>
        );
      })}
    </div>
  );
}

function defaultPresentation(node: WorkflowCanvasNode): CanvasNodePresentation {
  if (node.kind === "input") return { title: node.name, description: "用户提交的任务、约束和已有资料。", modelLabel: "input", color: "#446b9b", softColor: "#eaf0f7" };
  if (node.kind === "finish") return { title: node.name, description: "被指定的终止外层节点完成后进入这里。", modelLabel: "工作流结束", color: "#a65365", softColor: "#f9eaed" };
  if (node.name === "main") return { title: "Main Agent", description: "理解目标、协调上下文，并在每轮选择一个外层节点。", modelLabel: "gpt-5.6-sol", initials: "MA", color: "#25714e", softColor: "#e7f1e9" };
  if (node.collaboration) return { title: node.displayName ?? node.name, description: `${node.memberAgentIds?.length ?? 0} 名成员协作`, modelLabel: "COLLABORATION", initials: "组", color: "#5c5bd6", softColor: "#eeedff" };
  return {
    title: node.name,
    description: node.template ? `${node.template} Agent` : "Agent",
    modelLabel: node.template?.toUpperCase() ?? "AGENT",
    color: "#25714e",
    softColor: "#e7f1e9"
  };
}

function nodeBadge(node: WorkflowCanvasNode): ReactNode {
  if (node.kind === "input") return "INPUT";
  if (node.kind === "finish") return "END";
  return node.name === "main" ? "MAIN" : node.collaboration ? "GROUP" : "AGENT";
}

function portLabel(port: WorkflowCanvasPort): string {
  return ({ top: "顶部", right: "右侧", bottom: "底部", left: "左侧" } as const)[port];
}

function notifyNodeResize(
  nodeId: string,
  element: HTMLElement,
  callback: ((nodeId: string, size: { width: number; height: number }) => void) | undefined
): void {
  if (!callback) return;
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  callback(nodeId, { width, height });
}
