import type { ReactNode } from "react";
import { ArrowLeft, GitBranch, Layers3, Plus } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type {
  AgentConfig,
  AgentMcpServer,
  AgentOrchestrationTemplate,
  AgentsConfig,
  FixedMcpDefinition,
  GatewayRecord,
  HarnessCatalogEntry,
  ScopedCollaboration,
  ScopedWorkflow,
  SkillDefinition,
  WorkflowCanvasEdgeLayout,
  WorkflowCanvasPort
} from "../../types";
import { CanvasEdges } from "./CanvasEdges";
import { CanvasInspector } from "./CanvasInspector";
import { CanvasNodes } from "./CanvasNodes";
import { CanvasToolbar } from "./CanvasToolbar";
import { CanvasWorld } from "./CanvasWorld";
import { canvasEdgeId, decorateCanvasLoops, loopExitCanvasEdgeId, relativePort, withCanvasLoopPresentation } from "./core/canvas-layout";
import { canvasNodeSize, type CanvasEdge, type CanvasNode } from "./core/canvas-model";
import type { CanvasSize, CanvasViewport } from "./core/canvas-model";
import { buildLockedEdgeRoutesFromSnapshot, canvasPortPoint, captureRouteLock, type DragRouteLock } from "./core/canvas-router";
import { useCanvasRouting } from "./useCanvasRouting";
import { useCanvasPointerFrame } from "./useCanvasPointerFrame";
import { canvasRoutingKey, needsBackgroundRouting } from "./core/canvas-routing-service";
import { canvasContentBounds, fitCanvasViewport, zoomCanvasViewportAt } from "./core/canvas-viewport";
import { buildCanvasLayoutPlan } from "./core/canvas-layout-plan";
import { scopedCanvasPlanningOrchestration } from "./core/scoped-canvas-layout";
import { reconcileLoopTopology } from "./core/workflow-loop-editor";
import {
  addScopedAgentReference,
  addScopedGroup,
  addScopedRoute,
  defaultScopedCanvas,
  removeScopedNode,
  removeScopedRoute,
  scopedWorkflowError
} from "./core/scoped-workflow";

type RouteKind = "strong" | "weak";
type LinkStart = { source: string; port: WorkflowCanvasPort };
type LinkTarget = { id: string; port: WorkflowCanvasPort };
type LinkGesture = { pointerId: number; clientX: number; clientY: number; moved: boolean };
type PointerSample = Pick<PointerEvent, "pointerId" | "clientX" | "clientY" | "type" | "target">;
type NodeDrag = { id: string; pointerId: number; clientX: number; clientY: number; x: number; y: number; zoom: number };
type CanvasPan = { pointerId: number; clientX: number; clientY: number; viewport: CanvasViewport };
type PendingSharedEdit = { agentId: string; label: string; apply: () => void | Promise<void>; cancel?: () => void; preserveDrafts?: boolean };
type ScopedHistoryEntry = Pick<AgentOrchestrationTemplate, "collaborations"> & {
  groups: ScopedCollaboration[];
};

function scopedHistoryEntry(orchestration: AgentOrchestrationTemplate): ScopedHistoryEntry {
  return {
    groups: structuredClone(orchestration.scopedWorkflow?.groups ?? []),
    collaborations: structuredClone(orchestration.collaborations)
  };
}

function scopedHistorySignature(value: ScopedHistoryEntry): string {
  return JSON.stringify(value);
}

function scopedLoopTopology(workflow: ScopedWorkflow) {
  return {
    agents: workflow.nodes.map((ref) => ({ name: ref.nodeId })),
    routes: workflow.routes,
    loops: workflow.loops,
    termination: { agent: "finish" }
  };
}

function scopedStrongEdges(workflow: ScopedWorkflow) {
  return Object.entries(workflow.routes).flatMap(([source, routes]) => routes
    .filter((route) => route.kind === "strong" && route.target !== "finish")
    .map((route) => ({ source, target: route.target })));
}

export interface ScopedWorkflowEditorProps {
  orchestration: AgentOrchestrationTemplate;
  agents: AgentsConfig;
  groupId: string;
  readOnly?: boolean;
  inspectorTabs?: ReactNode;
  inspectorContent?: ReactNode;
  agentHarnessConstraint?: (agentId: string) => { harnessId: string; reason: string } | undefined;
  lockedGroupIds?: ReadonlySet<string>;
  skills?: SkillDefinition[];
  onAddSkill?: (title: string, content: string) => Promise<SkillDefinition>;
  mcpOptions?: AgentMcpServer[];
  mcpDirectory?: FixedMcpDefinition[];
  gateways?: GatewayRecord[];
  harnesses?: HarnessCatalogEntry[];
  isAgentLocked: (agentId: string) => boolean;
  onSharedAgentPatch: (agentId: string, patch: Partial<AgentConfig>) => void;
  onSharedAgentRename: (agentId: string, value: string) => void;
  onSharedAgentDescriptionChange: (agentId: string, value: string) => void;
  onSharedAgentMcpAdd: (agentId: string, name: string, url: string) => Promise<AgentMcpServer>;
  onSharedAgentMcpToggle: (agentId: string, server: AgentMcpServer, enabled: boolean) => void;
  onChange: (value: AgentOrchestrationTemplate) => void;
  onNavigate: (groupId?: string) => void;
}

export function ScopedWorkflowEditor(props: ScopedWorkflowEditorProps) {
  if (!props.orchestration.scopedWorkflow?.groups.some((group) => group.id === props.groupId)) {
    return <div role="alert">协作组 {props.groupId} 不存在。<button type="button" onClick={() => props.onNavigate()}>返回项目</button></div>;
  }
  return <ScopedWorkflowEditorSurface {...props} />;
}

function ScopedWorkflowEditorSurface({
  orchestration, agents, groupId, readOnly = false, inspectorTabs, inspectorContent, agentHarnessConstraint, lockedGroupIds = new Set(),
  skills = [], onAddSkill, mcpOptions, mcpDirectory = [], gateways = [], harnesses = [],
  isAgentLocked, onSharedAgentPatch, onSharedAgentRename, onSharedAgentDescriptionChange,
  onSharedAgentMcpAdd, onSharedAgentMcpToggle, onChange, onNavigate
}: ScopedWorkflowEditorProps) {
  const contract = orchestration.scopedWorkflow!;
  const group = contract.groups.find((item) => item.id === groupId)!;
  const registry = orchestration.collaborations?.find((item) => item.id === groupId);
  const locked = readOnly || lockedGroupIds.has(groupId);
  const [selectedId, setSelectedId] = useState<string>("input");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [newKind, setNewKind] = useState<RouteKind>("strong");
  const [newTarget, setNewTarget] = useState("");
  const [newAgentId, setNewAgentId] = useState("");
  const [linkStart, setLinkStart] = useState<LinkStart>();
  const [linkTarget, setLinkTarget] = useState<string>();
  const [linkPoint, setLinkPoint] = useState<{ x: number; y: number }>();
  const [invalidLink, setInvalidLink] = useState(false);
  const [drag, setDrag] = useState<NodeDrag>();
  const [dragPoint, setDragPoint] = useState<{ x: number; y: number }>();
  const [pan, setPan] = useState<CanvasPan>();
  const [viewViewport, setViewViewport] = useState<CanvasViewport>();
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [nodeSizes, setNodeSizes] = useState<Record<string, CanvasSize>>({});
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const canvasWorldRef = useRef<HTMLDivElement>(null);
  const linkStartRef = useRef<LinkStart>();
  const linkGestureRef = useRef<LinkGesture>();
  const panRef = useRef<CanvasPan>();
  const dragPointRef = useRef<{ x: number; y: number }>();
  const pointerHandlersRef = useRef<{ move: (event: PointerSample) => void; finish: (event: PointerSample) => void; cancel: () => void; wheel: (event: WheelEvent) => void }>();
  const dragRoutesRef = useRef<DragRouteLock[]>();
  const settledRoutesRef = useRef<{ key: string; routes: DragRouteLock[]; provisional?: boolean }>();
  const dragRef = useRef<NodeDrag>();
  const dragPendingRef = useRef(false);
  const [notice, setNotice] = useState("");
  const [newGroupId, setNewGroupId] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [childMembers, setChildMembers] = useState<Set<string>>(new Set());
  const [childLeader, setChildLeader] = useState("");
  const [showChildForm, setShowChildForm] = useState(false);
  const [removeCandidate, setRemoveCandidate] = useState<string>();
  const [loopId, setLoopId] = useState("");
  const [loopFrom, setLoopFrom] = useState("");
  const [loopTo, setLoopTo] = useState("");
  const [loopExit, setLoopExit] = useState("");
  const [loopMax, setLoopMax] = useState(2);
  const [pendingSharedEdit, setPendingSharedEdit] = useState<PendingSharedEdit>();
  const [agentInspectorEpoch, setAgentInspectorEpoch] = useState(0);
  const [history, setHistory] = useState<ScopedHistoryEntry[]>([]);
  const [redoHistory, setRedoHistory] = useState<ScopedHistoryEntry[]>([]);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [layoutStatus, setLayoutStatus] = useState("");
  const [layoutPhase, setLayoutPhase] = useState<"idle" | "planning" | "applying">("idle");
  const layoutBusyRef = useRef(false);
  const layoutOperationRef = useRef(0);
  const historySignatureRef = useRef(scopedHistorySignature(scopedHistoryEntry(orchestration)));
  const addAgentSelectRef = useRef<HTMLSelectElement>(null);
  const onNodeResize = useCallback((id: string, size: CanvasSize) => {
    if (size.width <= 0 || size.height <= 0 || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
    setNodeSizes(previous => previous[id]?.width === size.width && previous[id]?.height === size.height
      ? previous : { ...previous, [id]: size });
  }, []);
  useLayoutEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    const measure = () => setViewportSize(previous => {
      const width = host.clientWidth, height = host.clientHeight;
      return previous.width === width && previous.height === height ? previous : { width, height };
    });
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : undefined;
    observer?.observe(host);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  useEffect(() => { setNewTarget(""); setRemoveCandidate(undefined); }, [selectedId]);
  useEffect(() => {
    if (locked || pendingSharedEdit) pointerHandlersRef.current?.cancel();
  }, [locked, pendingSharedEdit]);

  const currentHistorySignature = scopedHistorySignature(scopedHistoryEntry(orchestration));
  const layoutIdentityRef = useRef("");
  layoutIdentityRef.current = `${groupId}\0${currentHistorySignature}`;
  useEffect(() => {
    if (historySignatureRef.current !== currentHistorySignature) {
      setHistory([]);
      setRedoHistory([]);
    }
    historySignatureRef.current = currentHistorySignature;
  }, [currentHistorySignature]);
  useEffect(() => () => {
    // A planning promise may resolve after the user navigates to another
    // scope. It must not publish a layout from an unmounted editor.
    layoutOperationRef.current += 1;
    layoutBusyRef.current = false;
  }, []);

  const path = useMemo(() => {
    const result: ScopedCollaboration[] = [];
    const seen = new Set<string>();
    let current: ScopedCollaboration | undefined = group;
    while (current && !seen.has(current.id)) {
      result.unshift(current);
      seen.add(current.id);
      current = current.parentGroupId ? contract?.groups.find((item) => item.id === current!.parentGroupId) : undefined;
    }
    return result;
  }, [contract, group]);

  const display = (id: string) => orchestration.collaborations?.find((item) => item.id === id)?.displayName ?? id;
  const mutate = (change: (draft: AgentOrchestrationTemplate, current: ScopedCollaboration) => void, withHistory = true): boolean => {
    if (locked) { setNotice("该协作组正在运行或集成，不能直接修改其配置"); return false; }
    if (layoutBusyRef.current) { setNotice("布局正在计算，请稍后修改画布"); return false; }
    const draft = structuredClone(orchestration);
    const current = draft.scopedWorkflow?.groups.find((item) => item.id === groupId);
    if (!current) return false;
    try {
      change(draft, current);
      let createdLoopId: string | undefined;
      const removedLoops: string[] = [];
      const originalWorkflow = group?.workflow;
      if (originalWorkflow && JSON.stringify(originalWorkflow.routes) !== JSON.stringify(current.workflow.routes)
        && JSON.stringify(originalWorkflow.loops ?? []) === JSON.stringify(current.workflow.loops ?? [])) {
        const previousEdges = new Set(scopedStrongEdges(originalWorkflow).map((edge) => `${edge.source}\0${edge.target}`));
        const addedEdges = scopedStrongEdges(current.workflow).filter((edge) => !previousEdges.has(`${edge.source}\0${edge.target}`));
        let before = scopedLoopTopology(originalWorkflow);
        const after = scopedLoopTopology(current.workflow);
        for (const added of [undefined, ...addedEdges]) {
          const result = reconcileLoopTopology(before, after, added, {
            exitTo: (members, topology) => topology.agents.find((agent) => !members.includes(agent.name))?.name
          });
          if (result.error) throw new Error(`无法修改组内连线：${result.error}`);
          current.workflow.loops = result.loops;
          if (result.created) createdLoopId = result.created.id;
          removedLoops.push(...result.removed);
          before = { ...after, loops: result.loops };
        }
      }
      const error = scopedWorkflowError(draft.scopedWorkflow, new Set(draft.agents.map((agent) => agent.name)), false);
      if (error) throw new Error(error);
      if (withHistory) {
        setHistory((entries) => [...entries.slice(-29), scopedHistoryEntry(orchestration)]);
        setRedoHistory([]);
      }
      historySignatureRef.current = scopedHistorySignature(scopedHistoryEntry(draft));
      onChange(draft);
      setNotice(createdLoopId ? `Loop ${createdLoopId} 已自动创建，请在右侧设置参数`
        : removedLoops.length ? `Loop ${removedLoops.join("、")} 已随闭环断开而移除`
          : "有未保存修改");
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "修改失败");
      return false;
    }
  };
  const requestSharedEdit = (agentId: string, label: string, apply: () => void | Promise<void>, cancel?: () => void, preserveDrafts = false) => {
    if (locked || isAgentLocked(agentId)) {
      setNotice("该 Agent 被活动协作组占用，不能修改共享配置");
      cancel?.();
      return;
    }
    setPendingSharedEdit({ agentId, label, apply, cancel, preserveDrafts });
  };
  const restoreHistory = (previous: ScopedHistoryEntry): boolean => {
    const draft = structuredClone(orchestration);
    if (!draft.scopedWorkflow) return false;
    draft.scopedWorkflow.groups = structuredClone(previous.groups);
    draft.collaborations = structuredClone(previous.collaborations);
    const error = scopedWorkflowError(draft.scopedWorkflow, new Set(draft.agents.map((agent) => agent.name)), false);
    if (error) { setNotice(`无法恢复画布：${error}`); return false; }
    historySignatureRef.current = scopedHistorySignature(scopedHistoryEntry(draft));
    setSelectedId("input");
    setSelectedEdgeId(undefined);
    cancelGestures();
    setViewViewport(undefined);
    onChange(draft);
    return true;
  };
  const undo = () => {
    if (locked || lockedGroupIds.size || layoutBusyRef.current || !history.length) return;
    if (!restoreHistory(history.at(-1)!)) return;
    setHistory((entries) => entries.slice(0, -1));
    setRedoHistory((entries) => [...entries.slice(-29), scopedHistoryEntry(orchestration)]);
    setNotice("已撤销组内修改");
  };
  const redo = () => {
    if (locked || lockedGroupIds.size || layoutBusyRef.current || !redoHistory.length) return;
    if (!restoreHistory(redoHistory.at(-1)!)) return;
    setRedoHistory((entries) => entries.slice(0, -1));
    setHistory((entries) => [...entries.slice(-29), scopedHistoryEntry(orchestration)]);
    setNotice("已重做组内修改");
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (linkStartRef.current || dragRef.current || panRef.current)) {
        event.preventDefault();
        cancelGestures();
        setNotice("已取消当前操作");
        return;
      }
      const target = event.target as HTMLElement | null;
      const dialog = target?.closest?.('[role="dialog"]');
      if (pendingSharedEdit || (dialog && !dialog.contains(canvasHostRef.current))) return;
      if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const workflow = group.workflow;
  const layout = workflow.canvas ?? defaultScopedCanvas(
    workflow.nodes.map((ref) => ref.nodeId), workflow.input.edges.map((edge) => edge.target)
  );
  const positions = layout.nodes;
  const rawNodes: CanvasNode[] = [
    { id: "input", kind: "input", name: "进入协作组", ...(positions.input ?? { x: 40, y: 300 }) },
    ...workflow.nodes.map((ref, index) => {
      const member = ref.kind === "agent" ? orchestration.agents.find((agent) => agent.name === ref.agentId) : undefined;
      const child = ref.kind === "collaboration" ? orchestration.collaborations?.find((item) => item.id === ref.groupId) : undefined;
      return {
        id: ref.nodeId, kind: "agent" as const, name: ref.nodeId,
        ...(member ? { displayName: member.name, template: member.template ?? "general" } : {}),
        ...(child ? { displayName: child.displayName, collaboration: child, memberAgentIds: child.memberAgentIds } : {}),
        ...(positions[ref.nodeId] ?? { x: 360 + Math.floor(index / 4) * 270, y: 55 + index % 4 * 170 })
      };
    }),
    { id: "finish", kind: "finish", name: "结束协作组", ...(positions.finish ?? { x: 1110, y: 300 }) }
  ];
  const nodes = rawNodes.map(node => nodeSizes[node.id] ? { ...node, ...nodeSizes[node.id] } : node);
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const edge = (source: string, target: string, kind: CanvasEdge["kind"], id = canvasEdgeId(source, target), fixed = false): CanvasEdge => {
    const stored = layout.edges[id];
    return {
      id, source, target, kind, fixed,
      sourcePort: stored?.sourcePort ?? relativePort(nodeMap.get(source), nodeMap.get(target), "right"),
      targetPort: stored?.targetPort ?? relativePort(nodeMap.get(target), nodeMap.get(source), "left"),
      sourcePortPinned: stored?.sourcePortPinned ?? false,
      targetPortPinned: stored?.targetPortPinned ?? false
    };
  };
  const edges: CanvasEdge[] = [
    ...workflow.input.edges.map((route) => edge("input", route.target, "parallel")),
    ...Object.entries(workflow.routes).flatMap(([source, routes]) => routes.map((route) =>
      edge(source, route.target, route.target === "finish" ? "termination" : route.kind)
    ))
  ];
  decorateCanvasLoops(edges, workflow, (loop) => {
    edges.push(edge(loop.from, loop.exitTo, "strong", loopExitCanvasEdgeId(loop.id), true));
  });
  const routeKey = canvasRoutingKey({ edges, nodes });
  const settled = settledRoutesRef.current;
  const settledMatches = settled?.key === routeKey;
  const routed = useCanvasRouting(edges, nodes, { enabled: !drag && !(settledMatches && !settled.provisional) });
  const dragFrames = useCanvasPointerFrame(needsBackgroundRouting(edges, nodes));
  const displayNodes = drag && dragPoint ? nodes.map((node) => node.id === drag.id ? { ...node, ...dragPoint } : node) : nodes;
  const routeGeometry = useMemo(() => {
    if (drag && dragRoutesRef.current) return buildLockedEdgeRoutesFromSnapshot(dragRoutesRef.current, { nodes: displayNodes, draggedNodeId: drag.id });
    if (settledMatches && (!settled.provisional || routed.pending)) return buildLockedEdgeRoutesFromSnapshot(settled.routes);
    return routed.geometry;
  }, [routeKey, drag, dragPoint, routed.geometry, routed.pending, settledMatches]);
  const geometry = useMemo(() => withCanvasLoopPresentation(routeGeometry, edges), [routeGeometry, workflow.loops]);
  const fittedViewport = useMemo(() => {
    const bounds = canvasContentBounds(nodes, geometry.flatMap(item => item.samples));
    return bounds && viewportSize.width > 0 && viewportSize.height > 0
      ? fitCanvasViewport(viewportSize, bounds, { padding: 32, boundsPadding: 18, minZoom: .2, maxZoom: 1.2 })
      : layout.viewport;
  }, [routeKey, geometry, viewportSize.width, viewportSize.height]);
  const storedViewport = layout.viewport;
  const persistedViewport = Math.abs(storedViewport.x) > .5 || Math.abs(storedViewport.y) > .5 || Math.abs(storedViewport.zoom - .82) > .005;
  const viewport = viewViewport ?? (persistedViewport ? storedViewport : fittedViewport);
  const updateViewport = (next: CanvasViewport) => {
    if (layoutBusyRef.current) return;
    setViewViewport(next);
    if (!locked) mutate((_draft, current) => {
      current.workflow.canvas ??= defaultScopedCanvas(current.workflow.nodes.map((ref) => ref.nodeId), current.workflow.input.edges.map((edge) => edge.target));
      current.workflow.canvas.viewport = next;
    }, false);
  };
  const selected = workflow.nodes.find((ref) => ref.nodeId === selectedId);
  const selectedAgentId = selected?.kind === "agent" ? selected.agentId : undefined;
  const selectedAgentDefinition = selectedAgentId
    ? orchestration.agents.find((agent) => agent.name === selectedAgentId)
    : undefined;
  const selectedAgentConfig = selectedAgentId ? agents[selectedAgentId] : undefined;
  const selectedAgentNode = selectedAgentId ? nodes.find((node) => node.id === selectedId) : undefined;
  const selectedEdge = edges.find((item) => item.id === selectedEdgeId);
  const scopedInspectorOrchestration: AgentOrchestrationTemplate = {
    ...orchestration,
    agents: workflow.nodes.map((ref) => ({ name: ref.nodeId })),
    routes: workflow.routes,
    loops: workflow.loops
  };
  const selectedLoopId = selectedEdge?.loop?.id;
  const selectedEdgeIds = selectedEdge?.kind === "parallel" || selectedId === "input"
    ? new Set(edges.filter((item) => item.source === "input" && item.kind === "parallel").map((item) => item.id))
    : selectedId === "finish" && !selectedEdge
      ? new Set(edges.filter((item) => item.target === "finish").map((item) => item.id))
      : undefined;
  const sourceId = selectedEdge ? selectedEdge.source : selectedId;
  const routeTargets = workflow.nodes.filter((ref) => ref.nodeId !== sourceId).map((ref) => ref.nodeId);
  if (sourceId !== "input") routeTargets.push("finish");
  const directAgents = [...new Set(workflow.nodes.flatMap((ref) => ref.kind === "agent" ? [ref.agentId] : []))];
  const ancestorLeaderIds = new Set(path.map((item) => item.leaderAgentId));
  const availableAgents = group.parentGroupId
    ? [...new Set([
      ...(contract.groups.find((item) => item.id === group.parentGroupId)?.workflow.nodes.flatMap((ref) => ref.kind === "agent" ? [ref.agentId] : []) ?? []),
      contract.groups.find((item) => item.id === group.parentGroupId)?.leaderAgentId ?? ""
    ])]
    : orchestration.agents.map((agent) => agent.name);
  const addableAgents = availableAgents.filter((id) => id && id !== "main" && !ancestorLeaderIds.has(id) && !directAgents.includes(id));
  const childLeaderOptions = [...new Set([...directAgents, group.leaderAgentId])]
    .filter((id) => !childMembers.has(id) && !path.slice(0, -1).some((entry) => entry.leaderAgentId === id));
  const inputCount = workflow.input.edges.length;
  const strictError = scopedWorkflowError(contract, new Set(orchestration.agents.map((agent) => agent.name)));
  const targetLabel = (id: string): string => {
    if (id === "finish") return "结束协作组";
    const ref = workflow.nodes.find((item) => item.nodeId === id);
    return ref?.kind === "agent" ? ref.agentId : ref?.kind === "collaboration" ? display(ref.groupId) : id;
  };
  const changeSelectedEdgeKind = (id: string, kind: RouteKind) => {
    const selectedRoute = edges.find((item) => item.id === id);
    if (!selectedRoute || selectedRoute.fixed || selectedRoute.source === "input" || selectedRoute.target === "finish") return;
    mutate((_draft, current) => {
      const route = current.workflow.routes[selectedRoute.source]?.find((item) => item.target === selectedRoute.target);
      if (!route) throw new Error("组内连线不存在");
      const other = (current.workflow.routes[selectedRoute.source] ?? []).filter((item) => item !== route);
      if (kind === "strong" && other.length) throw new Error("强边必须是唯一出边");
      route.kind = kind;
    });
  };
  const changeSelectedEdgeLayout = (id: string, patch: Partial<WorkflowCanvasEdgeLayout>) => {
    const selectedRoute = edges.find((item) => item.id === id);
    if (!selectedRoute || selectedRoute.fixed) return;
    mutate((_draft, current) => {
      current.workflow.canvas ??= defaultScopedCanvas(current.workflow.nodes.map((ref) => ref.nodeId), current.workflow.input.edges.map((item) => item.target));
      const previous = current.workflow.canvas.edges[id];
      current.workflow.canvas.edges[id] = {
        sourcePort: previous?.sourcePort ?? selectedRoute.sourcePort,
        targetPort: previous?.targetPort ?? selectedRoute.targetPort,
        sourcePortPinned: previous?.sourcePortPinned ?? selectedRoute.sourcePortPinned,
        targetPortPinned: previous?.targetPortPinned ?? selectedRoute.targetPortPinned,
        ...patch
      };
    });
  };
  const removeSelectedEdge = (id: string) => {
    const selectedRoute = edges.find((item) => item.id === id);
    if (!selectedRoute || selectedRoute.fixed) return;
    const removed = mutate((_draft, current) => {
      if (selectedRoute.loop) current.workflow.loops = current.workflow.loops?.filter((item) => item.id !== selectedRoute.loop?.id);
      removeScopedRoute(current.workflow, selectedRoute.source, selectedRoute.target);
    });
    if (removed) setSelectedEdgeId(undefined);
  };

  const clearConnection = () => {
    linkStartRef.current = undefined;
    linkGestureRef.current = undefined;
    setLinkStart(undefined);
    setLinkTarget(undefined);
    setLinkPoint(undefined);
    setInvalidLink(false);
  };
  const worldPoint = (clientX: number, clientY: number) => {
    const rect = canvasWorldRef.current?.getBoundingClientRect();
    return { x: (clientX - (rect?.left ?? 0) - viewport.x) / viewport.zoom,
      y: (clientY - (rect?.top ?? 0) - viewport.y) / viewport.zoom };
  };
  const targetAtPoint = (event: PointerSample): LinkTarget | undefined => {
    const rect = canvasWorldRef.current?.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0 &&
      (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) return;
    const point = worldPoint(event.clientX, event.clientY);
    const hit = document.elementFromPoint?.(event.clientX, event.clientY) ?? event.target;
    const element = hit instanceof Element ? hit.closest<HTMLElement>("[data-node-id]") : undefined;
    const hitId = element && canvasWorldRef.current?.contains(element) ? element.dataset.nodeId : undefined;
    const candidates = [...displayNodes].reverse();
    if (hitId) candidates.sort((left, right) => Number(right.id === hitId) - Number(left.id === hitId));
    for (const node of candidates) {
      const { width, height } = canvasNodeSize(node);
      const tolerance = 14 / viewport.zoom;
      if (point.x < node.x - tolerance || point.x > node.x + width + tolerance ||
        point.y < node.y - tolerance || point.y > node.y + height + tolerance) continue;
      const explicitPort = node.id === hitId && hit instanceof Element
        ? hit.closest<HTMLElement>("[data-port]")?.dataset.port : undefined;
      const ports: WorkflowCanvasPort[] = ["left", "right", "top", "bottom"];
      const port = ports.includes(explicitPort as WorkflowCanvasPort) ? explicitPort as WorkflowCanvasPort
        : ports.sort((a, b) => {
          const first = canvasPortPoint(node, a), second = canvasPortPoint(node, b);
          return Math.hypot(point.x - first.x, point.y - first.y) - Math.hypot(point.x - second.x, point.y - second.y);
        })[0]!;
      return { id: node.id, port };
    }
  };
  const connectionError = (source: string, target: string): string | undefined => {
    if (target === "input") return "进入协作组只能作为并行边的来源";
    try {
      addScopedRoute({ ...workflow, input: { ...workflow.input, edges: [...workflow.input.edges] },
        routes: { ...workflow.routes } }, source, target, source === "input" ? "parallel" : newKind);
    } catch (error) { return error instanceof Error ? error.message : "无法添加连线"; }
  };
  const connect = (source: string, target: string, sourcePort?: WorkflowCanvasPort, targetPort?: WorkflowCanvasPort) => {
    const error = connectionError(source, target);
    if (error) { clearConnection(); setNotice(error); return; }
    const kind = source === "input" ? "parallel" : newKind;
    const connected = mutate((_draft, current) => {
      addScopedRoute(current.workflow, source, target, kind);
      current.workflow.canvas ??= defaultScopedCanvas(current.workflow.nodes.map((ref) => ref.nodeId), []);
      const id = canvasEdgeId(source, target);
      current.workflow.canvas.edges[id] = {
        sourcePort: sourcePort ?? "right", targetPort: targetPort ?? "left",
        sourcePortPinned: Boolean(sourcePort), targetPortPinned: Boolean(targetPort)
      };
    });
    clearConnection();
    if (connected) setNewTarget("");
  };
  const portDown = (event: ReactPointerEvent<HTMLButtonElement>, node: CanvasNode, port: WorkflowCanvasPort) => {
    if (locked || layoutBusyRef.current || event.button !== 0 || dragRef.current || panRef.current) return;
    if (linkGestureRef.current && linkGestureRef.current.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const source = linkStartRef.current;
    if (source) {
      connect(source.source, node.id, source.port, port);
      return;
    }
    if (node.id === "finish") { setNotice("结束协作组不能作为连线起点"); return; }
    const from = { source: node.id, port };
    linkStartRef.current = from;
    linkGestureRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, moved: false };
    setLinkStart(from);
    setLinkTarget(undefined);
    setLinkPoint(worldPoint(event.clientX, event.clientY));
    setNotice("拖动到目标节点或连接点后释放，按 Esc 取消");
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* Capture may be unavailable after a DOM replacement. */ }
  };
  const nodeDown = (event: ReactPointerEvent<HTMLElement>, node: CanvasNode) => {
    if (locked || layoutBusyRef.current || event.button !== 0 || dragRef.current || panRef.current) return;
    if (linkGestureRef.current && linkGestureRef.current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const source = linkStartRef.current;
    if (source) { event.preventDefault(); connect(source.source, node.id, source.port); return; }
    dragPendingRef.current = routed.pending;
    dragRoutesRef.current = captureRouteLock(routeGeometry, nodes);
    const active = { id: node.id, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
      x: node.x, y: node.y, zoom: viewport.zoom };
    dragRef.current = active;
    dragPointRef.current = { x: node.x, y: node.y };
    setSelectedId(node.id);
    setSelectedEdgeId(undefined);
    setViewViewport(viewport);
    setDrag(active);
    setDragPoint(dragPointRef.current);
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* Capture may be unavailable after a DOM replacement. */ }
  };
  const pointerMove = (event: PointerSample) => {
    const source = linkStartRef.current;
    if (source) {
      const gesture = linkGestureRef.current;
      if (gesture && gesture.pointerId !== event.pointerId) return;
      if (gesture) gesture.moved ||= Math.hypot(event.clientX - gesture.clientX, event.clientY - gesture.clientY) > 3;
      const target = targetAtPoint(event);
      setLinkTarget(target?.id);
      setLinkPoint(worldPoint(event.clientX, event.clientY));
      setInvalidLink(Boolean(target && connectionError(source.source, target.id)));
      return;
    }
    const activePan = panRef.current;
    if (activePan?.pointerId === event.pointerId) {
      setViewViewport({ ...activePan.viewport, x: activePan.viewport.x + event.clientX - activePan.clientX,
        y: activePan.viewport.y + event.clientY - activePan.clientY });
      return;
    }
    const active = dragRef.current;
    if (active?.pointerId !== event.pointerId) return;
    const point = {
      x: Math.round(active.x + (event.clientX - active.clientX) / active.zoom),
      y: Math.round(active.y + (event.clientY - active.clientY) / active.zoom)
    };
    dragPointRef.current = point;
    dragFrames.schedule(() => setDragPoint(point));
  };
  const finishNodeDrag = (event?: PointerSample) => {
    const active = dragRef.current;
    if (active && (!event || active.pointerId === event.pointerId)) {
      dragFrames.cancel();
      dragRef.current = undefined;
      const point = event ? {
        x: Math.round(active.x + (event.clientX - active.clientX) / active.zoom),
        y: Math.round(active.y + (event.clientY - active.clientY) / active.zoom)
      } : dragPointRef.current ?? { x: active.x, y: active.y };
      const releaseNodes = nodes.map((node) => node.id === active.id ? { ...node, ...point } : node);
      const released = buildLockedEdgeRoutesFromSnapshot(dragRoutesRef.current, { nodes: releaseNodes, draggedNodeId: active.id });
      settledRoutesRef.current = { key: canvasRoutingKey({ edges, nodes: releaseNodes }), routes: captureRouteLock(released, releaseNodes), provisional: dragPendingRef.current };
      dragRoutesRef.current = undefined;
      if (point.x !== active.x || point.y !== active.y) {
        mutate((_draft, current) => {
          current.workflow.canvas ??= defaultScopedCanvas(current.workflow.nodes.map((ref) => ref.nodeId), current.workflow.input.edges.map((edge) => edge.target));
          current.workflow.canvas.nodes[active.id] = point;
        });
      }
      setDrag(undefined);
      setDragPoint(undefined);
      dragPointRef.current = undefined;
    }
  };
  const cancelGestures = () => {
    clearConnection();
    dragFrames.cancel();
    dragRef.current = undefined;
    dragRoutesRef.current = undefined;
    dragPointRef.current = undefined;
    if (panRef.current) setViewViewport(panRef.current.viewport);
    panRef.current = undefined;
    setPan(undefined);
    setDrag(undefined);
    setDragPoint(undefined);
  };
  const pointerUp = (event: PointerSample) => {
    const pointerId = linkGestureRef.current?.pointerId ?? dragRef.current?.pointerId ?? panRef.current?.pointerId;
    if (pointerId !== undefined && pointerId !== event.pointerId) return;
    if (event.type === "pointercancel") { cancelGestures(); return; }
    const source = linkStartRef.current;
    if (source) {
      const gesture = linkGestureRef.current;
      const moved = gesture ? gesture.moved || Math.hypot(event.clientX - gesture.clientX, event.clientY - gesture.clientY) > 3 : true;
      const target = targetAtPoint(event);
      if (target && (target.id !== source.source || moved)) connect(source.source, target.id, source.port, target.port);
      else if (moved) { clearConnection(); setNotice("连线已取消"); }
      else linkGestureRef.current = undefined;
      return;
    }
    const activePan = panRef.current;
    if (activePan?.pointerId === event.pointerId) {
      panRef.current = undefined;
      updateViewport({ ...activePan.viewport, x: activePan.viewport.x + event.clientX - activePan.clientX,
        y: activePan.viewport.y + event.clientY - activePan.clientY });
      setPan(undefined);
      return;
    }
    finishNodeDrag(event);
  };
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    if (dragRef.current || panRef.current || linkGestureRef.current || layoutBusyRef.current) return;
    const rect = canvasWorldRef.current?.getBoundingClientRect();
    if (!rect) return;
    updateViewport(zoomCanvasViewportAt(viewport, { x: event.clientX - rect.left, y: event.clientY - rect.top },
      viewport.zoom * Math.exp(-Math.max(-240, Math.min(240, event.deltaY)) * .0015)));
  };
  pointerHandlersRef.current = { move: pointerMove, finish: pointerUp, cancel: cancelGestures, wheel };
  useEffect(() => {
    const outside = (event: PointerEvent) => !(event.target instanceof Node && canvasWorldRef.current?.contains(event.target));
    const move = (event: PointerEvent) => { if (outside(event)) pointerHandlersRef.current?.move(event); };
    const finish = (event: PointerEvent) => { if (outside(event)) pointerHandlersRef.current?.finish(event); };
    const blur = () => pointerHandlersRef.current?.cancel();
    const wheel = (event: WheelEvent) => pointerHandlersRef.current?.wheel(event);
    const world = canvasWorldRef.current;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", blur);
    world?.addEventListener("wheel", wheel, { passive: false });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", blur);
      world?.removeEventListener("wheel", wheel);
    };
  }, []);
  const pendingSource = linkStart && displayNodes.find(node => node.id === linkStart.source);
  const pendingAnchor = pendingSource && linkStart ? canvasPortPoint(pendingSource, linkStart.port) : undefined;
  const pendingPath = pendingAnchor && linkPoint ? `M ${pendingAnchor.x} ${pendingAnchor.y} L ${linkPoint.x} ${linkPoint.y}` : undefined;
  const toggleConnect = () => {
    if (locked || layoutBusyRef.current) return;
    if (linkStartRef.current) { clearConnection(); setNotice("连线已取消"); return; }
    const source = nodes.find(node => node.id === selectedId);
    if (!source || source.id === "finish") { setNotice("请先选择一个可发出连线的节点"); return; }
    const from: LinkStart = { source: source.id, port: "right" };
    linkStartRef.current = from;
    setLinkStart(from);
    setLinkTarget(undefined);
    setLinkPoint(canvasPortPoint(source, from.port));
    setNotice("点击目标节点完成连线，点击空白或按 Esc 取消");
    canvasWorldRef.current?.focus({ preventScroll: true });
  };
  const fitView = () => {
    const bounds = canvasContentBounds(nodes, geometry.flatMap((item) => item.samples));
    if (!bounds) return;
    const host = canvasHostRef.current;
    updateViewport(fitCanvasViewport({ width: host?.clientWidth || 850, height: host?.clientHeight || 560 }, bounds, { padding: 32, boundsPadding: 18, minZoom: .2, maxZoom: 1.2 }));
  };
  const zoomView = (scale: number) => {
    const host = canvasHostRef.current;
    updateViewport(zoomCanvasViewportAt(viewport, { x: (host?.clientWidth || 850) / 2, y: (host?.clientHeight || 560) / 2 }, viewport.zoom * scale));
  };
  const applyLayout = async (kind: "tidy" | "layered") => {
    if (locked || layoutBusyRef.current) return;
    const identity = layoutIdentityRef.current;
    const operation = ++layoutOperationRef.current;
    const host = canvasHostRef.current;
    layoutBusyRef.current = true;
    setLayoutBusy(true);
    setLayoutPhase("planning");
    setLayoutStatus("正在计算布局…");
    try {
      const plan = await buildCanvasLayoutPlan({
        kind,
        orchestration: scopedCanvasPlanningOrchestration(workflow),
        layout: { ...layout, viewport },
        viewportSize: { width: host?.clientWidth || 850, height: host?.clientHeight || 560 }
      });
      if (operation !== layoutOperationRef.current) return;
      if (identity !== layoutIdentityRef.current) {
        setLayoutStatus("布局已取消：协作组已变化");
        return;
      }
      if (!plan.graphChanged && !plan.viewportChanged) {
        setLayoutStatus("当前布局已经清晰");
        return;
      }
      setLayoutPhase("applying");
      layoutBusyRef.current = false;
      const applied = mutate((_draft, current) => { current.workflow.canvas = plan.layout; });
      if (applied) {
        setViewViewport(undefined);
        setLayoutStatus(plan.usedFallback ? "布局已完成（使用确定性回退）" : "布局已完成");
      }
    } catch (error) {
      setLayoutStatus("布局计算失败");
      setNotice(error instanceof Error ? error.message : "布局计算失败");
    } finally {
      layoutBusyRef.current = false;
      setLayoutBusy(false);
      setLayoutPhase("idle");
    }
  };
  const createChild = () => {
    const id = newGroupId.trim();
    const displayName = newGroupName.trim();
    if (!id || !displayName || childMembers.size < 2 || !childLeader) {
      setNotice("请填写子组 ID、名称、至少两名成员及非成员 Leader"); return;
    }
    const created = mutate((draft) => addScopedGroup(draft, {
      id, displayName, parentGroupId: groupId, leaderAgentId: childLeader, memberAgentIds: [...childMembers]
    }));
    if (!created) return;
    setShowChildForm(false);
    setNewGroupId(""); setNewGroupName(""); setChildMembers(new Set()); setChildLeader("");
  };

  return <div className="scoped-workflow-editor" aria-label={`${registry?.displayName ?? group.id} 组内 Workflow 编辑器`}>
    <header className="scoped-header">
    <nav className="scoped-breadcrumbs" aria-label="Workflow 范围路径">
      <button type="button" className="scoped-parent-link" aria-label="返回父图" title={`返回${group.parentGroupId ? display(group.parentGroupId) : "项目"}`} onClick={() => onNavigate(group.parentGroupId)}><ArrowLeft size={14} /><span>返回父图</span></button>
      <button type="button" onClick={() => onNavigate()}>项目</button>
      {path.map((item, index) => <span key={item.id}>
        <span aria-hidden="true">›</span>
        <button type="button" aria-current={index === path.length - 1 ? "page" : undefined} onClick={() => onNavigate(item.id)}>{display(item.id)}</button>
      </span>)}
    </nav>
    <div className="scoped-toolbar">
      <strong><Layers3 size={13} />协作组</strong>
      <span>{workflow.nodes.length} 个直接节点 · {inputCount} 条并行入口</span>
    </div>
    </header>
    <CanvasToolbar edgeKind={newKind} zoom={viewport.zoom} connecting={Boolean(linkStart)} readOnly={locked} allowFitWhenReadOnly layoutBusy={layoutBusy} layoutStatus={layoutStatus} layoutPhase={layoutPhase} canUndo={history.length > 0 && lockedGroupIds.size === 0} canRedo={redoHistory.length > 0 && lockedGroupIds.size === 0} addAgentLabel="引用 Agent" onAddAgent={() => addAgentSelectRef.current?.focus()} onToggleConnect={toggleConnect} onEdgeKindChange={setNewKind} onZoomOut={() => zoomView(.85)} onResetZoom={fitView} onZoomIn={() => zoomView(1.15)} onUndo={undo} onRedo={redo} onTidy={() => void applyLayout("tidy")} onLayered={() => void applyLayout("layered")} onFit={fitView} />
    <div className="scoped-body">
      <aside className="scoped-panel scoped-library" aria-label="协作组设置">
        <header className="scoped-panel-heading"><div><h3><Layers3 size={15} />组设置</h3><p>{registry?.displayName ?? group.id}</p></div></header>
        <div className="scoped-library-content">
        {locked && <p className="scoped-alert" role="status">协作组正在运行或集成，仅可查看；可以平移和缩放画布。</p>}
        {strictError && <p className="scoped-alert" role="alert">启动前需修复：{strictError}</p>}
        <section className="scoped-settings-card" aria-label="协作组基本设置">
        <h4>基本设置</h4>
        <label>显示名称<input aria-label="协作组显示名称" value={registry?.displayName ?? group.id} disabled={locked || registry?.renamePolicy === "locked"} onChange={(event) => mutate((draft) => { const entry = draft.collaborations?.find((item) => item.id === groupId); if (entry) entry.displayName = event.target.value; })} /></label>
        <label>Leader<select aria-label="协作组 Leader" value={group.leaderAgentId} disabled={locked} onChange={(event) => mutate((_draft, current) => { current.leaderAgentId = event.target.value; })}>
          {orchestration.agents.filter((agent) => !workflow.nodes.some((ref) => ref.kind === "agent" && ref.agentId === agent.name)).map((agent) => <option key={agent.name} value={agent.name}>{agent.name}</option>)}
        </select></label>
        <label>弱边决策者<select aria-label="组内协作组弱边决策者" value={group.decisionBy ?? "main"} disabled={locked} onChange={(event) => mutate((_draft, current) => { current.decisionBy = event.target.value as "main" | "agent"; })}>
          <option value="main">组内 Leader 选择</option>
          <option value="agent">协作组自身选择（{group.leaderAgentId}）</option>
        </select></label>
        <small>“组内 Leader”由当前组的 Leader 选边；“自身选择”由子组 Leader 选边。</small>
        <small>Leader 负责协调，不能同时担任本组或后代组的业务节点。</small>
        <label className="scoped-switch"><input type="checkbox" role="switch" aria-label="允许 Leader 自动调整本组 Workflow" checked={group.allowLeaderReconfiguration} disabled={locked} onChange={(event) => mutate((_draft, current) => { current.allowLeaderReconfiguration = event.target.checked; })} />允许 Leader 自动调整本组 Workflow</label>
        <small>仅允许调整本组范围，不扩大现有权限。</small>
        </section>
        <section className="scoped-settings-card" aria-label="协作组直接成员">
        <h4>直接成员<span className="scoped-count">{workflow.nodes.length}</span></h4>
        <ul className="scoped-member-list">{workflow.nodes.map((ref) => <li key={ref.nodeId}>
          <button type="button" aria-label={ref.kind === "agent" ? ref.agentId : display(ref.groupId)} aria-pressed={selectedId === ref.nodeId && !selectedEdgeId}
            onClick={() => { setSelectedId(ref.nodeId); setSelectedEdgeId(undefined); }}>
            <span>{ref.kind === "agent" ? ref.agentId : display(ref.groupId)}</span>
            <small>{ref.kind === "agent" ? "Agent" : "协作组"}</small>
          </button>{ref.kind === "collaboration" && <button type="button" title={`进入 ${display(ref.groupId)}`} onClick={() => onNavigate(ref.groupId)}>进入</button>}
        </li>)}</ul>
        <label>引用已有 Agent<select ref={addAgentSelectRef} aria-label="引用已有 Agent" value={newAgentId} disabled={locked || !addableAgents.length} onChange={(event) => setNewAgentId(event.target.value)}><option value="">选择 Agent</option>{addableAgents.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
        <button type="button" className="scoped-primary-button" disabled={locked || !newAgentId} onClick={() => {
          let addedId: string | undefined;
          const added = mutate(draft => { addedId = addScopedAgentReference(draft, groupId, newAgentId); });
          if (added && addedId) { setSelectedId(addedId); setSelectedEdgeId(undefined); setNewAgentId(""); }
        }}><Plus size={13} />添加同一 Agent 引用</button>
        <small>引用同一 Agent，共享它的配置和会话。</small>
        </section>
        <section className="scoped-settings-card" aria-label="子协作组设置">
        <h4>嵌套协作</h4>
        <button type="button" className="scoped-secondary-button" aria-expanded={showChildForm} disabled={locked} onClick={() => setShowChildForm((value) => !value)}><Plus size={13} />新建子协作组</button>
        {showChildForm && <div className="scoped-child-form" aria-label="新建子协作组">
          <label>子组 ID<input value={newGroupId} disabled={locked} onChange={(event) => setNewGroupId(event.target.value)} /></label>
          <label>名称<input value={newGroupName} disabled={locked} onChange={(event) => setNewGroupName(event.target.value)} /></label>
          <fieldset><legend>引用本组已有 Agent（至少两名）</legend>{directAgents.map((id) => <label key={id}><input type="checkbox" checked={childMembers.has(id)} disabled={locked || id === group.leaderAgentId} onChange={(event) => { const next = new Set(childMembers); if (event.target.checked) { next.add(id); if (childLeader === id) setChildLeader(""); } else next.delete(id); setChildMembers(next); }} />{id}</label>)}</fieldset>
          <label>子组 Leader<select value={childLeader} disabled={locked} onChange={(event) => setChildLeader(event.target.value)}><option value="">选择非成员 Agent</option>{childLeaderOptions.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
          <button type="button" className="scoped-primary-button" disabled={locked || !newGroupId.trim() || !newGroupName.trim() || childMembers.size < 2 || !childLeader || childMembers.has(childLeader)} onClick={createChild}>创建子组</button>
        </div>}
        </section>
        </div>
      </aside>
      <div className="scoped-canvas-host" ref={canvasHostRef}>
        <CanvasWorld ref={canvasWorldRef} viewport={viewport} worldWidth={1480}
          worldHeight={Math.max(860, ...nodes.map(node => node.y + 180))}
          connecting={Boolean(linkStart)} panning={Boolean(pan)} layoutBusy={layoutBusy}
          onPointerDown={event => {
            if (event.button !== 0 || layoutBusyRef.current || linkStartRef.current || dragRef.current ||
              (event.target as Element).closest(".agent-node, .workflow-edge-group, button")) return;
            const active = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, viewport };
            panRef.current = active;
            setPan(active);
            try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* Capture may be unavailable after a DOM replacement. */ }
          }}
          onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}
          onLostPointerCapture={event => {
            if (dragRef.current?.pointerId === event.pointerId) finishNodeDrag();
            else if (linkGestureRef.current?.pointerId === event.pointerId || panRef.current?.pointerId === event.pointerId) cancelGestures();
          }}
          hint={routed.pending ? "正在优化连线，可继续编辑…" : linkStart
            ? `从 ${targetLabel(linkStart.source)} 连线 · 拖到目标后释放，Esc 取消`
            : undefined}>
          <CanvasEdges edges={geometry} nodes={displayNodes} moving={Boolean(drag)}
            selectedEdgeId={selectedEdgeId} selectedEdgeIds={selectedEdgeIds} selectedLoopId={selectedLoopId}
            focusedNodeId={selectedEdge ? undefined : selectedId} pendingPath={pendingPath} pendingKind={linkStart?.source === "input" ? "parallel" : newKind}
            pendingInvalid={invalidLink} onSelectEdge={item => { setSelectedEdgeId(item.id); setSelectedId(item.source ?? "input"); }} />
          <CanvasNodes nodes={displayNodes} selectedNodeId={selectedEdge ? undefined : selectedId}
            onNodeResize={onNodeResize}
            draggingNodeId={drag?.id} connectionSourceId={linkStart?.source} connectionTargetId={linkTarget}
            invalidTargetId={invalidLink ? linkTarget : undefined} readOnly={locked} suppressGroupMembers
            resolvePresentation={node => node.id === "input" ? { title: "进入协作组", description: "仅此处可发出并行入口边", modelLabel: "PARALLEL", color: "#316ac4", softColor: "#eaf1ff" }
              : node.id === "finish" ? { title: "结束协作组", description: "等待所有必要路径与 Git 集成", modelLabel: "END", color: "#a65365", softColor: "#f9eaed" }
              : node.collaboration ? { title: node.displayName ?? node.name, description: "子协作组 · 可进入内部编排", modelLabel: "GROUP", initials: "组", color: "#5c5bd6", softColor: "#eeedff" }
              : { title: node.displayName ?? node.name, description: "引用同一 Agent · 保留原 session", modelLabel: "AGENT", color: "#25714e", softColor: "#e7f1e9" }}
            onSelectNode={node => {
              const source = linkStartRef.current;
              if (!locked && source && source.source !== node.id) connect(source.source, node.id, source.port);
              setSelectedId(node.id); setSelectedEdgeId(undefined);
            }}
            onEditNode={node => { const ref = workflow.nodes.find(item => item.nodeId === node.id); if (ref?.kind === "collaboration") onNavigate(ref.groupId); else setSelectedId(node.id); }}
            onNodePointerDown={nodeDown} onPortPointerDown={portDown}
            onPortPointerEnter={node => {
              if (!linkStartRef.current) return;
              setLinkTarget(node.id);
              setInvalidLink(Boolean(connectionError(linkStartRef.current.source, node.id)));
            }} onPortPointerLeave={() => { setLinkTarget(undefined); setInvalidLink(false); }} />
        </CanvasWorld>
      </div>
      <aside className="scoped-panel scoped-inspector" aria-label="组内节点属性">
        {inspectorTabs}<div className="scoped-inspector-content" hidden={inspectorContent !== undefined}>
        {selectedEdge ? <CanvasInspector
          selectedEdge={selectedEdge}
          orchestration={scopedInspectorOrchestration}
          scopeKind="collaboration"
          readOnly={locked}
          onEdgeKindChange={changeSelectedEdgeKind}
          onEdgeLayoutChange={changeSelectedEdgeLayout}
          onEdgeRemove={removeSelectedEdge}
          onLoopChange={(id, patch) => mutate((_draft, current) => {
            const loop = current.workflow.loops?.find((item) => item.id === id);
            if (!loop) throw new Error("组内 Loop 不存在");
            Object.assign(loop, patch);
          })}
        /> : selectedAgentId && selectedAgentNode && selectedAgentConfig && registry ? <CanvasInspector
          key={`${selectedAgentId}-${agentInspectorEpoch}`}
          node={{ ...selectedAgentNode, name: selectedAgentId }}
          agent={selectedAgentConfig}
          harnessConstraint={agentHarnessConstraint?.(selectedAgentId)}
          definition={selectedAgentDefinition}
          orchestration={orchestration}
          collaborationParent={registry}
          toolRecommendationApplyNotice="工具推荐已提交，请确认共享 Agent 配置修改。"
          readOnly={locked || isAgentLocked(selectedAgentId)}
          skills={skills}
          onAddSkill={onAddSkill}
          mcpOptions={mcpOptions}
          mcpDirectory={mcpDirectory}
          gateways={gateways}
          harnesses={harnesses}
          onAgentPatch={(patch) => {
            const toolsOnly = Object.keys(patch).every((key) => ["skills", "autoSkills", "mcpServers", "experimentMcp"].includes(key));
            requestSharedEdit(selectedAgentId, toolsOnly ? "修改业务工具" : "修改运行配置", () => onSharedAgentPatch(selectedAgentId, patch), undefined, toolsOnly);
          }}
          onDescriptionChange={(value) => requestSharedEdit(selectedAgentId, "修改职责说明", () => onSharedAgentDescriptionChange(selectedAgentId, value))}
          onRenameAgent={(value) => requestSharedEdit(selectedAgentId, "修改 Agent 名称", () => onSharedAgentRename(selectedAgentId, value))}
          onSessionPersistenceChange={(enabled) => requestSharedEdit(selectedAgentId, "修改持续 session 设置", () => onSharedAgentPatch(selectedAgentId, { sessionPersistence: enabled }))}
          onWeakDecisionByChange={(decisionBy) => requestSharedEdit(selectedAgentId, "修改弱边决策者", () => onSharedAgentPatch(selectedAgentId, { decisionBy }))}
          onToggleMcp={(server, enabled) => requestSharedEdit(selectedAgentId, "修改 MCP 配置", () => onSharedAgentMcpToggle(selectedAgentId, server, enabled))}
          onAddMcp={(name, url) => new Promise<AgentMcpServer>((resolve, reject) => requestSharedEdit(
            selectedAgentId, "添加 MCP", async () => {
              try { resolve(await onSharedAgentMcpAdd(selectedAgentId, name, url)); }
              catch (error) { reject(error); throw error; }
            }, () => reject(new Error("已取消共享 Agent 配置修改"))
          ))}
          onReturnToCollaboration={() => { setSelectedId("input"); setSelectedEdgeId(undefined); }}
        /> : <h3>{selectedEdge ? "连线" : selectedId === "input" ? "进入协作组" : selectedId === "finish" ? "结束协作组" : selected?.kind === "collaboration" ? display(selected.groupId) : "请选择节点"}</h3>}
        {!selectedEdge && selectedId === "input" && <p>只有“进入协作组”可以发出多条并行边；所有合法目标在组开始时激活。不能连接父组或跨范围节点。</p>}
        {!selectedEdge && selectedId === "finish" && <p>“结束协作组”等待实际启动的所有必要路径、PR 合并与最终集成。不需要额外 Join 节点。</p>}
        {!selectedEdge && selected?.kind === "agent" && <section className="scoped-inspector-section" aria-label="本组 Agent 引用">
          <h4>本组引用</h4>
          <dl className="scoped-reference-summary">
            <div><dt>Agent</dt><dd>{selected.agentId}</dd></div>
            <div><dt>节点引用</dt><dd><code>{selected.nodeId}</code></dd></div>
            <div><dt>会话</dt><dd>沿用该 Agent 的原生会话</dd></div>
          </dl>
          <button type="button" disabled={locked} onClick={() => setRemoveCandidate(selected.nodeId)}>移除本组引用</button>
          {removeCandidate === selected.nodeId && <div>
            <p>只移除本组节点及其连线，保留 Agent、其他范围节点和会话。</p>
            <button type="button" disabled={locked} onClick={() => {
              if (mutate(draft => removeScopedNode(draft, groupId, selected.nodeId))) {
                setRemoveCandidate(undefined); setSelectedId("input");
              }
            }}>确认移除</button>
            <button type="button" onClick={() => setRemoveCandidate(undefined)}>取消</button>
          </div>}
        </section>}
        {!selectedEdge && selected?.kind === "collaboration" && <div className="scoped-inspector-section"><p>子协作组作为本组的单一复合节点；它自己的“进入协作组”节点才能并行展开。</p><button type="button" onClick={() => onNavigate(selected.groupId)}>进入 {display(selected.groupId)}</button></div>}
        {!selectedEdge && (selectedId === "input" || selected) && <section className="scoped-inspector-section">
          <h4>添加出边</h4><p>{selectedId === "input" ? "并行边 · 全部激活" : "也可以从画布上的连接点直接拖线"}</p>
          <div className={`scoped-edge-form ${selectedId === "input" ? "is-input" : ""}`}>
            <label>目标<select aria-label="组内连线目标" value={newTarget} disabled={locked} onChange={event => setNewTarget(event.target.value)}>
              <option value="">选择本组目标</option>{routeTargets.map(id => <option key={id} value={id}>{targetLabel(id)}</option>)}
            </select></label>
            {selectedId !== "input" && <label>类型<select aria-label="组内连线类型" value={newKind} disabled={locked} onChange={event => setNewKind(event.target.value as RouteKind)}><option value="strong">强边</option><option value="weak">弱边</option></select></label>}
          </div>
          <button type="button" className="scoped-primary-button" disabled={locked || !newTarget} onClick={() => connect(selectedId, newTarget)}><Plus size={13} />添加连线</button>
        </section>}
        <details className="scoped-inspector-section">
          <summary>Loop<span className="scoped-count">{workflow.loops?.length ?? 0}</span></summary>
          <p>本组的强边循环与批次退出设置。</p>
          {(workflow.loops ?? []).map(loop => <div key={loop.id}>
            <strong>{loop.id}</strong><small>{targetLabel(loop.from)} → {targetLabel(loop.to)}，最多 {loop.maxIterations} 次，退出至 {targetLabel(loop.exitTo)}</small>
            <button type="button" disabled={locked} onClick={() => mutate((_draft, current) => { current.workflow.loops = current.workflow.loops?.filter(item => item.id !== loop.id); })}>删除</button>
          </div>)}
          <div className="scoped-loop-fields">
            <label>ID<input aria-label="组内 Loop ID" value={loopId} disabled={locked} onChange={event => setLoopId(event.target.value)} /></label>
            <label>返回源<select aria-label="组内 Loop 返回源" value={loopFrom} disabled={locked} onChange={event => setLoopFrom(event.target.value)}><option value="">选择</option>{workflow.nodes.map(ref => <option key={ref.nodeId} value={ref.nodeId}>{targetLabel(ref.nodeId)}</option>)}</select></label>
            <label>入口<select aria-label="组内 Loop 入口" value={loopTo} disabled={locked} onChange={event => setLoopTo(event.target.value)}><option value="">选择</option>{workflow.nodes.map(ref => <option key={ref.nodeId} value={ref.nodeId}>{targetLabel(ref.nodeId)}</option>)}</select></label>
            <label>退出至<select aria-label="组内 Loop 退出至" value={loopExit} disabled={locked} onChange={event => setLoopExit(event.target.value)}><option value="">选择</option>{workflow.nodes.map(ref => <option key={ref.nodeId} value={ref.nodeId}>{targetLabel(ref.nodeId)}</option>)}</select></label>
            <label>最大迭代<input aria-label="组内 Loop 最大迭代" type="number" min={1} max={1000000} value={loopMax} disabled={locked} onChange={event => setLoopMax(Number(event.target.value))} /></label>
          </div>
          <button type="button" className="scoped-primary-button" disabled={locked || !loopId || !loopFrom || !loopTo || !loopExit || !Number.isSafeInteger(loopMax) || loopMax < 1 || loopMax > 1000000} onClick={() => mutate((_draft, current) => { current.workflow.loops = [...(current.workflow.loops ?? []), { id: loopId, from: loopFrom, to: loopTo, exitTo: loopExit, maxIterations: loopMax }]; })}>添加 Loop</button>
        </details>
        <details className="scoped-inspector-section scoped-git-note"><summary><GitBranch size={14} />Git 交付规则</summary><p>成员 PR 合入本组；子组交付汇入父组，顶层组最终交付到项目目标分支。</p></details>
        </div>{inspectorContent !== undefined && <div className="scoped-inspector-content">{inspectorContent}</div>}
      </aside>
    </div>
    <footer className="scoped-status-bar">
      <span role="status" title={notice || undefined}>{notice || "拖动连接点连线 · 拖动空白平移 · 滚轮缩放"}</span>
      <span className={`scoped-edit-state ${locked ? "is-readonly" : ""}`}>{locked ? "只读" : "可编辑"}</span>
    </footer>
    {pendingSharedEdit && <div className="canvas-agent-dialog" role="dialog" aria-modal="true" aria-label="确认修改共享 Agent">
      <button type="button" className="canvas-agent-dialog-backdrop" aria-label="取消修改共享 Agent" onClick={() => { pendingSharedEdit.cancel?.(); setPendingSharedEdit(undefined); if (!pendingSharedEdit.preserveDrafts) setAgentInspectorEpoch((value) => value + 1); }} />
      <div className="canvas-agent-dialog-panel">
        <div className="dialog-heading"><h2>修改共享 Agent</h2></div>
        <p>即将{pendingSharedEdit.label}：{pendingSharedEdit.agentId}。这是同一个 Agent，修改后它在外层和其他协作组中的所有引用都会使用新配置；其他不同 Agent、各图连线和布局不受影响。</p>
        <div className="dialog-actions">
          <button type="button" onClick={() => { pendingSharedEdit.cancel?.(); setPendingSharedEdit(undefined); if (!pendingSharedEdit.preserveDrafts) setAgentInspectorEpoch((value) => value + 1); }}>取消</button>
          <button type="button" className="primary-button" onClick={() => {
            const pending = pendingSharedEdit;
            setPendingSharedEdit(undefined);
            void Promise.resolve(pending.apply()).catch((error) => {
              setNotice(error instanceof Error ? error.message : "共享 Agent 配置修改失败");
              setAgentInspectorEpoch((value) => value + 1);
            });
          }}>应用到所有引用</button>
        </div>
      </div>
    </div>}
  </div>;
}
