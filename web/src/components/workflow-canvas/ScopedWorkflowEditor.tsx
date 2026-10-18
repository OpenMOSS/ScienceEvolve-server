import type { ReactNode } from "react";
import { ArrowLeft, GitBranch, Layers3, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
import type { CanvasEdge, CanvasNode } from "./core/canvas-model";
import type { CanvasViewport } from "./core/canvas-model";
import { buildLockedEdgeRoutesFromSnapshot, captureRouteLock, type DragRouteLock } from "./core/canvas-router";
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
type NodeDrag = { id: string; pointerId: number; clientX: number; clientY: number; x: number; y: number };
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
  const [drag, setDrag] = useState<NodeDrag>();
  const [dragPoint, setDragPoint] = useState<{ x: number; y: number }>();
  const [pan, setPan] = useState<CanvasPan>();
  const [viewViewport, setViewViewport] = useState<CanvasViewport>();
  const canvasHostRef = useRef<HTMLDivElement>(null);
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
    setViewViewport(undefined);
    setLinkStart(undefined);
    setDrag(undefined);
    setDragPoint(undefined);
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
      const target = event.target as HTMLElement | null;
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
  const viewport = viewViewport ?? layout.viewport;
  const positions = layout.nodes;
  const nodes: CanvasNode[] = [
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
  const selectedLoopId = selectedEdge?.loop?.role === "exit" ? undefined : selectedEdge?.loop?.id;
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

  const connect = (source: string, target: string, sourcePort?: WorkflowCanvasPort, targetPort?: WorkflowCanvasPort) => {
    const kind = source === "input" ? "parallel" : newKind;
    mutate((_draft, current) => {
      addScopedRoute(current.workflow, source, target, kind);
      current.workflow.canvas ??= defaultScopedCanvas(current.workflow.nodes.map((ref) => ref.nodeId), []);
      const id = canvasEdgeId(source, target);
      current.workflow.canvas.edges[id] = {
        sourcePort: sourcePort ?? "right", targetPort: targetPort ?? "left",
        sourcePortPinned: Boolean(sourcePort), targetPortPinned: Boolean(targetPort)
      };
    });
    setLinkStart(undefined);
    setLinkTarget(undefined);
    setNewTarget("");
  };
  const portDown = (event: ReactPointerEvent<HTMLButtonElement>, node: CanvasNode, port: WorkflowCanvasPort) => {
    if (locked) return;
    if (linkStart && linkStart.source !== node.id) {
      if (node.id === "input") { setNotice("进入协作组只能作为并行边的来源"); return; }
      connect(linkStart.source, node.id, linkStart.port, port);
      return;
    }
    if (node.id === "finish") return;
    setLinkStart({ source: node.id, port });
    setLinkTarget(undefined);
    event.preventDefault();
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pan?.pointerId === event.pointerId) {
      setViewViewport({ ...pan.viewport, x: pan.viewport.x + event.clientX - pan.clientX, y: pan.viewport.y + event.clientY - pan.clientY });
      return;
    }
    const active = dragRef.current;
    if (active?.pointerId !== event.pointerId) return;
    const point = {
      x: Math.round(active.x + (event.clientX - active.clientX) / viewport.zoom),
      y: Math.round(active.y + (event.clientY - active.clientY) / viewport.zoom)
    };
    dragFrames.schedule(() => setDragPoint(point));
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pan?.pointerId === event.pointerId) {
      updateViewport({ ...pan.viewport, x: pan.viewport.x + event.clientX - pan.clientX, y: pan.viewport.y + event.clientY - pan.clientY });
      setPan(undefined);
      return;
    }
    const active = dragRef.current;
    if (active?.pointerId === event.pointerId) {
      dragFrames.cancel();
      dragRef.current = undefined;
      const point = {
        x: Math.round(active.x + (event.clientX - active.clientX) / viewport.zoom),
        y: Math.round(active.y + (event.clientY - active.clientY) / viewport.zoom)
      };
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
      return;
    }
    if (linkStart) {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]")?.dataset.nodeId ?? linkTarget;
      if (target && target !== linkStart.source && target !== "input") connect(linkStart.source, target, linkStart.port);
    }
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
    <nav className="scoped-breadcrumbs" aria-label="Workflow 范围路径">
      <button type="button" className="scoped-parent-link" aria-label="返回父图" title={`返回${group.parentGroupId ? display(group.parentGroupId) : "项目"}`} onClick={() => onNavigate(group.parentGroupId)}><ArrowLeft size={14} /><span>返回父图</span></button>
      <button type="button" onClick={() => onNavigate()}>项目</button>
      {path.map((item, index) => <span key={item.id}>
        <span aria-hidden="true">›</span>
        <button type="button" aria-current={index === path.length - 1 ? "page" : undefined} onClick={() => onNavigate(item.id)}>{display(item.id)}</button>
      </span>)}
    </nav>
    <div className="scoped-toolbar">
      <strong>{registry?.displayName ?? group.id} · 组内 Workflow</strong>
      <span>{workflow.nodes.length} 个直接节点 · {inputCount} 条并行入口</span>
    </div>
    <CanvasToolbar edgeKind={newKind} zoom={viewport.zoom} connecting={Boolean(linkStart)} readOnly={locked} allowFitWhenReadOnly layoutBusy={layoutBusy} layoutStatus={layoutStatus} layoutPhase={layoutPhase} canUndo={history.length > 0 && lockedGroupIds.size === 0} canRedo={redoHistory.length > 0 && lockedGroupIds.size === 0} addAgentLabel="引用 Agent" onAddAgent={() => addAgentSelectRef.current?.focus()} onToggleConnect={() => setNotice("从本组节点端口拖动到目标端口即可连线；仅进入协作组可发并行边")} onEdgeKindChange={setNewKind} onZoomOut={() => zoomView(.85)} onResetZoom={fitView} onZoomIn={() => zoomView(1.15)} onUndo={undo} onRedo={redo} onTidy={() => void applyLayout("tidy")} onLayered={() => void applyLayout("layered")} onFit={fitView} />
    {locked && <p className="scoped-alert" role="status">该范围正在运行或集成，只能查看，不能直接覆盖活动 revision。</p>}
    {strictError && <p className="scoped-alert" role="alert">启动前需修复：{strictError}</p>}
    {notice && <p className="scoped-notice" role="status">{notice}</p>}
    <div className="scoped-body">
      <aside className="scoped-panel scoped-library" aria-label="协作组设置">
        <h3><Layers3 size={15} />组设置</h3>
        <label>显示名称<input aria-label="协作组显示名称" value={registry?.displayName ?? group.id} disabled={locked || registry?.renamePolicy === "locked"} onChange={(event) => mutate((draft) => { const entry = draft.collaborations?.find((item) => item.id === groupId); if (entry) entry.displayName = event.target.value; })} /></label>
        <label>Leader<select aria-label="协作组 Leader" value={group.leaderAgentId} disabled={locked} onChange={(event) => mutate((_draft, current) => { current.leaderAgentId = event.target.value; })}>
          {orchestration.agents.filter((agent) => !workflow.nodes.some((ref) => ref.kind === "agent" && ref.agentId === agent.name)).map((agent) => <option key={agent.name} value={agent.name}>{agent.name}</option>)}
        </select></label>
        <label>弱边决策者<select aria-label="组内协作组弱边决策者" value={group.decisionBy ?? "main"} disabled={locked} onChange={(event) => mutate((_draft, current) => { current.decisionBy = event.target.value as "main" | "agent"; })}>
          <option value="main">组内 Leader 选择</option>
          <option value="agent">协作组自身选择（{group.leaderAgentId}）</option>
        </select></label>
        <small>子协作组选择“组内 Leader”时由当前组 Leader 选边；选择自身时由子组 Leader 选边。</small>
        <small>Leader 只管理本组，不能同时担任本组或后代业务节点；外层原 Agent 与 session 保留。</small>
        <label className="scoped-switch"><input type="checkbox" role="switch" aria-label="允许 Leader 自动调整本组 Workflow" checked={group.allowLeaderReconfiguration} disabled={locked} onChange={(event) => mutate((_draft, current) => { current.allowLeaderReconfiguration = event.target.checked; })} />允许 Leader 自动调整本组 Workflow</label>
        <small>仅在本轮取得执行权和 capability 后生效，不授予组外管理或跳过权限。</small>
        <h3>直接成员</h3>
        <ul>{workflow.nodes.map((ref) => <li key={ref.nodeId}><button type="button" onClick={() => { setSelectedId(ref.nodeId); setSelectedEdgeId(undefined); }}>{ref.kind === "agent" ? ref.agentId : display(ref.groupId)}</button>{ref.kind === "collaboration" && <button type="button" onClick={() => onNavigate(ref.groupId)}>进入</button>}</li>)}</ul>
        <label>引用已有 Agent<select ref={addAgentSelectRef} aria-label="引用已有 Agent" value={newAgentId} disabled={locked || !addableAgents.length} onChange={(event) => setNewAgentId(event.target.value)}><option value="">选择 Agent</option>{addableAgents.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
        <button type="button" disabled={locked || !newAgentId} onClick={() => { mutate((draft) => { const id = addScopedAgentReference(draft, groupId, newAgentId); setSelectedId(id); }); setNewAgentId(""); }}><Plus size={13} />添加同一 Agent 引用</button>
        <small>只增加本组图节点；原范围节点、连线、Agent 身份和原生 session 不变。</small>
        <button type="button" disabled={locked} onClick={() => setShowChildForm((value) => !value)}><Plus size={13} />新建子协作组</button>
        {showChildForm && <div className="scoped-child-form" aria-label="新建子协作组">
          <label>子组 ID<input value={newGroupId} onChange={(event) => setNewGroupId(event.target.value)} /></label>
          <label>名称<input value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} /></label>
          <fieldset><legend>引用本组已有 Agent（至少两名）</legend>{directAgents.map((id) => <label key={id}><input type="checkbox" checked={childMembers.has(id)} disabled={id === group.leaderAgentId} onChange={(event) => { const next = new Set(childMembers); if (event.target.checked) next.add(id); else next.delete(id); setChildMembers(next); }} />{id}</label>)}</fieldset>
          <label>子组 Leader<select value={childLeader} onChange={(event) => setChildLeader(event.target.value)}><option value="">选择非成员 Agent</option>{childLeaderOptions.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
          <button type="button" onClick={createChild}>创建子组</button>
        </div>}
      </aside>
      <div className="scoped-canvas-host" ref={canvasHostRef}>
        <CanvasWorld viewport={viewport} worldWidth={1480} worldHeight={Math.max(860, ...nodes.map((node) => node.y + 180))} connecting={Boolean(linkStart)} panning={Boolean(pan)} layoutBusy={layoutBusy} onPointerDown={(event) => { if (event.button !== 0 || (event.target as HTMLElement).closest(".agent-node, .workflow-edge-group")) return; setPan({ pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, viewport }); event.currentTarget.setPointerCapture?.(event.pointerId); }} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { dragFrames.cancel(); dragRef.current = undefined; dragRoutesRef.current = undefined; setPan(undefined); setDrag(undefined); setDragPoint(undefined); }} onWheel={(event) => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); updateViewport(zoomCanvasViewportAt(viewport, { x: event.clientX - rect.left, y: event.clientY - rect.top }, viewport.zoom * Math.exp(-Math.max(-240, Math.min(240, event.deltaY)) * .0015))); }} hint={routed.pending ? "正在优化连线，可继续编辑…" : linkStart ? `从 ${linkStart.source === "input" ? "进入协作组" : linkStart.source} 连线：仅可连接本组直接节点${linkStart.source === "input" ? "，并行边会全部激活" : "或结束协作组"}` : "拖动空白平移，滚轮缩放；拖动节点布局，或从连接点添加连线。"}>
          <CanvasEdges edges={geometry} nodes={displayNodes} moving={Boolean(drag)} selectedEdgeId={selectedEdgeId} selectedEdgeIds={selectedEdgeIds} selectedLoopId={selectedLoopId} focusedNodeId={selectedId} onSelectEdge={(item) => { setSelectedEdgeId(item.id); setSelectedId(item.source ?? "input"); }} />
          <CanvasNodes nodes={displayNodes} selectedNodeId={selectedEdge ? undefined : selectedId} connectionSourceId={linkStart?.source} connectionTargetId={linkTarget} readOnly={locked} suppressGroupMembers resolvePresentation={(node) => node.id === "input" ? { title: "进入协作组", description: "仅此处可发出并行入口边", modelLabel: "PARALLEL", color: "#316ac4", softColor: "#eaf1ff" } : node.id === "finish" ? { title: "结束协作组", description: "等待所有必要路径与 Git 集成", modelLabel: "END", color: "#a65365", softColor: "#f9eaed" } : node.collaboration ? { title: node.displayName ?? node.name, description: "子协作组 · 可进入内部编排", modelLabel: "GROUP", initials: "组", color: "#5c5bd6", softColor: "#eeedff" } : { title: node.displayName ?? node.name, description: "引用同一 Agent · 保留原 session", modelLabel: "AGENT", color: "#25714e", softColor: "#e7f1e9" }} onSelectNode={(node) => { setSelectedId(node.id); setSelectedEdgeId(undefined); }} onEditNode={(node) => { const ref = workflow.nodes.find((item) => item.nodeId === node.id); if (ref?.kind === "collaboration") onNavigate(ref.groupId); else setSelectedId(node.id); }} onNodePointerDown={(event, node) => { if (event.button !== 0) return; const position = positions[node.id]; if (!position) return; dragPendingRef.current = routed.pending; dragRoutesRef.current = captureRouteLock(routeGeometry, nodes); const nextDrag = { id: node.id, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, ...position }; dragRef.current = nextDrag; setDrag(nextDrag); setDragPoint(position); event.currentTarget.setPointerCapture?.(event.pointerId); }} onPortPointerDown={portDown} onPortPointerEnter={(node) => setLinkTarget(node.id)} onPortPointerLeave={() => setLinkTarget(undefined)} />
        </CanvasWorld>
      </div>
      <aside className="scoped-panel scoped-inspector" aria-label="组内节点属性">
        {inspectorTabs}<div hidden={inspectorContent !== undefined}>
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
        {!selectedEdge && selected?.kind === "agent" && <div className="scoped-inspector-section"><p>引用同一 Agent：{selected.agentId}</p><p>持续 session：{orchestration.agents.find((item) => item.name === selectedAgentId) ? "沿用该 Agent 的原生会话" : "Agent 不存在"}</p><p>节点引用：{selected.nodeId}</p><button type="button" disabled={locked} onClick={() => setRemoveCandidate(selected.nodeId)}>移除本组引用</button>{removeCandidate === selected.nodeId && <div><p>只移除本组节点及其连线，保留 Agent、其他范围节点和 session。</p><button type="button" onClick={() => { mutate((draft) => removeScopedNode(draft, groupId, selected.nodeId)); setRemoveCandidate(undefined); setSelectedId("input"); }}>确认移除</button><button type="button" onClick={() => setRemoveCandidate(undefined)}>取消</button></div>}</div>}
        {!selectedEdge && selected?.kind === "collaboration" && <div className="scoped-inspector-section"><p>子协作组作为本组的单一复合节点；它自己的“进入协作组”节点才能并行展开。</p><button type="button" onClick={() => onNavigate(selected.groupId)}>进入 {display(selected.groupId)}</button></div>}
        {!selectedEdge && selectedId !== "finish" && <div className="scoped-inspector-section"><h4>添加出边</h4><p>{selectedId === "input" ? "并行边 · 全部激活" : "普通节点仅能使用强边或弱边"}</p><label>目标<select aria-label="组内连线目标" value={newTarget} disabled={locked} onChange={(event) => setNewTarget(event.target.value)}><option value="">选择本组目标</option>{routeTargets.map((id) => <option key={id} value={id}>{targetLabel(id)}</option>)}</select></label>{selectedId !== "input" && <label>类型<select aria-label="组内连线类型" value={newKind} disabled={locked} onChange={(event) => setNewKind(event.target.value as RouteKind)}><option value="strong">强边</option><option value="weak">弱边</option></select></label>}<button type="button" disabled={locked || !newTarget} onClick={() => connect(selectedId, newTarget)}><Plus size={13} />添加连线</button></div>}
        <div className="scoped-inspector-section"><h4>Loop</h4><p>复用强边环与批次退出语义；所有节点须在本组范围。</p>{(workflow.loops ?? []).map((loop) => <div key={loop.id}><strong>{loop.id}</strong><small>{loop.from} → {loop.to}，最多 {loop.maxIterations} 次，退出至 {loop.exitTo}</small><button type="button" disabled={locked} onClick={() => mutate((_draft, current) => { current.workflow.loops = current.workflow.loops?.filter((item) => item.id !== loop.id); })}>删除</button></div>)}<label>ID<input aria-label="组内 Loop ID" value={loopId} onChange={(event) => setLoopId(event.target.value)} /></label><label>返回源<select aria-label="组内 Loop 返回源" value={loopFrom} onChange={(event) => setLoopFrom(event.target.value)}><option value="">选择</option>{workflow.nodes.map((ref) => <option key={ref.nodeId}>{ref.nodeId}</option>)}</select></label><label>入口<select aria-label="组内 Loop 入口" value={loopTo} onChange={(event) => setLoopTo(event.target.value)}><option value="">选择</option>{workflow.nodes.map((ref) => <option key={ref.nodeId}>{ref.nodeId}</option>)}</select></label><label>退出至<select aria-label="组内 Loop 退出至" value={loopExit} onChange={(event) => setLoopExit(event.target.value)}><option value="">选择</option>{workflow.nodes.map((ref) => <option key={ref.nodeId}>{ref.nodeId}</option>)}</select></label><label>最大迭代<input aria-label="组内 Loop 最大迭代" type="number" min={1} max={1000000} value={loopMax} onChange={(event) => setLoopMax(Number(event.target.value))} /></label><button type="button" disabled={locked || !loopId || !loopFrom || !loopTo || !loopExit} onClick={() => mutate((_draft, current) => { current.workflow.loops = [...(current.workflow.loops ?? []), { id: loopId, from: loopFrom, to: loopTo, exitTo: loopExit, maxIterations: loopMax }]; })}>添加 Loop</button></div>
        <div className="scoped-inspector-section scoped-git-note"><GitBranch size={15} /><p>本组运行实例拥有独立集成分支；成员 PR 合入本组，子组最终 PR 汇入本组，顶层组最终 PR 汇入项目目标分支。</p></div>
        </div>{inspectorContent}
      </aside>
    </div>
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
