import { Atom, Download, Save, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import type {
  AgentConfig,
  CollaborationDissolutionPlan,
  CollaborationNode,
  AgentDefinition,
  AgentMcpServer,
  AgentOrchestrationTemplate,
  AgentTemplate,
  AgentsConfig,
  FixedMcpDefinition,
  GatewayRecord,
  GitHubAccountRecord,
  GitRepositoryVisibility,
  HarnessCatalogEntry,
  SkillDefinition,
  WorkflowCanvasEdgeLayout,
  WorkflowCanvasLayout,
  WorkflowCanvasPort,
  WorkflowEdge,
  WorkflowLoop
} from "../../types";
import {
  agentMcpServerKey,
  agentMeta,
  catalogDefaultHarnessId,
  constrainAgentConfigToHarness,
  defaultAgentConfig,
  isAgentIdentifier
} from "../../lib";
import {
  adaptWorkflowToCanvas,
  applyCanvasLayout
} from "./core/canvas-adapter";
import { CANVAS_FINISH_NODE_ID, CANVAS_INPUT_NODE_ID, canvasNodeSize } from "./core/canvas-model";
import {
  buildCanvasLayoutGraph,
  canvasEdgeId,
  normalizeCanvasLayout,
  relativePort,
  withCanvasLoopPresentation
} from "./core/canvas-layout";
import {
  buildCanvasLayoutPlan,
  sameCanvasLayoutFrame,
  type CanvasLayoutPlan
} from "./core/canvas-layout-plan";
import type { CanvasEdge, CanvasNode, CanvasSize } from "./core/canvas-model";
import { CANVAS_WORLD_HEIGHT, CANVAS_WORLD_WIDTH } from "./core/canvas-model";
import {
  canvasContentBounds,
  canvasToScreen,
  fitCanvasViewport,
  fitCompactCanvasViewport,
  screenToCanvas,
  zoomCanvasViewportAt
} from "./core/canvas-viewport";
import { buildLockedEdgeRoutesFromSnapshot, canvasPortPoint, canvasRouteTopologyKey, captureRouteLock, geometryFromRouteLocks, polylineIntersectsRect, routeCanvasEdges, type DragRouteLock, type EdgeGeometry } from "./core/canvas-router";
import {
  observeCanvasGeometryFrame,
  publishCanvasGeometryObservation,
  type CanvasGeometryObservation,
  type GeometryFramePhase
} from "./core/canvas-geometry-observer";
import { CanvasEdges } from "./CanvasEdges";
import { CanvasFooter } from "./CanvasFooter";
import { CanvasNodes, type CanvasNodePresentation } from "./CanvasNodes";
import { CanvasToolbar } from "./CanvasToolbar";
import { CanvasWorld } from "./CanvasWorld";
import { useCanvasRouting } from "./useCanvasRouting";
import { useCanvasPointerFrame } from "./useCanvasPointerFrame";
import { needsBackgroundRouting } from "./core/canvas-routing-service";
import { AgentLibraryPanel } from "./AgentLibraryPanel";
import { SavedFlowsPanel } from "./SavedFlowsPanel";
import { CanvasInspector } from "./CanvasInspector";
import { GitRepositorySettings, gitRepositoryNameError } from "../GitRepositorySettings";
import { syncMainOuterRoutes, workflowOuterNodeIds } from "./core/workflow-nodes";
import { reconcileLoopTopology } from "./core/workflow-loop-editor";
import { validateWorkflowLoops, workflowLoopMembers } from "../../../../server/src/internal/shared/workflow-loop-validation.js";
import { CollaborationDissolutionPlanner } from "./CollaborationDissolutionPlanner";
import { ScopedWorkflowEditor } from "./ScopedWorkflowEditor";
import { addScopedGroup, upgradeLegacyGroups } from "./core/scoped-workflow";
import type { WorkflowCanvasSavedFlow } from "./types";
import {
  buildGuidedDissolutionPlan,
  canRestoreCollaborationSnapshot,
  dissolutionPlanError,
  dissolveCollaborationInDraft
} from "./core/collaboration-dissolution";
import "./workflow-canvas.css";

declare global {
  interface Window {
    /** Last layout-operation trace, exposed for browser acceptance audits. */
    __openfarsCanvasLayoutSnapshots?: CanvasLayoutOperationSnapshot[];
  }
}

const PORTS: WorkflowCanvasPort[] = ["top", "right", "bottom", "left"];
const COLOR_VARS: Record<string, [string, string]> = {
  green: ["#25714e", "#e7f1e9"], indigo: ["#5c5bd6", "#eeedff"], amber: ["#b56f17", "#fff2d9"],
  cyan: ["#177588", "#e1f4f5"], violet: ["#76599d", "#f1ebf8"], rose: ["#a65365", "#f9eaed"], slate: ["#526674", "#eaf0f3"]
};

function workerRoutes(workflow: AgentOrchestrationTemplate) {
  return Object.fromEntries(workflow.agents.filter((agent) => agent.name !== "main")
    .map((agent) => [agent.name, workflow.routes[agent.name] ?? []]));
}

function workerStrongEdges(workflow: AgentOrchestrationTemplate) {
  return workflow.agents.filter((agent) => agent.name !== "main")
    .flatMap((agent) => (workflow.routes[agent.name] ?? [])
      .filter((route) => route.kind === "strong" && route.target !== "finish")
      .map((route) => ({ source: agent.name, target: route.target })));
}

export interface WorkflowCanvasEditorProps {
  orchestration: AgentOrchestrationTemplate;
  agents: AgentsConfig;
  workflowName?: string;
  mode?: "full" | "compact";
  compact?: boolean;
  readOnly?: boolean;
  /** Share the existing right column with host-owned records. */
  inspectorTabs?: ReactNode;
  inspectorContent?: ReactNode;
  agentHarnessConstraint?: (agentId: string) => { harnessId: string; reason: string } | undefined;
  mcpDirectory?: FixedMcpDefinition[];
  mcpOptions?: AgentMcpServer[];
  gateways?: GatewayRecord[];
  harnesses?: HarnessCatalogEntry[];
  skills?: SkillDefinition[];
  onAddSkill?: (title: string, content: string) => Promise<SkillDefinition>;
  savedFlows?: WorkflowCanvasSavedFlow[];
  activeSavedFlowId?: string;
  onOrchestrationChange: (value: AgentOrchestrationTemplate) => void;
  onAgentsChange: (value: AgentsConfig) => void;
  onWorkflowNameChange?: (value: string) => void;
  onOpenTextEditor?: () => void;
  onClose?: () => void;
  onSave?: () => void;
  onDownload?: () => void;
  onLoadSavedFlow?: (id: string) => void;
  onRenameSavedFlow?: (id: string) => void;
  onDeleteSavedFlow?: (id: string) => void;
  onCreateSavedFlow?: () => void;
  onSaveSavedFlow?: (id: string) => void;
  saving?: boolean;
  /** Increment after a persistence request succeeds so local edit notices reset. */
  saveRevision?: number;
  className?: string;
  /** Read-only hook used by browser audits and host integrations. */
  onGeometryObservation?: (observation: CanvasGeometryObservation) => void;
  /** Optional deterministic trace of the layered/tidy/viewport phases. */
  onLayoutSnapshot?: (snapshot: CanvasLayoutOperationSnapshot) => void;
  /** Creation-time immutable Git choice. Collaboration requires this to be true. */
  gitEnabled?: boolean;
  onGitEnabledChange?: (enabled: boolean) => void;
  githubAccounts?: GitHubAccountRecord[];
  githubAccountId?: string;
  githubAccountsLoading?: boolean;
  onGitHubAccountChange?: (accountId: string) => void;
  gitRepositoryName?: string;
  gitRepositoryVisibility?: GitRepositoryVisibility;
  onGitRepositoryNameChange?: (name: string) => void;
  onGitRepositoryVisibilityChange?: (visibility: GitRepositoryVisibility) => void;
  /** Ephemeral view state owned by the page so compact/full views share it. */
  expandedGroupIds?: ReadonlySet<string>;
  onExpandedGroupIdsChange?: (value: Set<string>) => void;
  /** Active groups remain locked through final PR reconciliation. */
  lockedGroupIds?: ReadonlySet<string>;
  collaborationLockReason?: string;
}

export type CanvasLayoutSnapshotPhase = "planning" | "planned" | "applying" | "final" | "unchanged" | "cancelled";

export interface CanvasLayoutOperationSnapshot {
  operationId: number;
  signature: string;
  operation: "layered" | "tidy" | "fit";
  phase: CanvasLayoutSnapshotPhase;
  layout?: WorkflowCanvasLayout;
  layoutMode?: CanvasLayoutPlan["mode"];
  finalViewport?: WorkflowCanvasLayout["viewport"];
  movedNodeCount?: number;
  portChangeCount?: number;
  collisionReduction?: number;
  usedFallback?: boolean;
  fallbackReason?: string;
}

type HistoryEntry = { orchestration: AgentOrchestrationTemplate; agents: AgentsConfig; viewport: WorkflowCanvasLayout["viewport"] };
type DragState = { id: string; x: number; y: number; originX: number; originY: number };
type ActiveDragState = DragState & { pointerId: number; pointerX: number; pointerY: number; zoom: number };
type PendingNodePosition = Pick<DragState, "id" | "x" | "y" | "originX" | "originY">;
type Connection = { id: string; port: WorkflowCanvasPort };
type ConnectionFailure = { nodeId: string; pulse: number };
type SettledRouteLock = { topologyKey: string; nodeFrameKey: string; routes: DragRouteLock[]; provisional?: boolean };
type LayoutRouteLock = { topologyKey: string; routes: DragRouteLock[] };
type ConnectionGesture = { pointerId: number; startX: number; startY: number; moved: boolean };
type PanState = { pointerId: number; startX: number; startY: number; originX: number; originY: number; currentX: number; currentY: number; moved: boolean };
type GuideState = { vertical?: number; horizontal?: number };
type LayoutPhase = "idle" | "planning" | "applying";
type LayoutEdgeTransition = { sourceRoutes: DragRouteLock[]; progress: number };
type CanvasPointerSample = Pick<PointerEvent, "type" | "pointerId" | "clientX" | "clientY" | "preventDefault">;

export function WorkflowCanvasEditor({
  orchestration,
  agents,
  workflowName = "未命名流程",
  mode,
  compact: compactProp = false,
  readOnly = false,
  inspectorTabs, inspectorContent, agentHarnessConstraint,
  mcpDirectory = [],
  mcpOptions,
  gateways = [],
  harnesses = [],
  skills = [],
  onAddSkill,
  savedFlows = [],
  activeSavedFlowId,
  onOrchestrationChange,
  onAgentsChange,
  onWorkflowNameChange,
  onOpenTextEditor,
  onClose,
  onSave,
  onDownload,
  onLoadSavedFlow,
  onRenameSavedFlow,
  onDeleteSavedFlow,
  onCreateSavedFlow,
  onSaveSavedFlow,
  saving = false,
  saveRevision = 0,
  className = "",
  onGeometryObservation,
  onLayoutSnapshot,
  gitEnabled = false,
  onGitEnabledChange,
  githubAccounts = [],
  githubAccountId,
  githubAccountsLoading = false,
  onGitHubAccountChange,
  gitRepositoryName = "",
  gitRepositoryVisibility = "private",
  onGitRepositoryNameChange,
  onGitRepositoryVisibilityChange,
  expandedGroupIds: controlledExpandedGroupIds,
  onExpandedGroupIdsChange,
  lockedGroupIds = new Set<string>(),
  collaborationLockReason
}: WorkflowCanvasEditorProps) {
  const compact = mode === "compact" || compactProp;
  const effectiveReadOnly = readOnly || compact;
  // An explicit empty selection is a real editor state.  In particular, a
  // click on canvas whitespace must not immediately fall back to the input
  // target (the fallback is only for a deleted/invalid selected id).
  const [selectedId, setSelectedId] = useState<string | undefined>(orchestration.input.target || "main");
  const [hoveredNodeId, setHoveredNodeId] = useState<string>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [newEdgeKind, setNewEdgeKind] = useState<"strong" | "weak">("strong");
  const [dragging, setDragging] = useState<DragState>();
  const [pendingNodePosition, setPendingNodePosition] = useState<PendingNodePosition>();
  const [connectionSource, setConnectionSource] = useState<Connection>();
  const [connectionTarget, setConnectionTarget] = useState<Connection>();
  const [linkPreview, setLinkPreview] = useState<{ x: number; y: number }>();
  const [invalidConnection, setInvalidConnection] = useState(false);
  const [connectionFailure, setConnectionFailure] = useState<ConnectionFailure>();
  const [pan, setPan] = useState<PanState>();
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [viewportOverride, setViewportOverride] = useState<{ x: number; y: number; zoom: number }>();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [redoHistory, setRedoHistory] = useState<HistoryEntry[]>([]);
  const historyNavigationSignatureRef = useRef<string>();
  useEffect(() => {
    const signature = JSON.stringify({ orchestration, agents });
    if (historyNavigationSignatureRef.current !== signature) setRedoHistory([]);
    historyNavigationSignatureRef.current = undefined;
  }, [orchestration, agents]);
  const [notice, setNotice] = useState("");
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [layoutPhase, setLayoutPhase] = useState<LayoutPhase>("idle");
  const [layoutMessage, setLayoutMessage] = useState("");
  const [layoutPreview, setLayoutPreview] = useState<ReturnType<typeof normalizeCanvasLayout>>();
  const [layoutEdgeTransition, setLayoutEdgeTransition] = useState<LayoutEdgeTransition>();
  const [geometryValid, setGeometryValid] = useState(true);
  const [nodeSizes, setNodeSizes] = useState<Record<string, CanvasSize>>({});
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentTemplate, setNewAgentTemplate] = useState<AgentTemplate>("general");
  const [newAgentDescription, setNewAgentDescription] = useState("");
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [showAddCollaboration, setShowAddCollaboration] = useState(false);
  const [gitRepositoryDialog, setGitRepositoryDialog] = useState<{
    accountId?: string;
    repositoryName: string;
    visibility: GitRepositoryVisibility;
    disableGitOnCancel: boolean;
  }>();
  const [newGroupId, setNewGroupId] = useState("");
  const [newGroupDisplayName, setNewGroupDisplayName] = useState("");
  const [newGroupMembers, setNewGroupMembers] = useState<Set<string>>(new Set());
  const [newGroupLeaderId, setNewGroupLeaderId] = useState("");
  const [legacyLeaderSelections, setLegacyLeaderSelections] = useState<Record<string, string>>({});
  const [showLegacyUpgrade, setShowLegacyUpgrade] = useState(false);
  const [activeScopedGroupId, setActiveScopedGroupId] = useState<string>();
  const [dissolutionDraft, setDissolutionDraft] = useState<{
    groupId: string;
    plan?: CollaborationDissolutionPlan;
  }>();
  const [editingGroupMemberId, setEditingGroupMemberId] = useState<string>();
  const [localExpandedGroupIds, setLocalExpandedGroupIds] = useState<Set<string>>(new Set());
  const [nameDraftInvalid, setNameDraftInvalid] = useState(false);
  const [guides, setGuides] = useState<GuideState>({});
  const openGitRepositoryDialog = (disableGitOnCancel: boolean) => {
    const readyAccounts = githubAccounts.filter((account) => account.status === "ready");
    if (!readyAccounts.length) return;
    const selectedAccountId = readyAccounts.some((account) => account.id === githubAccountId)
      ? githubAccountId
      : readyAccounts.find((account) => account.isDefault)?.id ?? readyAccounts[0]?.id;
    setGitRepositoryDialog({
      accountId: selectedAccountId,
      repositoryName: gitRepositoryName,
      visibility: gitRepositoryVisibility,
      disableGitOnCancel
    });
  };
  const setCanvasGitMode = (enabled: boolean) => {
    if (!enabled && (orchestration.collaborations?.length ?? 0) > 0) return;
    onGitEnabledChange?.(enabled);
    setNotice("有未保存修改");
    if (enabled) openGitRepositoryDialog(true);
    else setGitRepositoryDialog(undefined);
  };
  const closeGitRepositoryDialog = () => {
    if (gitRepositoryDialog?.disableGitOnCancel && !(orchestration.collaborations?.length)) onGitEnabledChange?.(false);
    setGitRepositoryDialog(undefined);
  };
  const confirmGitRepositoryDialog = () => {
    if (!gitRepositoryDialog?.accountId || gitRepositoryNameError(gitRepositoryDialog.repositoryName)) return;
    onGitHubAccountChange?.(gitRepositoryDialog.accountId);
    onGitRepositoryNameChange?.(gitRepositoryDialog.repositoryName);
    onGitRepositoryVisibilityChange?.(gitRepositoryDialog.visibility);
    setGitRepositoryDialog(undefined);
    setNotice("Git 仓库设置已更新");
  };
  const expandedGroupIds = controlledExpandedGroupIds ?? localExpandedGroupIds;
  const setExpandedGroupIds = (value: Set<string>) => {
    if (controlledExpandedGroupIds) onExpandedGroupIdsChange?.(value);
    else setLocalExpandedGroupIds(value);
  };
  const toggleGroup = (groupId: string) => {
    const next = new Set(expandedGroupIds);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    setExpandedGroupIds(next);
  };
  const collapseGroup = (groupId: string) => {
    if (!expandedGroupIds.has(groupId)) return;
    const next = new Set(expandedGroupIds);
    next.delete(groupId);
    setExpandedGroupIds(next);
  };
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const agentNameInputRef = useRef<HTMLInputElement>(null);
  // React state drives the visual frame, while this ref is the authoritative
  // gesture state. Pointermove and pointerup can arrive before React has
  // committed the preceding render, especially while routing a large graph.
  const dragRef = useRef<ActiveDragState>();
  const connectionRef = useRef<Connection>();
  const connectionTargetRef = useRef<Connection>();
  const connectionGestureRef = useRef<ConnectionGesture>();
  const connectionFailureTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const connectionFailurePulseRef = useRef(0);
  const panRef = useRef<PanState>();
  const pointerHandlersRef = useRef<{ move: (event: CanvasPointerSample) => void; finish: (event: CanvasPointerSample) => void }>();
  const lockedGeometryRef = useRef<DragRouteLock[]>();
  const dragRoutingPendingRef = useRef(false);
  // Keep the exact release-frame topology until an actual semantic/port
  // change occurs. Previously the drag lock vanished on pointer-up and the
  // first persisted render could choose a different lane, producing a visible
  // one-frame jump even though the node itself had stopped moving.
  const settledGeometryRef = useRef<SettledRouteLock>();
  // Unrelated renders reuse the last settled route. Topology, node position,
  // or measured-size changes invalidate it so an old absolute SVG path can
  // never survive undo or another externally-driven layout update.
  const routeCacheRef = useRef<SettledRouteLock & { nodes?: CanvasNode[] }>();
  /** Final canonical routes for the active layout animation. */
  const layoutRouteLockRef = useRef<LayoutRouteLock>();
  const semanticKeyRef = useRef<string>();
  const saveRevisionRef = useRef(saveRevision);
  const geometryInputsRef = useRef<{
    nodes: readonly CanvasNode[];
    geometry: readonly EdgeGeometry[];
    draggedNodeId?: string;
    previous?: CanvasGeometryObservation;
  }>();
  const geometryCaptureRef = useRef<(
    phase: GeometryFramePhase
  ) => CanvasGeometryObservation>();
  const orchestrationRef = useRef(orchestration);
  const layoutOperationRef = useRef(0);
  const layoutKindRef = useRef<"layered" | "tidy" | "fit">("layered");
  const layoutBusyRef = useRef(false);
  const layoutViewportBeforeRef = useRef<{ viewport?: WorkflowCanvasLayout["viewport"] }>();
  const layoutAnimationFrameRef = useRef<number>();
  const layoutPlanCacheRef = useRef<{ key: string; kind: "layered" | "tidy"; plan: CanvasLayoutPlan }>();
  const currentViewportRef = useRef<WorkflowCanvasLayout["viewport"]>();
  const declarativeViewportKeyRef = useRef<string>();
  const wheelHandlerRef = useRef<(event: WheelEvent) => void>();
  const viewportPersistenceTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const wheelFrameRef = useRef<number>();
  const pendingWheelRef = useRef<{ delta: number; anchor: { x: number; y: number } }>();
  orchestrationRef.current = orchestration;
  const applyViewportDom = useCallback((nextViewport: WorkflowCanvasLayout["viewport"]) => {
    const viewportElement = viewportRef.current;
    if (viewportElement) {
      viewportElement.style.setProperty("--canvas-grid-x", `${nextViewport.x - 4 * nextViewport.zoom}px`);
      viewportElement.style.setProperty("--canvas-grid-y", `${nextViewport.y - 4 * nextViewport.zoom}px`);
      viewportElement.style.setProperty("--canvas-grid-size", `${18 * nextViewport.zoom}px`);
    }
    if (worldRef.current) {
      worldRef.current.style.transform = `translate3d(${nextViewport.x}px, ${nextViewport.y}px, 0) scale(${nextViewport.zoom})`;
    }
  }, []);
  const emitLayoutSnapshot = useCallback((snapshot: CanvasLayoutOperationSnapshot) => {
    const copy = structuredClone(snapshot);
    onLayoutSnapshot?.(copy);
    // Keep the same deterministic phase trace available to a real browser
    // audit. This is intentionally bounded and read-only; it never feeds the
    // editor state or persistence boundary.
    if (typeof window !== "undefined") {
      const trace = window.__openfarsCanvasLayoutSnapshots ?? [];
      trace.push(copy);
      window.__openfarsCanvasLayoutSnapshots = trace.slice(-120);
    }
  }, [onLayoutSnapshot]);

  // Text, runtime configuration and template-library edits do not alter the
  // rendered graph. Keep its model (and its routes) until geometry changes.
  const modelKey = JSON.stringify({
    agents: orchestration.agents.map((entry) => [entry.name, entry.template]),
    collaborations: orchestration.collaborations,
    input: orchestration.input,
    routes: orchestration.routes,
    loops: orchestration.loops,
    terminationAgent: orchestration.termination.agent,
    canvas: layoutPreview ?? orchestration.canvas
  });
  const model = useMemo(
    () => adaptWorkflowToCanvas(orchestration, layoutPreview ?? orchestration.canvas),
    [modelKey]
  );
  const activeMemberCollaboration = editingGroupMemberId
    ? (orchestration.collaborations ?? []).find((group) =>
        group.id === selectedId && group.memberAgentIds.includes(editingGroupMemberId)
      )
    : undefined;
  const selectedCanvasAgent = model.nodes.find((node) =>
    node.id === selectedId && node.kind === "agent" && !node.collaboration
  );
  const activeInspectorAgentId = activeMemberCollaboration
    ? editingGroupMemberId
    : selectedCanvasAgent?.name;
  const routeTopologyKey = useMemo(() => canvasRouteTopologyKey(model.edges), [model.edges]);
  const dragFrames = useCanvasPointerFrame(needsBackgroundRouting(model.edges, model.nodes));

  useEffect(() => {
    if (saveRevisionRef.current !== saveRevision) {
      saveRevisionRef.current = saveRevision;
      setNotice("");
    }
  }, [saveRevision]);
  useEffect(() => () => {
    if (connectionFailureTimerRef.current !== undefined) {
      clearTimeout(connectionFailureTimerRef.current);
    }
  }, []);
  const displayNodes = useMemo(() => model.nodes.map((node) => {
    const measured = nodeSizes[node.id];
    const positioned = measured ? { ...node, ...measured } : node;
    if (dragging?.id === node.id) return { ...positioned, x: dragging.x, y: dragging.y };
    if (pendingNodePosition?.id === node.id) {
      return { ...positioned, x: pendingNodePosition.x, y: pendingNodePosition.y };
    }
    return positioned;
  }), [dragging, model.nodes, nodeSizes, pendingNodePosition]);
  const routeNodeFrameKey = useMemo(() => canvasNodeFrameKey(displayNodes), [displayNodes]);
  const settledFrame = settledGeometryRef.current;
  const settledMatches = settledFrame?.topologyKey === routeTopologyKey && settledFrame.nodeFrameKey === routeNodeFrameKey;
  const routed = useCanvasRouting(model.edges, displayNodes, {
    enabled: !dragging && !layoutPreview && !(settledMatches && !settledFrame.provisional)
  });
  useEffect(() => {
    setPendingNodePosition((current) => {
      if (!current) return current;
      const persisted = model.nodes.find((node) => node.id === current.id);
      if (!persisted) return undefined;
      // The optimistic release position lives only while the controlled host
      // still exposes the pointer-down frame. Once the host acknowledges our
      // commit (or publishes any other position), its state is authoritative.
      if (persisted.x === current.originX && persisted.y === current.originY) return current;
      return undefined;
    });
  }, [model.nodes]);
  const liveGeometry = useMemo(() => {
    // During a drag, start from the pointer-down snapshot.  Routing the whole
    // graph here and then replacing most of it with the lock was the dominant
    // source of long tasks on every pointer sample.
    if (dragging && lockedGeometryRef.current?.length) {
      return buildLockedEdgeRoutesFromSnapshot(lockedGeometryRef.current, {
        nodes: displayNodes,
        draggedNodeId: dragging.id
      });
    }
    // A layout plan already owns canonical final curves. Elastic endpoint
    // updates are enough during interpolation and avoid a global route search
    // on every animation frame.
    const layoutRoutes = layoutRouteLockRef.current;
    if (layoutPreview && layoutRoutes?.topologyKey === routeTopologyKey && layoutRoutes.routes.length) {
      return buildLockedEdgeRoutesFromSnapshot(layoutRoutes.routes, { nodes: displayNodes, smoothFallback: true });
    }
    // Keep the exact release-frame route through the first persisted node
    // update as well.  Re-running the global obstacle solver synchronously on
    // pointer-up produced a multi-second hitch even though the drag lock had
    // already computed the visible geometry.
    const settled = settledGeometryRef.current;
    if (
      settled?.topologyKey === routeTopologyKey
      && settled.nodeFrameKey === routeNodeFrameKey
      && settled.routes.length
      && (!settled.provisional || routed.pending)
    ) {
      return geometryFromRouteLocks(settled.routes);
    }
    const cached = routeCacheRef.current;
    if (
      cached?.topologyKey === routeTopologyKey
      && cached.nodeFrameKey === routeNodeFrameKey
      && cached.routes.length
    ) {
      return geometryFromRouteLocks(cached.routes);
    }
    const addedGeometry = needsBackgroundRouting(model.edges, displayNodes) ? undefined : routeAddedNodeFromCache(cached, model.edges, displayNodes);
    if (addedGeometry) return addedGeometry;
    return routed.geometry;
  }, [displayNodes, dragging, layoutPreview, model.edges, routeNodeFrameKey, routeTopologyKey, routed.geometry, routed.pending]);
  const transitionGeometry = useMemo(() => {
    if (!layoutEdgeTransition) return undefined;
    return buildLockedEdgeRoutesFromSnapshot(layoutEdgeTransition.sourceRoutes, { nodes: displayNodes, smoothFallback: true });
  }, [displayNodes, layoutEdgeTransition]);
  // `liveGeometry` already selects the drag snapshot, settled snapshot, cache,
  // or full router. Keep this alias cheap so unrelated inspector/toolbar state
  // never causes another route-lock clone during render.
  const geometry = liveGeometry;
  useEffect(() => {
    if (dragging || layoutPreview || layoutBusyRef.current || routed.pending || !geometry.length) return;
    routeCacheRef.current = {
      topologyKey: routeTopologyKey,
      nodeFrameKey: routeNodeFrameKey,
      routes: captureRouteLock(geometry, displayNodes),
      nodes: displayNodes.map((node) => ({ ...node }))
    };
  }, [displayNodes, dragging, geometry, layoutPreview, routeNodeFrameKey, routeTopologyKey, routed.pending]);
  geometryInputsRef.current = {
    nodes: displayNodes,
    geometry,
    draggedNodeId: dragging?.id,
    previous: geometryInputsRef.current?.previous
  };
  const captureGeometryFrame = useCallback((
    phase: GeometryFramePhase,
    override?: {
      nodes: readonly CanvasNode[];
      geometry: readonly EdgeGeometry[];
      draggedNodeId?: string;
      resetPrevious?: boolean;
    }
  ): CanvasGeometryObservation => {
    const inputs = override ?? geometryInputsRef.current!;
    const observation = observeCanvasGeometryFrame({
      phase,
      nodes: inputs.nodes,
      geometry: inputs.geometry,
      draggedNodeId: inputs.draggedNodeId,
      previous: override?.resetPrevious ? undefined : geometryInputsRef.current?.previous
    });
    geometryInputsRef.current = { ...inputs, previous: observation };
    publishCanvasGeometryObservation(observation);
    setGeometryValid((current) => current === observation.valid ? current : observation.valid);
    onGeometryObservation?.(observation);
    return observation;
  }, [onGeometryObservation]);
  geometryCaptureRef.current = (phase) => captureGeometryFrame(phase);
  useEffect(() => {
    const capture = (phase: GeometryFramePhase) => geometryCaptureRef.current!(phase);
    if (typeof window !== "undefined") window.__openfarsCaptureCanvasGeometry = capture;
    // Percentage phases are named by the browser audit at the actual pointer
    // samples. Ordinary renders record a drag frame, never an invented 50%.
    // Full collision observations are an audit facility, not an animation
    // task. Hosts that request the audit still receive every rendered frame;
    // production canvases expose an on-demand capture without scanning all
    // edge samples against all cards on every pointer move.
    if (onGeometryObservation) capture(dragging ? "drag" : "release");
    return () => {
      if (typeof window !== "undefined" && window.__openfarsCaptureCanvasGeometry === capture) {
        delete window.__openfarsCaptureCanvasGeometry;
      }
    };
  }, [displayNodes, geometry, dragging, onGeometryObservation]);
  // Fit against the actual rendered cubic samples.  Using only router anchors
  // misses the curve between a bend and its control points and makes compact
  // previews either too loose or clipped at the ends.
  const routePoints = useMemo(() => geometry.flatMap((item) => item.samples), [geometry]);
  const contentBounds = useMemo(() => canvasContentBounds(displayNodes, routePoints), [displayNodes, routePoints]);
  const normalizedViewport = model.presentationLayout.viewport;
  const persistedIsMeaningful = Boolean(orchestration.canvas && (Math.abs(normalizedViewport.x) > 0.5 || Math.abs(normalizedViewport.y) > 0.5 || Math.abs(normalizedViewport.zoom - 0.82) > 0.005));
  const fitViewport = useMemo(() => compact
    ? fitCompactCanvasViewport({ width: Math.max(1, viewportSize.width), height: Math.max(1, viewportSize.height) }, contentBounds)
    : fitCanvasViewport({ width: Math.max(1, viewportSize.width), height: Math.max(1, viewportSize.height) }, contentBounds),
  [compact, contentBounds, viewportSize.height, viewportSize.width]);
  const viewport = compact
    ? fitViewport
    : viewportOverride ?? (persistedIsMeaningful ? normalizedViewport : (viewportSize.width > 0 && viewportSize.height > 0 ? fitViewport : normalizedViewport));
  const viewportKey = `${viewport.x}:${viewport.y}:${viewport.zoom}`;
  if (declarativeViewportKeyRef.current !== viewportKey) {
    declarativeViewportKeyRef.current = viewportKey;
    currentViewportRef.current = viewport;
  }
  useLayoutEffect(() => {
    applyViewportDom(currentViewportRef.current ?? viewport);
  }, [applyViewportDom, viewport.x, viewport.y, viewport.zoom]);
  const worldPoint = useCallback((clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return screenToCanvas({ x: clientX - rect.left, y: clientY - rect.top }, currentViewportRef.current ?? viewport);
  }, [viewport]);

  const onNodeResize = useCallback((nodeId: string, size: CanvasSize) => {
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) return;
    setNodeSizes((current) => {
      const previous = current[nodeId];
      if (previous && previous.width === size.width && previous.height === size.height) return current;
      return { ...current, [nodeId]: size };
    });
  }, []);

  useEffect(() => {
    const validIds = new Set(model.nodes.map((node) => node.id));
    setNodeSizes((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => validIds.has(id)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [model.nodes]);

  useEffect(() => {
    const key = JSON.stringify({ agents: orchestration.agents, input: orchestration.input, routes: orchestration.routes, loops: orchestration.loops, termination: orchestration.termination });
    if (semanticKeyRef.current !== undefined && semanticKeyRef.current !== key) setViewportOverride(undefined);
    semanticKeyRef.current = key;
    if (selectedId !== undefined && !model.nodes.some((node) => node.id === selectedId)) {
      setSelectedId(orchestration.input.target || "main");
    }
  }, [model.nodes, orchestration.agents, orchestration.input, orchestration.loops, orchestration.routes, orchestration.termination, selectedId]);

  useEffect(() => {
    const settled = settledGeometryRef.current;
    if (
      settled
      && (settled.topologyKey !== routeTopologyKey || settled.nodeFrameKey !== routeNodeFrameKey)
    ) {
      settledGeometryRef.current = undefined;
    }
  }, [routeNodeFrameKey, routeTopologyKey]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const update = () => setViewportSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [compact]);

  const pushHistory = useCallback(() => {
    setHistory((items) => [...items.slice(-29), { orchestration: structuredClone(orchestration), agents: structuredClone(agents), viewport: { ...viewport } }]);
    setRedoHistory([]);
  }, [agents, orchestration, viewport]);

  const syncMainRoutes = useCallback((next: AgentOrchestrationTemplate) => {
    syncMainOuterRoutes(next);
    // Runtime preferences are stored on AgentConfig, never on the canvas
    // presentation object. Main's values are normalized at the server boundary.
  }, []);

  const commit = useCallback((mutate: (next: AgentOrchestrationTemplate, nextAgents: AgentsConfig) => void, withHistory = true) => {
    if (effectiveReadOnly || layoutBusyRef.current) return false;
    const next = structuredClone(orchestration);
    const nextAgents = structuredClone(agents);
    mutate(next, nextAgents);
    syncMainRoutes(next);
    let createdLoopId: string | undefined;
    const removedLoops: string[] = [];
    const routesChanged = JSON.stringify(workerRoutes(orchestration)) !== JSON.stringify(workerRoutes(next));
    const loopsExplicitlyChanged = JSON.stringify(orchestration.loops ?? []) !== JSON.stringify(next.loops ?? []);
    if (routesChanged && !loopsExplicitlyChanged) {
      const oldEdges = new Set(workerStrongEdges(orchestration).map((edge) => `${edge.source}\0${edge.target}`));
      const addedEdges = workerStrongEdges(next).filter((edge) => !oldEdges.has(`${edge.source}\0${edge.target}`));
      let base = orchestration;
      for (const edge of [undefined, ...addedEdges]) {
        const result = reconcileLoopTopology(base, next, edge);
        if (result.error) {
          setNotice(`无法修改连接：${result.error}`);
          return false;
        }
        if (result.created) createdLoopId = result.created.id;
        removedLoops.push(...result.removed);
        base = { ...next, loops: result.loops };
      }
      next.canvas = normalizeCanvasLayout(next.canvas, next);
    }
    if (withHistory) pushHistory();
    onAgentsChange(nextAgents);
    onOrchestrationChange(next);
    setNotice(createdLoopId ? `Loop ${createdLoopId} 已自动创建，请在右侧设置参数`
      : removedLoops.length ? `Loop ${removedLoops.join("、")} 已随闭环断开而移除`
        : "有未保存修改");
    return true;
  }, [agents, effectiveReadOnly, onAgentsChange, onOrchestrationChange, orchestration, pushHistory, syncMainRoutes]);

  const commitLayout = useCallback((mutate: (layout: ReturnType<typeof normalizeCanvasLayout>) => void, withHistory = true) => {
    commit((next) => {
      const layout = normalizeCanvasLayout(next.canvas, next);
      mutate(layout);
      next.canvas = layout;
    }, withHistory);
  }, [commit]);

  const loopIssueAfter = useCallback((
    mutate: (candidate: AgentOrchestrationTemplate) => void
  ) => {
    if (!(orchestration.loops?.length)) return undefined;
    const candidate = structuredClone(orchestration);
    mutate(candidate);
    syncMainRoutes(candidate);
    return validateWorkflowLoops(candidate)[0];
  }, [orchestration, syncMainRoutes]);

  const showViewport = useCallback((nextViewport: WorkflowCanvasLayout["viewport"], render = true) => {
    if (layoutBusyRef.current) return;
    currentViewportRef.current = nextViewport;
    applyViewportDom(nextViewport);
    if (render) setViewportOverride(nextViewport);
  }, [applyViewportDom]);

  const commitViewport = useCallback((nextViewport: WorkflowCanvasLayout["viewport"]) => {
    showViewport(nextViewport);
    if (effectiveReadOnly) return;
    const current = orchestrationRef.current;
    const currentLayout = normalizeCanvasLayout(current.canvas, current);
    onOrchestrationChange(applyCanvasLayout(current, { ...currentLayout, viewport: nextViewport }));
    setNotice("有未保存修改");
  }, [effectiveReadOnly, onOrchestrationChange, showViewport]);

  const persistViewport = useCallback((nextViewport: WorkflowCanvasLayout["viewport"]) => {
    if (layoutBusyRef.current) return;
    if (viewportPersistenceTimerRef.current !== undefined) {
      clearTimeout(viewportPersistenceTimerRef.current);
      viewportPersistenceTimerRef.current = undefined;
    }
    commitViewport(nextViewport);
  }, [commitViewport]);

  const scheduleViewportPersistence = useCallback((nextViewport: WorkflowCanvasLayout["viewport"]) => {
    // Wheel gestures update the two transform layers imperatively.  React is
    // only asked to render once persistence is committed, so edge/node SVG
    // trees do not reconcile for every wheel tick.
    showViewport(nextViewport, false);
    if (effectiveReadOnly) return;
    if (viewportPersistenceTimerRef.current !== undefined) clearTimeout(viewportPersistenceTimerRef.current);
    viewportPersistenceTimerRef.current = setTimeout(() => {
      viewportPersistenceTimerRef.current = undefined;
      commitViewport(currentViewportRef.current ?? nextViewport);
    }, 180);
  }, [commitViewport, effectiveReadOnly, showViewport]);

  const targetAtPoint = useCallback((point: { x: number; y: number }): Connection | undefined => {
    let best: { id: string; port: WorkflowCanvasPort; distance: number; edgeDistance: number } | undefined;
    for (const node of displayNodes) {
      const { width, height } = canvasNodeSize(node);
      const inside = point.x >= node.x && point.x <= node.x + width && point.y >= node.y && point.y <= node.y + height;
      const within = point.x >= node.x - 30 && point.x <= node.x + width + 30 && point.y >= node.y - 30 && point.y <= node.y + height + 30;
      if (!within) continue;
      const edgeDistances = {
        top: Math.abs(point.y - node.y),
        right: Math.abs(point.x - (node.x + width)),
        bottom: Math.abs(point.y - (node.y + height)),
        left: Math.abs(point.x - node.x)
      } satisfies Record<WorkflowCanvasPort, number>;
      const nearestSide = PORTS.reduce((current, port) => edgeDistances[port] < edgeDistances[current] ? port : current, "top" as WorkflowCanvasPort);
      for (const port of PORTS) {
        const anchor = canvasPortPoint(node, port);
        const distance = Math.hypot(point.x - anchor.x, point.y - anchor.y);
        const edgeDistance = edgeDistances[port]!;
        const candidate = inside && distance > 46
          ? { id: node.id, port: nearestSide, distance: edgeDistances[nearestSide]!, edgeDistance: edgeDistances[nearestSide]! }
          : { id: node.id, port, distance, edgeDistance };
        if (!best || candidate.distance < best.distance || (candidate.distance === best.distance && candidate.edgeDistance < best.edgeDistance)) {
          best = candidate;
        }
      }
    }
    if (!best || best.distance > 46) return undefined;
    const active = connectionRef.current;
    if (active && best.id === active.id && best.port === active.port) return undefined;
    return { id: best.id, port: best.port };
  }, [displayNodes]);

  const collaborationEdgeLocked = useCallback((source: string, target: string) => (
    lockedGroupIds.has(source) || lockedGroupIds.has(target)
  ), [lockedGroupIds]);
  const collaborationLockedNotice = collaborationLockReason
    ?? "协作组运行中，完成最终 PR 事实核对前不能修改其入边或出边";

  const connectionError = useCallback((from: Connection, to: Connection, requestedKind = newEdgeKind): string | undefined => {
    if (from.id === to.id) return "出边不能指向自身";
    if (to.id === CANVAS_INPUT_NODE_ID) return "输入节点只能作为连线起点";
    if (from.id === CANVAS_FINISH_NODE_ID) return "结束节点不能作为连线起点";
    if (from.id === "main" && to.id !== CANVAS_FINISH_NODE_ID) return "Main 的出边由 Agent 列表派生，不能直接修改";
    if (from.id === CANVAS_INPUT_NODE_ID && to.id === CANVAS_FINISH_NODE_ID) return "输入节点不能直接连接结束节点";
    const target = to.id === CANVAS_FINISH_NODE_ID ? "finish" : to.id;
    if (collaborationEdgeLocked(from.id, target)) return collaborationLockedNotice;
    const existing = orchestration.routes[from.id] ?? [];
    // Once the visual termination edge has been removed, the next valid
    // Agent may become the termination owner.  The semantic `termination`
    // field still has its previous value while the edge is disconnected, so
    // checking only that value would make the canvas impossible to repair
    // unless the user first used the End inspector selector.  Treat a
    // disconnected finish edge as a replacement gesture and let the normal
    // strong-edge guard below decide whether the candidate is legal.
    const reconnectingTermination = target === "finish"
      && model.presentationLayout.connections?.termination === false;
    if (existing.some((edge) => edge.target === target) && !reconnectingTermination) return "该 Agent 已存在相同目标的出边";
    if (target !== "finish" && requestedKind === "strong" && existing.length) return "强边必须是该 Agent 的唯一出边";
    if (target !== "finish" && existing.some((edge) => edge.kind === "strong")) return "该 Agent 已有强边，不能再添加弱边";
    if (target === "finish" && !reconnectingTermination && from.id !== orchestration.termination.agent) return "只有指定的终止外层节点可以连接结束节点";
    if (target === "finish" && existing.some((edge) => edge.kind === "strong")) return "终止外层节点的 finish 出边不能与强边混用";
    return undefined;
  }, [collaborationEdgeLocked, collaborationLockedNotice, model.presentationLayout.connections?.termination, newEdgeKind, orchestration]);

  const clearConnection = useCallback(() => {
    connectionRef.current = undefined;
    connectionTargetRef.current = undefined;
    connectionGestureRef.current = undefined;
    setConnectionSource(undefined);
    setConnectionTarget(undefined);
    setLinkPreview(undefined);
    setInvalidConnection(false);
  }, []);

  const clearConnectionFailure = useCallback(() => {
    if (connectionFailureTimerRef.current !== undefined) {
      clearTimeout(connectionFailureTimerRef.current);
      connectionFailureTimerRef.current = undefined;
    }
    setConnectionFailure(undefined);
  }, []);

  const showConnectionFailure = useCallback((nodeId: string) => {
    if (connectionFailureTimerRef.current !== undefined) {
      clearTimeout(connectionFailureTimerRef.current);
    }
    const pulse = ++connectionFailurePulseRef.current;
    setConnectionFailure({ nodeId, pulse });
    connectionFailureTimerRef.current = setTimeout(() => {
      connectionFailureTimerRef.current = undefined;
      setConnectionFailure((current) => current?.pulse === pulse ? undefined : current);
    }, 650);
  }, []);

  const cancelActiveGestures = useCallback(() => {
    dragFrames.cancel();
    if (dragRef.current) {
      if (onGeometryObservation) geometryCaptureRef.current?.("cancel");
      // Cancellation returns the card to the controlled model. Never retain
      // an absolute path captured for the transient dragged position.
      settledGeometryRef.current = undefined;
    }
    clearConnection();
    setDragging(undefined);
    dragRef.current = undefined;
    lockedGeometryRef.current = undefined;
    panRef.current = undefined;
    setPan(undefined);
    setGuides({});
    setHoveredNodeId(undefined);
  }, [clearConnection, dragFrames.cancel, onGeometryObservation]);

  const cancelLayout = useCallback(() => {
    if (!layoutBusyRef.current) return;
    const operationId = layoutOperationRef.current;
    const signature = workflowCanvasSignature(orchestrationRef.current);
    layoutOperationRef.current += 1;
    // Keep an already-scheduled frame alive for one tick. It observes the
    // incremented operation id and resolves the animation promise without
    // publishing another preview frame. Cancelling the callback itself would
    // leave the awaiting layout command permanently unresolved.
    layoutBusyRef.current = false;
    layoutRouteLockRef.current = undefined;
    setLayoutPreview(undefined);
    setLayoutEdgeTransition(undefined);
    setViewportOverride(layoutViewportBeforeRef.current?.viewport);
    setLayoutBusy(false);
    setLayoutPhase("idle");
    setLayoutMessage("布局调整已取消");
    setNotice("布局调整已取消");
    emitLayoutSnapshot({ operationId, signature, operation: layoutKindRef.current, phase: "cancelled" });
  }, [emitLayoutSnapshot]);

  const attemptConnection = useCallback((from: Connection, to: Connection, requestedKind = newEdgeKind): boolean => {
    const error = connectionError(from, to, requestedKind);
    if (error) {
      setNotice(error);
      showConnectionFailure(to.id);
      return false;
    }
    clearConnectionFailure();
    const target = to.id === CANVAS_FINISH_NODE_ID ? "finish" : to.id;
    const currentRoutes = orchestration.routes[from.id] ?? [];
    const existingFinishIndex = target === "finish"
      ? currentRoutes.findIndex((route) => route.target === "finish")
      : -1;
    const nextEdgeIndex = from.id === CANVAS_INPUT_NODE_ID
      ? 0
      : target === "finish"
        ? from.id === "main"
          ? 0
          : currentRoutes.filter((route) => route.target !== "finish").length
        : existingFinishIndex >= 0 ? existingFinishIndex : currentRoutes.length;
    const committed = commit((next) => {
      const layout = normalizeCanvasLayout(next.canvas, next);
      if (from.id === CANVAS_INPUT_NODE_ID) {
        const oldTarget = next.input.target;
        next.input.target = target;
        const oldKey = canvasEdgeId(CANVAS_INPUT_NODE_ID, oldTarget);
        const newKey = canvasEdgeId(CANVAS_INPUT_NODE_ID, target);
        if (oldKey !== newKey) delete layout.edges[oldKey];
        layout.edges[newKey] = { sourcePort: from.port, targetPort: to.port, sourcePortPinned: true, targetPortPinned: true };
        setCanvasConnection(layout, "input", true);
      } else if (target === "finish") {
        // A finish edge is a single workflow-level termination choice.  A
        // reconnect therefore replaces any stale finish route (including a
        // route owned by the previous termination Agent) before assigning the
        // new owner.  Main is special: its fan-out is derived by
        // `syncMainRoutes`, so its termination edge is presentation-only.
        for (const definition of next.agents) {
          next.routes[definition.name] = (next.routes[definition.name] ?? [])
            .filter((route) => route.target !== "finish");
        }
        next.termination.agent = from.id;
        const routes = [...(next.routes[from.id] ?? [])];
        let index = -1;
        if (from.id !== "main") {
          routes.push({ target: "finish", kind: "weak" });
          index = routes.length - 1;
          next.routes[from.id] = routes;
        }
        // Remove all old finish geometry before installing the replacement;
        // otherwise a stale edge can survive normalization under a different
        // route index.
        for (const id of Object.keys(layout.edges)) {
          if (id.includes(`->${CANVAS_FINISH_NODE_ID}:`)) delete layout.edges[id];
        }
        setCanvasConnection(layout, "termination", true);
        layout.edges[canvasEdgeId(from.id, CANVAS_FINISH_NODE_ID, Math.max(0, index))] = {
          sourcePort: from.port,
          targetPort: to.port,
          sourcePortPinned: true,
          targetPortPinned: true
        };
      } else {
        const routes = [...(next.routes[from.id] ?? [])];
        routes.push({ target, kind: target === "finish" ? "weak" : requestedKind });
        next.routes[from.id] = routes;
        layout.edges[canvasEdgeId(from.id, target, routes.length - 1)] = { sourcePort: from.port, targetPort: to.port, sourcePortPinned: true, targetPortPinned: true };
      }
      next.canvas = layout;
    });
    if (!committed) return false;
    setSelectedEdgeId(canvasEdgeId(from.id, target, nextEdgeIndex));
    setSelectedId(undefined);
    return true;
  }, [clearConnectionFailure, commit, connectionError, newEdgeKind, orchestration.routes, showConnectionFailure]);

  const addConnectionFromInspector = useCallback((sourceId: string, targetId: string, requestedKind: "strong" | "weak") => {
    const sourceNode = model.nodes.find((node) => node.id === sourceId);
    const targetNode = model.nodes.find((node) => node.id === targetId);
    if (!sourceNode || !targetNode) return;
    const sourcePort = relativePort(sourceNode, targetNode, "right");
    const targetPort = relativePort(targetNode, sourceNode, "left");
    attemptConnection(
      { id: sourceId, port: sourcePort },
      { id: targetId, port: targetPort },
      requestedKind
    );
  }, [attemptConnection, model.nodes]);

  const onPortPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, node: CanvasNode, port: WorkflowCanvasPort) => {
    if (effectiveReadOnly || layoutBusyRef.current || event.button !== 0) return;
    if (dragRef.current || panRef.current || (connectionGestureRef.current && connectionGestureRef.current.pointerId !== event.pointerId)) return;
    event.preventDefault();
    event.stopPropagation();
    if (connectionRef.current) {
      const to = { id: node.id, port };
      if (attemptConnection(connectionRef.current, to)) clearConnection();
      return;
    }
    if (lockedGroupIds.has(node.id)) {
      setNotice(collaborationLockedNotice);
      showConnectionFailure(node.id);
      return;
    }
    if (node.kind === "finish") {
      setNotice("结束节点不能作为连线起点");
      return;
    }
    if (node.id === "main" && model.presentationLayout.connections?.termination !== false) {
      setNotice("Main 的出边由 Agent 列表派生，不能直接修改");
      return;
    }
    clearConnectionFailure();
    const from = { id: node.id, port };
    connectionRef.current = from;
    connectionGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false
    };
    setConnectionSource(from);
    setLinkPreview(worldPoint(event.clientX, event.clientY));
    setNotice("拖动到目标端口后释放，空白处释放可取消");
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* jsdom */ }
  };

  const onNodePointerDown = (event: ReactPointerEvent<HTMLElement>, node: CanvasNode) => {
    dragRoutingPendingRef.current = routed.pending;
    if (effectiveReadOnly || layoutBusy || event.button !== 0) return;
    if (dragRef.current || panRef.current || (connectionGestureRef.current && connectionGestureRef.current.pointerId !== event.pointerId)) return;
    if (connectionRef.current) {
      event.preventDefault();
      event.stopPropagation();
      const target = targetAtPoint(worldPoint(event.clientX, event.clientY));
      if (target) {
        attemptConnection(connectionRef.current, target);
        clearConnection();
      }
      return;
    }
    const touchesLockedGroupEdge = model.edges.some((edge) =>
      (edge.source === node.id || edge.target === node.id)
      && collaborationEdgeLocked(edge.source, edge.target)
    );
    if (lockedGroupIds.has(node.id) || touchesLockedGroupEdge) {
      event.stopPropagation();
      setNotice(collaborationLockedNotice);
      showConnectionFailure(node.id);
      return;
    }
    event.stopPropagation();
    setSelectedId(node.id);
    setSelectedEdgeId(undefined);
    const initialDrag: DragState = { id: node.id, x: node.x, y: node.y, originX: node.x, originY: node.y };
    dragRef.current = {
      ...initialDrag,
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      zoom: Math.max(.08, (currentViewportRef.current ?? viewport).zoom)
    };
    // Capture the exact pointer-down geometry before React moves the node into
    // its temporary drag position. This gives audits a true start frame and a
    // clean baseline for unrelated-route stability checks.
    geometryInputsRef.current = {
      nodes: displayNodes,
      geometry,
      draggedNodeId: node.id,
      previous: undefined
    };
    if (onGeometryObservation) geometryCaptureRef.current?.("start");
    // The initial fit viewport is derived from live content bounds. Freeze it
    // before the first drag render so moving a card (and its temporary detour
    // curves) cannot continuously change zoom/pan underneath the pointer.
    // This also keeps screen-space snapping deterministic for the gesture.
    setViewportOverride(viewport);
    setDragging(initialDrag);
    const dragLock = captureRouteLock(geometry, displayNodes);
    lockedGeometryRef.current = dragLock;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* jsdom */ }
  };

  const snapNode = useCallback((id: string, x: number, y: number) => {
    const threshold = 7 / Math.max(.08, viewport.zoom);
    let bestX = { value: x, distance: Number.POSITIVE_INFINITY, guide: undefined as number | undefined };
    let bestY = { value: y, distance: Number.POSITIVE_INFINITY, guide: undefined as number | undefined };
    const moving = displayNodes.find((node) => node.id === id);
    const movingSize = moving ? canvasNodeSize(moving) : canvasNodeSize({});
    for (const other of displayNodes) {
      if (other.id === id) continue;
      const otherSize = canvasNodeSize(other);
      const xCandidates = [
        other.x,
        other.x + otherSize.width / 2 - movingSize.width / 2,
        other.x + otherSize.width - movingSize.width
      ];
      const yCandidates = [
        other.y,
        other.y + otherSize.height / 2 - movingSize.height / 2,
        other.y + otherSize.height - movingSize.height
      ];
      for (const candidate of xCandidates) if (Math.abs(candidate - x) <= threshold && Math.abs(candidate - x) < bestX.distance) bestX = { value: candidate, distance: Math.abs(candidate - x), guide: candidate };
      for (const candidate of yCandidates) if (Math.abs(candidate - y) <= threshold && Math.abs(candidate - y) < bestY.distance) bestY = { value: candidate, distance: Math.abs(candidate - y), guide: candidate };
    }
    return { x: bestX.value, y: bestY.value, guides: { vertical: bestX.guide !== undefined ? canvasToScreen({ x: bestX.guide, y: 0 }, viewport).x : undefined, horizontal: bestY.guide !== undefined ? canvasToScreen({ x: 0, y: bestY.guide }, viewport).y : undefined } };
  }, [displayNodes, viewport]);

  const dragPositionAt = useCallback((active: ActiveDragState, clientX: number, clientY: number) => {
    const dx = clientX - active.pointerX;
    const dy = clientY - active.pointerY;
    // A plain click must not opportunistically snap a node that was already
    // close to a guide. Once the pointer has moved, the release sample is the
    // source of truth even when the browser coalesced the last pointermove.
    if (dx === 0 && dy === 0) {
      return { x: active.originX, y: active.originY, guides: {} as GuideState };
    }
    return snapNode(
      active.id,
      active.originX + dx / active.zoom,
      active.originY + dy / active.zoom
    );
  }, [snapNode]);

  const finalizeActiveDrag = useCallback((
    pointerId?: number,
    releasePoint?: { clientX: number; clientY: number }
  ): boolean => {
    const active = dragRef.current;
    if (!active || (pointerId !== undefined && active.pointerId !== pointerId)) return false;

    // Clear the authoritative ref first. Pointerup and lostpointercapture can
    // arrive back-to-back; only the first event may commit this gesture.
    dragFrames.cancel();
    dragRef.current = undefined;
    const finalPosition = releasePoint
      ? dragPositionAt(active, releasePoint.clientX, releasePoint.clientY)
      : { x: active.x, y: active.y, guides: {} as GuideState };
    const result: DragState = {
      id: active.id,
      x: finalPosition.x,
      y: finalPosition.y,
      originX: active.originX,
      originY: active.originY
    };
    const releaseNodes = displayNodes.map((node) => node.id === result.id
      ? { ...node, x: result.x, y: result.y }
      : node);
    const dragLock = lockedGeometryRef.current;
    const releaseGeometry = dragLock?.length
      ? buildLockedEdgeRoutesFromSnapshot(dragLock, {
          nodes: releaseNodes,
          draggedNodeId: result.id
        })
      : geometry;

    settledGeometryRef.current = {
      topologyKey: routeTopologyKey,
      nodeFrameKey: canvasNodeFrameKey(releaseNodes),
      routes: captureRouteLock(releaseGeometry, releaseNodes),
      provisional: dragRoutingPendingRef.current
    };
    geometryInputsRef.current = {
      nodes: releaseNodes,
      geometry: releaseGeometry,
      draggedNodeId: result.id,
      previous: geometryInputsRef.current?.previous
    };
    // Keep the release frame visible until a controlled host publishes the
    // persisted position. This closes the one-render snap-back window that
    // otherwise makes a fast release appear to have failed.
    const moved = result.x !== result.originX || result.y !== result.originY;
    setPendingNodePosition(moved ? result : undefined);
    if (onGeometryObservation) geometryCaptureRef.current?.("release");
    setDragging(undefined);
    lockedGeometryRef.current = undefined;
    setGuides({});
    if (moved) {
      commitLayout((layout) => {
        layout.nodes[result.id] = { x: result.x, y: result.y };
      });
    }
    return true;
  }, [commitLayout, displayNodes, dragPositionAt, geometry, routeTopologyKey, dragFrames.cancel, onGeometryObservation]);

  const onWorldPointerMove = (event: CanvasPointerSample) => {
    if (connectionRef.current) {
      const gesture = connectionGestureRef.current;
      if (gesture && gesture.pointerId !== event.pointerId) return;
      if (gesture && gesture.pointerId === event.pointerId) {
        gesture.moved = gesture.moved || Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 3;
      }
      const point = worldPoint(event.clientX, event.clientY);
      const target = targetAtPoint(point);
      connectionTargetRef.current = target;
      setConnectionTarget(target);
      setLinkPreview(point);
      setInvalidConnection(Boolean(target && connectionError(connectionRef.current, target)));
      event.preventDefault();
      return;
    }
    const activeDrag = dragRef.current;
    if (activeDrag) {
      if (activeDrag.pointerId !== event.pointerId) return;
      const next = dragPositionAt(activeDrag, event.clientX, event.clientY);
      activeDrag.x = next.x;
      activeDrag.y = next.y;
      const nextDrag = {
        id: activeDrag.id,
        x: next.x,
        y: next.y,
        originX: activeDrag.originX,
        originY: activeDrag.originY
      };
      dragFrames.schedule(() => {
        setGuides(next.guides);
        setDragging(nextDrag);
      });
      event.preventDefault();
      return;
    }
    if (panRef.current) {
      const current = panRef.current;
      if (current.pointerId !== event.pointerId) return;
      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;
      const next = { ...current, currentX: current.originX + dx, currentY: current.originY + dy, moved: current.moved || Math.hypot(dx, dy) > 3 };
      panRef.current = next;
      applyViewportDom({ x: next.currentX, y: next.currentY, zoom: currentViewportRef.current?.zoom ?? viewport.zoom });
      // The visual transform is imperative; only publish the class-state
      // transition once when the gesture first becomes a real pan.
      if (!current.moved && next.moved) setPan({ ...next });
    }
  };

  const finishGesture = (event: CanvasPointerSample) => {
    const activePointerId = dragRef.current?.pointerId ?? connectionGestureRef.current?.pointerId ?? panRef.current?.pointerId;
    if (activePointerId !== undefined && activePointerId !== event.pointerId) return;
    if (event.type === "pointercancel") {
      cancelActiveGestures();
      return;
    }
    if (connectionRef.current) {
      const from = connectionRef.current;
      const target = connectionTargetRef.current ?? targetAtPoint(worldPoint(event.clientX, event.clientY));
      const gesture = connectionGestureRef.current;
      const moved = gesture?.moved ?? true;
      if (target) {
        attemptConnection(from, target);
        clearConnection();
      } else if (!moved) {
        connectionGestureRef.current = undefined;
        setLinkPreview(worldPoint(event.clientX, event.clientY));
      } else {
        setNotice("连线已取消");
        clearConnection();
      }
      return;
    }
    const activeDrag = dragRef.current;
    if (activeDrag?.pointerId === event.pointerId) {
      finalizeActiveDrag(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY
      });
      return;
    }
    const current = panRef.current;
    if (current && current.pointerId === event.pointerId) {
      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;
      panRef.current = undefined;
      setPan(undefined);
      if (current.moved) persistViewport({ x: current.originX + dx, y: current.originY + dy, zoom: currentViewportRef.current?.zoom ?? viewport.zoom });
      else if (event.type !== "pointercancel") {
        // A stationary pointerup on genuine whitespace is a selection-clear
        // gesture.  beginPan() already excludes nodes, edges, ports and
        // controls, while a moved gesture remains a pure viewport pan.
        setSelectedId(undefined);
        setSelectedEdgeId(undefined);
      }
    }
  };

  pointerHandlersRef.current = { move: onWorldPointerMove, finish: finishGesture };
  useEffect(() => {
    // Captured events bubble through CanvasWorld. Forward only outside events
    // when capture is unavailable, so one pointer sample is handled once.
    const outside = (event: PointerEvent) => !(event.target instanceof Node && viewportRef.current?.contains(event.target));
    const move = (event: PointerEvent) => { if (outside(event)) pointerHandlersRef.current?.move(event); };
    const finish = (event: PointerEvent) => { if (outside(event)) pointerHandlersRef.current?.finish(event); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, []);

  const onLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    // A normal pointerup clears the active pointer refs before the browser
    // emits lostpointercapture.  If a ref is still present, capture was lost
    // unexpectedly and the transient gesture must not survive.  Click-mode
    // connections deliberately clear connectionGestureRef on pointerup, so
    // they remain active for the subsequent target click.
    if (dragRef.current?.pointerId === event.pointerId) {
      // Capture loss is a browser lifecycle boundary, not a user cancellation.
      // Commit the last processed pointermove so a quick release cannot throw
      // away an otherwise valid drag.
      finalizeActiveDrag(event.pointerId);
      return;
    }
    const activePointerId = connectionGestureRef.current?.pointerId ?? panRef.current?.pointerId;
    if (activePointerId !== undefined && activePointerId === event.pointerId) {
      cancelActiveGestures();
    }
  };

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (effectiveReadOnly || layoutBusy || event.button !== 0 || connectionRef.current || dragging) return;
    const target = event.target as HTMLElement;
    if (target.closest(".agent-node, .workflow-edge-group, .edge-hit, .node-port")) return;
    event.preventDefault();
    const currentViewport = currentViewportRef.current ?? viewport;
    const state: PanState = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: currentViewport.x, originY: currentViewport.y, currentX: currentViewport.x, currentY: currentViewport.y, moved: false };
    panRef.current = state;
    setPan(state);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* jsdom */ }
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || effectiveReadOnly || layoutBusyRef.current || dragRef.current) return;
    const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(1, rect.height) : 1;
    const delta = Math.max(-240, Math.min(240, event.deltaY * scale));
    const pending = pendingWheelRef.current;
    pendingWheelRef.current = { delta: (pending?.delta ?? 0) + delta, anchor };
    if (wheelFrameRef.current !== undefined) return;
    const update = () => {
      wheelFrameRef.current = undefined;
      const gesture = pendingWheelRef.current;
      pendingWheelRef.current = undefined;
      if (!gesture || layoutBusyRef.current) return;
      const current = currentViewportRef.current ?? viewport;
      const next = zoomCanvasViewportAt(
        current,
        gesture.anchor,
        current.zoom * Math.exp(-gesture.delta * .0015)
      );
      scheduleViewportPersistence(next);
    };
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      wheelFrameRef.current = window.requestAnimationFrame(update);
    } else {
      update();
    }
  };
  wheelHandlerRef.current = onWheel;
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const handler = (event: WheelEvent) => wheelHandlerRef.current?.(event);
    element.addEventListener("wheel", handler, { passive: false });
    return () => element.removeEventListener("wheel", handler);
  }, []);

  const removeEdge = (edgeId: string) => {
    const edge = model.edges.find((item) => item.id === edgeId);
    if (!edge || effectiveReadOnly) return;
    if (edge.fixed) { setNotice("Main 固定调度边由系统维护，不能删除"); return; }
    if (collaborationEdgeLocked(edge.source, edge.target)) {
      setNotice(collaborationLockedNotice);
      return;
    }
    if (edge.source === CANVAS_INPUT_NODE_ID) {
      commitLayout((layout) => {
        setCanvasConnection(layout, "input", false);
        delete layout.edges[edge.id];
      });
      setSelectedEdgeId(undefined);
      setNotice("输入连接已删除，可使用撤销恢复");
      return;
    }
    if (edge.target === CANVAS_FINISH_NODE_ID) {
      commitLayout((layout) => {
        setCanvasConnection(layout, "termination", false);
        for (const id of Object.keys(layout.edges)) {
          if (id.includes(`->${CANVAS_FINISH_NODE_ID}:`)) delete layout.edges[id];
        }
      });
      setSelectedEdgeId(undefined);
      setNotice("结束连接已删除，可使用撤销恢复");
      return;
    }
    commit((next) => {
      const routes = [...(next.routes[edge.source] ?? [])];
      const index = routeIndex(edgeId, edge.source, edge.target, routes);
      if (index < 0) return;
      next.routes[edge.source] = routes.filter((_, item) => item !== index);
      next.canvas = normalizeCanvasLayout(next.canvas, next);
    });
    setSelectedEdgeId(undefined);
  };

  const updateEdgeKind = (edgeId: string, kind: WorkflowEdge["kind"]) => {
    const edge = model.edges.find((item) => item.id === edgeId);
    if (!edge || edge.fixed || edge.target === CANVAS_FINISH_NODE_ID || effectiveReadOnly) return;
    if (collaborationEdgeLocked(edge.source, edge.target)) {
      setNotice(collaborationLockedNotice);
      return;
    }
    commit((next) => {
      const routes = [...(next.routes[edge.source] ?? [])];
      const index = routeIndex(edgeId, edge.source, edge.target, routes);
      if (index < 0) return;
      next.routes[edge.source] = kind === "strong" ? [{ target: edge.target, kind }] : routes.map((item, i) => i === index ? { ...item, kind } : item);
    });
  };

  const updateEdgeTarget = (edgeId: string, targetValue: string) => {
    const inspectorAdd = /^__canvas_add__(strong|weak)__(.+)$/.exec(targetValue);
    if (inspectorAdd) {
      addConnectionFromInspector(edgeId, inspectorAdd[2]!, inspectorAdd[1] as "strong" | "weak");
      return;
    }
    const edge = model.edges.find((item) => item.id === edgeId);
    if (!edge || edge.fixed || edge.source === CANVAS_INPUT_NODE_ID || effectiveReadOnly) return;
    const target = targetValue === CANVAS_FINISH_NODE_ID ? "finish" : targetValue;
    if (collaborationEdgeLocked(edge.source, edge.target) || collaborationEdgeLocked(edge.source, target)) {
      setNotice(collaborationLockedNotice);
      return;
    }
    if (target === edge.source || target === CANVAS_INPUT_NODE_ID) return;
    if (target === "finish" && edge.source !== orchestration.termination.agent) { setNotice("只有指定的终止 Agent 可以连接结束节点"); return; }
    const currentRoutes = orchestration.routes[edge.source] ?? [];
    const selectedIndex = routeIndex(edgeId, edge.source, edge.target, currentRoutes);
    if (selectedIndex < 0 || currentRoutes.some((item, index) => index !== selectedIndex && item.target === target)) return;
    const committed = commit((next) => {
      const routes = [...(next.routes[edge.source] ?? [])];
      const index = routeIndex(edgeId, edge.source, edge.target, routes);
      const old = routes[index]!;
      routes[index] = { ...old, target, kind: target === "finish" ? "weak" : old.kind };
      next.routes[edge.source] = routes;
      next.canvas = normalizeCanvasLayout(next.canvas, next);
    });
    if (committed) {
      setSelectedEdgeId(canvasEdgeId(edge.source, target, selectedIndex));
      setSelectedId(undefined);
    }
  };

  const updateEdgeLayout = (edgeId: string, patch: Partial<WorkflowCanvasEdgeLayout>) => {
    const edge = model.edges.find((item) => item.id === edgeId);
    if (effectiveReadOnly || edge?.fixed) return;
    if (edge && collaborationEdgeLocked(edge.source, edge.target)) {
      setNotice(collaborationLockedNotice);
      return;
    }
    commitLayout((layout) => { const edge = layout.edges[edgeId]; if (edge) layout.edges[edgeId] = { ...edge, ...patch }; });
  };

  const updateLoop = (loopId: string, patch: Partial<WorkflowLoop>) => {
    if (effectiveReadOnly) return;
    const candidate = structuredClone(orchestration);
    const index = candidate.loops?.findIndex((loop) => loop.id === loopId) ?? -1;
    if (index < 0 || !candidate.loops) return;
    candidate.loops[index] = { ...candidate.loops[index]!, ...patch };
    const issue = validateWorkflowLoops(candidate)[0];
    if (issue) {
      setNotice(`Loop 修改被拒绝：${issue.message}`);
      return;
    }
    commit((next) => {
      next.loops = next.loops?.map((loop) => loop.id === loopId ? { ...loop, ...patch } : loop);
    });
    setNotice(`Loop ${candidate.loops[index]!.id} 已更新`);
  };

  const updateInputTarget = (target: string) => {
    if (effectiveReadOnly) return;
    if (lockedGroupIds.has(orchestration.input.target) || lockedGroupIds.has(target)) {
      setNotice(collaborationLockedNotice);
      return;
    }
    if (!target) {
      commitLayout((layout) => {
        setCanvasConnection(layout, "input", false);
        delete layout.edges[canvasEdgeId(CANVAS_INPUT_NODE_ID, orchestration.input.target)];
      });
      setNotice("用户输入连接已移除");
      return;
    }
    if (!workflowOuterNodeIds(orchestration).includes(target)) return;
    commit((next) => {
      const layout = normalizeCanvasLayout(next.canvas, next);
      setCanvasConnection(layout, "input", true);
      next.input.target = target;
      next.canvas = normalizeCanvasLayout(layout, next);
    });
    setNotice(`用户输入将首先交给 ${target}`);
  };

  const updateTerminationAgent = (target: string) => {
    if (effectiveReadOnly) return;
    if (lockedGroupIds.has(orchestration.termination.agent) || lockedGroupIds.has(target)) {
      setNotice(collaborationLockedNotice);
      return;
    }
    if (!target) {
      commitLayout((layout) => {
        setCanvasConnection(layout, "termination", false);
        for (const id of Object.keys(layout.edges)) {
          if (id.includes(`->${CANVAS_FINISH_NODE_ID}:`)) delete layout.edges[id];
        }
      });
      setNotice("终止外层节点已移除");
      return;
    }
    if (!workflowOuterNodeIds(orchestration).includes(target)) return;
    if ((orchestration.routes[target] ?? []).some((edge) => edge.kind === "strong")) {
      setNotice("已有强出边的外层节点不能连接结束节点");
      return;
    }
    const loopIssue = loopIssueAfter((candidate) => {
      for (const definition of candidate.agents) candidate.routes[definition.name] = (candidate.routes[definition.name] ?? []).filter((edge) => edge.target !== "finish");
      candidate.termination.agent = target;
      if (target !== "main") candidate.routes[target] = [...(candidate.routes[target] ?? []), { target: "finish", kind: "weak" }];
    });
    if (loopIssue) {
      setNotice(`该 Agent 是 Loop ${loopIssue.loopId} 的边界，不能同时作为终止 Agent`);
      return;
    }
    commit((next) => {
      const layout = normalizeCanvasLayout(next.canvas, next);
      for (const nodeId of workflowOuterNodeIds(next)) next.routes[nodeId] = (next.routes[nodeId] ?? []).filter((edge) => edge.target !== "finish");
      next.termination.agent = target;
      if (target !== "main") next.routes[target] = [...(next.routes[target] ?? []), { target: "finish", kind: "weak" }];
      setCanvasConnection(layout, "termination", true);
      next.canvas = normalizeCanvasLayout(layout, next);
    });
    setNotice(`终止外层节点已设置为 ${target}`);
  };

  const agentIdentityLockedByGroup = (agentId: string): boolean => {
    if ((orchestration.collaborations ?? []).some((group) =>
      lockedGroupIds.has(group.id) && group.memberAgentIds.includes(agentId))) return true;
    const scopes = orchestration.scopedWorkflow?.groups ?? [];
    return scopes.some((group) => {
      if (group.leaderAgentId !== agentId && !group.workflow.nodes.some((ref) => ref.kind === "agent" && ref.agentId === agentId)) return false;
      const visited = new Set<string>();
      let current: typeof group | undefined = group;
      while (current && !visited.has(current.id)) {
        if (lockedGroupIds.has(current.id)) return true;
        visited.add(current.id);
        current = current.parentGroupId ? scopes.find((entry) => entry.id === current!.parentGroupId) : undefined;
      }
      return false;
    });
  };

  const updateAgentPatch = (patch: Partial<AgentConfig>, agentId = activeInspectorAgentId) => {
    if (!agentId || effectiveReadOnly || !orchestration.agents.some((entry) => entry.name === agentId)) return;
    if (agentIdentityLockedByGroup(agentId)) {
      setNotice(collaborationLockedNotice);
      return;
    }
    commit((_next, nextAgents) => {
      const current = nextAgents[agentId];
      if (!current) return;
      const merged = {
        ...current,
        ...patch
      };
      const harnessId = merged.harness ?? catalogDefaultHarnessId(harnesses);
      const selectedHarness = harnesses.find((item) => item.id === harnessId);
      nextAgents[agentId] = constrainAgentConfigToHarness(merged, selectedHarness);
    });
  };

  const agentMutationTouchesLockedGroup = (agentId: string) => (
    [...lockedGroupIds].some((groupId) =>
      (orchestration.routes[groupId] ?? []).some((edge) => edge.target === agentId)
      || (orchestration.routes[agentId] ?? []).some((edge) => edge.target === groupId)
      || agentIdentityLockedByGroup(agentId)
    )
  );

  const renameAgent = (value: string, oldName = activeInspectorAgentId) => {
    if (!oldName || oldName === "main" || effectiveReadOnly) return;
    const memberGroup = (orchestration.collaborations ?? []).find((group) => group.memberAgentIds.includes(oldName));
    if ((memberGroup && lockedGroupIds.has(memberGroup.id)) || agentMutationTouchesLockedGroup(oldName)) {
      setNotice(collaborationLockedNotice);
      return;
    }
    const nextName = value.trim();
    if (
      !isAgentIdentifier(nextName) ||
      nextName === "main" ||
      (nextName !== oldName && (
        orchestration.agents.some((entry) => entry.name === nextName) ||
        (orchestration.collaborations ?? []).some((group) => group.id === nextName)
      ))
    ) return;
    commit((next, nextAgents) => {
      const old = oldName;
      next.agents = next.agents.map((entry) => entry.name === old ? { ...entry, name: nextName } : entry);
      next.collaborations = (next.collaborations ?? []).map((group) => ({
        ...group,
        memberAgentIds: group.memberAgentIds.map((member) => member === old ? nextName : member)
      }));
      if (next.schemaVersion === 3 && next.scopedWorkflow) {
        next.scopedWorkflow.rootAgentIds = next.scopedWorkflow.rootAgentIds.map((id) => id === old ? nextName : id);
        for (const group of next.scopedWorkflow.groups) {
          if (group.leaderAgentId === old) group.leaderAgentId = nextName;
          group.workflow.nodes = group.workflow.nodes.map((ref) => ref.kind === "agent" && ref.agentId === old ? { ...ref, agentId: nextName } : ref);
        }
      }
      next.input.target = next.input.target === old ? nextName : next.input.target;
      next.termination.agent = next.termination.agent === old ? nextName : next.termination.agent;
      next.loops = next.loops?.map((loop) => ({
        ...loop,
        from: loop.from === old ? nextName : loop.from,
        to: loop.to === old ? nextName : loop.to,
        exitTo: loop.exitTo === old ? nextName : loop.exitTo
      }));
      next.routes = Object.fromEntries(Object.entries(next.routes).map(([source, routes]) => [source === old ? nextName : source, routes.map((edge) => ({ ...edge, target: edge.target === old ? nextName : edge.target }))]));
      next.decisionPlans = Object.fromEntries(Object.entries(next.decisionPlans).map(([name, plan]) => [name === old ? nextName : name, plan]));
      if (next.canvas) {
        if (next.canvas.nodes[old]) {
          next.canvas.nodes[nextName] = next.canvas.nodes[old]!;
          delete next.canvas.nodes[old];
        }
        next.canvas.edges = Object.fromEntries(
          Object.entries(next.canvas.edges).map(([id, layout]) => [
            id.replaceAll(`${old}->`, `${nextName}->`).replaceAll(`->${old}:`, `->${nextName}:`),
            layout
          ])
        );
      }
      nextAgents[nextName] = nextAgents[old]!; delete nextAgents[old];
    });
    if (activeScopedGroupId) setEditingGroupMemberId(undefined);
    else if (memberGroup) setEditingGroupMemberId(nextName);
    else setSelectedId(nextName);
  };

  const removeAgent = (requestedId = selectedId) => {
    const node = model.nodes.find((item) => item.id === requestedId);
    if (!node || node.kind !== "agent" || node.collaboration || node.name === "main" || effectiveReadOnly) return;
    const name = node.name;
    if (orchestration.schemaVersion === 3 && orchestration.scopedWorkflow?.groups.some((group) =>
      group.leaderAgentId === name || group.workflow.nodes.some((ref) => ref.kind === "agent" && ref.agentId === name)
    )) {
      setNotice(`${name} 仍被协作组引用或担任 Leader；请先处理这些引用，再删除 Agent 实体`);
      return;
    }
    const loop = orchestration.loops?.find((item) => (
      item.from === name
      || item.to === name
      || item.exitTo === name
      || workflowLoopMembers(orchestration, item).includes(name)
    ));
    if (loop) {
      setNotice(`${name} 属于 Loop ${loop.id}，请先断开该 Loop 的一条强边`);
      return;
    }
    commit((next, nextAgents) => {
      next.agents = next.agents.filter((entry) => entry.name !== name);
      if (next.schemaVersion === 3 && next.scopedWorkflow) next.scopedWorkflow.rootAgentIds = next.scopedWorkflow.rootAgentIds.filter((id) => id !== name);
      const fallback = next.agents.find((entry) => entry.name !== "main")?.name ?? "main";
      if (next.input.target === name) next.input.target = fallback;
      if (next.termination.agent === name) next.termination.agent = fallback;
      next.routes = Object.fromEntries(Object.entries(next.routes).filter(([source]) => source !== name).map(([source, routes]) => [source, routes.filter((edge) => edge.target !== name)]));
      delete next.decisionPlans[name]; delete nextAgents[name]; syncMainOuterRoutes(next); next.canvas = normalizeCanvasLayout(next.canvas, next);
    });
    setSelectedId("main");
  };

  const addAgent = (requestedName = newAgentName, template = newAgentTemplate, description = newAgentDescription, registerTemplate = false) => {
    const name = requestedName.trim();
    if (effectiveReadOnly) return;
    const builtinNames = ["main", "general", "idea", "execution", "writing", "review"];
    if (!isAgentIdentifier(name) || name === "main"
      || orchestration.agents.some((entry) => entry.name === name)
      || (orchestration.collaborations ?? []).some((group) => group.id === name)
      || (registerTemplate && (builtinNames.includes(name) || orchestration.agentTemplates?.some((entry) => entry.name === name)))) {
      setNotice("请输入唯一的 Agent 名称（不能与系统节点、协作组或已有模板重名）");
      return;
    }
    const previousLayout = normalizeCanvasLayout(orchestration.canvas, orchestration);
    commit((next, nextAgents) => {
      if (registerTemplate) next.agentTemplates = [...(next.agentTemplates ?? []), { name, template, description: description.trim().slice(0, 180) }];
      next.agents.push({ name, template, description: description.trim().slice(0, 180) || agentMeta(name, template).description }); next.routes[name] = []; next.decisionPlans[name] = `结合 ${name} Agent 的结果和当前证据，选择下一步路径。`;
      if (next.schemaVersion === 3 && next.scopedWorkflow) next.scopedWorkflow.rootAgentIds.push(name);
      // Preserve the current cards. Rebuilding a default layout after adding
      // the sixth Agent moves every existing card and makes routing expensive.
      const layout = normalizeCanvasLayout(previousLayout, next);
      const occupied = Object.entries(layout.nodes).filter(([id]) => id !== name).map(([, point]) => point);
      const preferred = [
        { x: 20, y: 450 }, { x: 20, y: 640 }, { x: 20, y: 70 },
        { x: 980, y: 450 }, { x: 735, y: 450 }, { x: 490, y: 450 }
      ];
      let position = { x: 980, y: 450 };
      for (let slot = 0; slot < 200; slot += 1) {
        const candidate = preferred[slot] ?? { x: 980 + Math.floor((slot - preferred.length) / 4) * 250, y: 70 + ((slot - preferred.length) % 4) * 190 };
        if (occupied.every((point) => Math.abs(point.x - candidate.x) >= 218 || Math.abs(point.y - candidate.y) >= 122)) {
          position = candidate;
          break;
        }
      }
      layout.nodes[name] = position;
      next.canvas = layout;
      nextAgents[name] = defaultAgentConfig(name, template);
    });
    setNewAgentName(""); setNewAgentDescription(""); setShowAddAgent(false); setSelectedId(name); setNotice(`${name} 已添加，请手动连接出边`);
  };

  const createCollaboration = () => {
    const id = newGroupId.trim();
    const displayName = newGroupDisplayName.trim();
    const memberAgentIds = orchestration.agents
      .map((entry) => entry.name)
      .filter((name) => newGroupMembers.has(name));
    if (!gitEnabled) { setNotice("创建协作组需要先启用 Git 机制"); return; }
    if (!isAgentIdentifier(id) || id === "main" || id === "input" || id === "finish") {
      setNotice("请输入唯一的协作组 ID"); return;
    }
    if (!displayName) { setNotice("请输入协作组显示名称"); return; }
    if (memberAgentIds.length < 2) { setNotice("协作组至少需要两个普通 Agent"); return; }
    if (!newGroupLeaderId || memberAgentIds.includes(newGroupLeaderId)) {
      setNotice("请选择不参与本组业务的 Leader"); return;
    }
    const namespace = new Set([
      ...orchestration.agents.map((entry) => entry.name),
      ...(orchestration.collaborations ?? []).map((group) => group.id)
    ]);
    if (namespace.has(id)) { setNotice("协作组 ID 不能与 Agent 或其他组重复"); return; }
    if (orchestration.schemaVersion !== 3 && (orchestration.collaborations?.length ?? 0) > 0) {
      const missing = orchestration.collaborations?.find((group) => !legacyLeaderSelections[group.id]
        || group.memberAgentIds.includes(legacyLeaderSelections[group.id]!));
      if (missing) { setNotice(`请先为旧协作组 ${missing.displayName} 选择非成员 Leader`); return; }
      if (lockedGroupIds.size) { setNotice("运行中的旧协作组不能升级；请等待最终 PR 收敛"); return; }
    }
    const preview = structuredClone(orchestration);
    try {
      upgradeLegacyGroups(preview, legacyLeaderSelections);
      addScopedGroup(preview, { id, displayName, leaderAgentId: newGroupLeaderId, memberAgentIds });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "创建协作组失败"); return;
    }
    const created = commit((next) => {
      upgradeLegacyGroups(next, legacyLeaderSelections);
      addScopedGroup(next, { id, displayName, leaderAgentId: newGroupLeaderId, memberAgentIds });
      next.canvas = normalizeCanvasLayout(next.canvas, next);
    });
    if (!created) return;
    setShowAddCollaboration(false);
    setNewGroupId(""); setNewGroupDisplayName(""); setNewGroupMembers(new Set()); setNewGroupLeaderId("");
    setSelectedId(id); setActiveScopedGroupId(id); setNotice(`${displayName} 已创建；原 Agent 节点和 session 保留`);
  };

  const updateCollaboration = (value: NonNullable<AgentOrchestrationTemplate["collaborations"]>[number]) => {
    if (effectiveReadOnly) return;
    if (lockedGroupIds.has(value.id)) {
      setNotice(collaborationLockedNotice);
      return;
    }
    const current = (orchestration.collaborations ?? []).find((group) => group.id === value.id);
    if (!current || current.renamePolicy === "locked") return;
    collapseGroup(value.id);
    commit((next) => {
      next.collaborations = (next.collaborations ?? []).map((group) =>
        group.id === value.id
          ? { ...group, displayName: value.displayName.slice(0, 64) }
          : group
      );
    });
  };

  const updateScopedCollaboration = (value: NonNullable<AgentOrchestrationTemplate["scopedWorkflow"]>["groups"][number]) => {
    if (effectiveReadOnly || lockedGroupIds.has(value.id)) {
      if (lockedGroupIds.has(value.id)) setNotice(collaborationLockedNotice);
      return;
    }
    commit((next) => {
      const target = next.scopedWorkflow?.groups.find((group) => group.id === value.id);
      if (target) Object.assign(target, structuredClone(value));
    });
  };

  const applyCollaborationDissolution = (
    group: CollaborationNode,
    plan?: CollaborationDissolutionPlan
  ) => {
    commit((next) => {
      dissolveCollaborationInDraft(next, group.id, plan);
      next.canvas = normalizeCanvasLayout(next.canvas, next);
    });
    setDissolutionDraft(undefined);
    setEditingGroupMemberId(undefined);
    setSelectedId(group.memberAgentIds[0]);
    setNotice(`${group.displayName} 已解散；成员已恢复为外层 Agent，历史记录保持不变。`);
  };

  const dissolveCollaboration = (group: CollaborationNode) => {
    if (effectiveReadOnly) return;
    if (lockedGroupIds.has(group.id)) {
      setNotice(collaborationLockedNotice);
      return;
    }
    const exactRestore = canRestoreCollaborationSnapshot(orchestration, group);
    const entryAgentId = group.memberAgentIds[0]!;
    const exitAgentId = group.memberAgentIds.at(-1)!;
    setDissolutionDraft({
      groupId: group.id,
      ...(exactRestore ? {} : {
        plan: buildGuidedDissolutionPlan(orchestration, group, entryAgentId, exitAgentId)
      })
    });
  };

  const addAgentCopy = (definition: AgentDefinition) => {
    if (definition.name === "main") return;
    let copy = 1;
    const occupied = new Set([
      ...orchestration.agents.map((entry) => entry.name),
      ...(orchestration.collaborations ?? []).map((group) => group.id)
    ]);
    while (occupied.has(`${definition.name}_copy${copy}`)) copy += 1;
    addAgent(`${definition.name}_copy${copy}`, definition.template ?? "general", definition.description ?? "");
  };

  const removeAgentTemplate = (name: string) => {
    if (effectiveReadOnly) return;
    commit((next) => { next.agentTemplates = (next.agentTemplates ?? []).filter((entry) => entry.name !== name); });
    setNotice(`${name} 模板已删除`);
  };

  const updateSelectedMcp = (server: AgentMcpServer, enabled: boolean, agentId = activeInspectorAgentId) => {
    const config = agentId ? agents[agentId] : undefined;
    if (!config) return;
    const nextServers = enabled
      ? [...config.mcpServers.filter((item) => item.name.toLowerCase() !== server.name.toLowerCase()), { ...server }]
      : config.mcpServers.filter((item) => agentMcpServerKey(item) !== agentMcpServerKey(server));
    updateAgentPatch({ mcpServers: nextServers }, agentId);
  };

  const addSelectedMcp = async (name: string, url: string, agentId = activeInspectorAgentId) => {
    const normalizedName = name.trim(); const normalizedUrl = url.trim();
    const fixed = mcpDirectory.find((entry) => entry.name.toLowerCase() === normalizedName.toLowerCase());
    if (fixed && (fixed.name !== normalizedName || fixed.url !== normalizedUrl)) throw new Error(`系统 MCP ${fixed.name} 的名称和 URL 不可修改`);
    const config = agentId ? agents[agentId] : undefined;
    if (!config) throw new Error("请先选择 Agent");
    if (config.mcpServers.some((item) => item.name.toLowerCase() === normalizedName.toLowerCase())) throw new Error(`MCP 名称已存在：${normalizedName}`);
    if (config.mcpServers.length >= 32) throw new Error("每个 Agent 最多可配置 32 个 MCP");
    const server = { name: normalizedName, url: normalizedUrl }; updateAgentPatch({ mcpServers: [...config.mcpServers, server] }, agentId); return server;
  };

  const restoreHistory = (previous: HistoryEntry) => {
    cancelActiveGestures();
    setPendingNodePosition(undefined);
    settledGeometryRef.current = undefined;
    routeCacheRef.current = undefined;
    layoutRouteLockRef.current = undefined;
    const nextOrchestration = structuredClone(previous.orchestration);
    const nextAgents = structuredClone(previous.agents);
    historyNavigationSignatureRef.current = JSON.stringify({ orchestration: nextOrchestration, agents: nextAgents });
    onOrchestrationChange(nextOrchestration);
    onAgentsChange(nextAgents);
    setViewportOverride({ ...previous.viewport });
    setNotice("有未保存修改");
  };
  const undo = () => {
    if (!history.length || effectiveReadOnly || layoutBusyRef.current) return;
    if (lockedGroupIds.size) { setNotice(collaborationLockedNotice); return; }
    setRedoHistory((items) => [...items.slice(-29), { orchestration: structuredClone(orchestration), agents: structuredClone(agents), viewport: { ...viewport } }]);
    setHistory((items) => items.slice(0, -1));
    restoreHistory(history.at(-1)!);
  };
  const redo = () => {
    if (!redoHistory.length || effectiveReadOnly || layoutBusyRef.current) return;
    if (lockedGroupIds.size) { setNotice(collaborationLockedNotice); return; }
    setHistory((items) => [...items.slice(-29), { orchestration: structuredClone(orchestration), agents: structuredClone(agents), viewport: { ...viewport } }]);
    setRedoHistory((items) => items.slice(0, -1));
    restoreHistory(redoHistory.at(-1)!);
  };

  const clearCanvas = () => {
    if (effectiveReadOnly) return;
    if (lockedGroupIds.size) {
      setNotice(collaborationLockedNotice);
      return;
    }
    if (typeof window !== "undefined" && !window.confirm("清空画布将移除所有业务 Agent 和连线，只保留用户输入、Main Agent 与结束节点。确定继续吗？")) return;
    commit((next, nextAgents) => {
      const main = next.agents.find((entry) => entry.name === "main") ?? { name: "main", template: "main" as const };
      next.agents = [main]; next.collaborations = []; if (next.schemaVersion === 3) next.scopedWorkflow = { schemaVersion: 1, rootAgentIds: ["main"], groups: [] }; next.input.target = "main"; next.routes = { main: [] }; next.loops = []; next.decisionPlans = { main: next.decisionPlans.main ?? "负责理解目标、协调上下文并判断是否结束。" }; next.termination = { ...next.termination, agent: "main", decisionBy: "main", automatic: false }; next.canvas = normalizeCanvasLayout(undefined, next); for (const key of Object.keys(nextAgents)) if (key !== "main") delete nextAgents[key];
    });
    setSelectedId("main"); setSelectedEdgeId(undefined); setNotice("画布已清空，仅保留三个系统节点");
  };

  const animationStillCurrent = (operationId: number, signature: string) =>
    operationId === layoutOperationRef.current
    && signature === workflowCanvasSignature(orchestrationRef.current);

  const animateLayoutPlanPreview = (
    operationId: number,
    signature: string,
    from: WorkflowCanvasLayout,
    to: WorkflowCanvasLayout,
    crossfadePorts: boolean,
    duration: number,
    sourceRoutes: DragRouteLock[]
  ): Promise<boolean> => {
    setLayoutPhase("applying");
    setLayoutMessage("正在应用布局…");
    if (crossfadePorts) setLayoutEdgeTransition({ sourceRoutes: structuredClone(sourceRoutes), progress: 0 });
    return animateCanvasFrames(
      duration,
      () => animationStillCurrent(operationId, signature),
      (progress) => {
        const frame = interpolateCanvasLayout(from, to, progress);
        setLayoutPreview(frame);
        setViewportOverride(frame.viewport);
        if (crossfadePorts) setLayoutEdgeTransition({
          sourceRoutes,
          progress: Math.min(1, progress * duration / 120)
        });
      },
      layoutAnimationFrameRef
    );
  };

  const applyLayout = async (kind: "tidy" | "layered" | "fit") => {
    if (effectiveReadOnly || layoutBusyRef.current) return;
    if (kind !== "fit" && lockedGroupIds.size) {
      setNotice(collaborationLockedNotice);
      return;
    }
    const operationId = layoutOperationRef.current + 1;
    layoutOperationRef.current = operationId;
    layoutKindRef.current = kind;
    const signature = workflowCanvasSignature(orchestration);
    const emit = (phase: CanvasLayoutSnapshotPhase, payload: Partial<CanvasLayoutOperationSnapshot> = {}) => {
      emitLayoutSnapshot({ operationId, signature, operation: kind, phase, ...payload });
    };

    if (kind === "fit") {
      // Fit is intentionally a viewport-only operation: no node, edge or port
      // field is touched and no tidy planner is invoked.
      const current = structuredClone(orchestration);
      const currentLayout = normalizeCanvasLayout(current.canvas, current);
      const currentModel = adaptWorkflowToCanvas(current, currentLayout);
      const measured = currentModel.nodes.map((node) => nodeSizes[node.id] ? { ...node, ...nodeSizes[node.id] } : node);
      const currentGeometry = geometry;
      const bounds = canvasContentBounds(measured, currentGeometry.flatMap((item) => item.samples));
      const fitted = fitCanvasViewport(
        { width: Math.max(1, viewportSize.width), height: Math.max(1, viewportSize.height) },
        bounds,
        { minZoom: .08, maxZoom: 1.08 }
      );
      emit("planning", { layout: currentLayout });
      if (sameCanvasViewport(currentLayout.viewport, fitted)) {
        setLayoutMessage("当前视口已经适合画布");
        setNotice("当前视口已经适合画布");
        emit("unchanged", { layout: currentLayout, finalViewport: fitted });
        return;
      }
      emit("final", { layout: currentLayout, finalViewport: fitted });
      persistViewport(fitted);
      setLayoutMessage("布局已完成");
      setNotice("已适应当前画布");
      return;
    }

    const base = structuredClone(orchestration);
    const baseLayout = normalizeCanvasLayout(base.canvas, base);
    const cacheKey = canvasLayoutPlanCacheKey(kind, base, nodeSizes, viewportSize);
    const cached = layoutPlanCacheRef.current;
    if (cached?.kind === kind && cached.key === cacheKey && sameCanvasLayoutFrame(baseLayout, cached.plan.layout)) {
      setLayoutMessage("当前布局已经清晰");
      setNotice("当前布局已经清晰");
      emit("unchanged", {
        layout: baseLayout,
        layoutMode: cached.plan.mode,
        finalViewport: cached.plan.finalViewport,
        movedNodeCount: 0,
        portChangeCount: 0,
        collisionReduction: 0
      });
      return;
    }
    const previousOverride = viewportOverride;
    const historySnapshot: HistoryEntry = {
      orchestration: structuredClone(orchestration),
      agents: structuredClone(agents),
      viewport: { ...viewport }
    };
    layoutViewportBeforeRef.current = { viewport: previousOverride };
    layoutBusyRef.current = true;
    setViewportOverride({ ...viewport });
    let completed = false;
    let fallbackReason: string | undefined;
    clearConnection();
    setDragging(undefined);
    dragRef.current = undefined;
    lockedGeometryRef.current = undefined;
    settledGeometryRef.current = undefined;
    panRef.current = undefined;
    setPan(undefined);
    setGuides({});
    setLayoutBusy(true);
    setLayoutPhase("planning");
    setLayoutMessage("正在计算布局…");
    emit("planning", { layout: baseLayout });
    try {
      // Yield once so the busy state and progress cursor paint before ELK and
      // the synchronous readability pass use the main thread.
      await yieldLayoutPlanningTurn();
      if (!animationStillCurrent(operationId, signature)) return;
      const plan = cached?.kind === kind && cached.key === cacheKey
        ? structuredClone(cached.plan)
        : await buildCanvasLayoutPlan({
          kind,
          orchestration: base,
          layout: baseLayout,
          nodeSizes,
          viewportSize
        });
      if (!animationStillCurrent(operationId, signature)) return;
      fallbackReason = plan.usedFallback ? plan.fallbackReason : undefined;
      layoutPlanCacheRef.current = { key: cacheKey, kind, plan: structuredClone(plan) };
      emit("planned", {
        layout: plan.layout,
        layoutMode: plan.mode,
        finalViewport: plan.finalViewport,
        movedNodeCount: plan.movedNodeIds.length,
        portChangeCount: plan.portChanges,
        collisionReduction: plan.collisionsReduced,
        usedFallback: plan.usedFallback,
        fallbackReason
      });
      const graphMatches = sameCanvasLayoutFrame(
        { ...baseLayout, viewport: plan.layout.viewport },
        plan.layout
      );
      const viewportMatches = sameCanvasViewport(baseLayout.viewport, plan.finalViewport);
      if (graphMatches && viewportMatches) {
        setLayoutMessage("当前布局已经清晰");
        setNotice("当前布局已经清晰");
        emit("unchanged", {
          layout: plan.layout,
          layoutMode: plan.mode,
          finalViewport: plan.finalViewport,
          movedNodeCount: 0,
          portChangeCount: 0,
          collisionReduction: 0,
          usedFallback: plan.usedFallback,
          fallbackReason
        });
        completed = true;
        return;
      }
      const sourceRoutes = captureRouteLock(geometry, displayNodes);
      layoutRouteLockRef.current = {
        topologyKey: plan.routeTopologyKey,
        routes: structuredClone(plan.routeLocks)
      };
      emit("applying", {
        layout: plan.layout,
        layoutMode: plan.mode,
        finalViewport: plan.finalViewport,
        movedNodeCount: plan.movedNodeIds.length,
        portChangeCount: plan.portChanges,
        collisionReduction: plan.collisionsReduced,
        usedFallback: plan.usedFallback,
        fallbackReason
      });
      const animated = await animateLayoutPlanPreview(
        operationId,
        signature,
        baseLayout,
        plan.layout,
        plan.portChanges > 0,
        kind === "tidy" ? 180 : 240,
        sourceRoutes
      );
      if (!animated) return;
      emit("final", {
        layout: plan.layout,
        layoutMode: plan.mode,
        finalViewport: plan.finalViewport,
        movedNodeCount: plan.movedNodeIds.length,
        portChangeCount: plan.portChanges,
        collisionReduction: plan.collisionsReduced,
        usedFallback: plan.usedFallback,
        fallbackReason
      });
      const next = structuredClone(base);
      next.canvas = structuredClone(plan.layout);
      const finalNodes = adaptWorkflowToCanvas(next, plan.layout).nodes.map((node) => {
        const measured = nodeSizes[node.id];
        return measured ? { ...node, ...measured } : node;
      });
      const finalRouteCache = {
        topologyKey: plan.routeTopologyKey,
        nodeFrameKey: canvasNodeFrameKey(finalNodes),
        routes: structuredClone(plan.routeLocks)
      };
      routeCacheRef.current = finalRouteCache;
      settledGeometryRef.current = undefined;
      // A graph change is one undo boundary. A viewport-only fit remains
      // intentionally outside history.
      if (!graphMatches) {
        setHistory((items) => [...items.slice(-29), historySnapshot]);
        setRedoHistory([]);
      }
      setLayoutPreview(undefined);
      setLayoutEdgeTransition(undefined);
      setViewportOverride(plan.finalViewport);
      onOrchestrationChange(next);
      completed = true;
      const suffix = fallbackReason ? ` · ${fallbackReason}` : "";
      const summary = [
        plan.movedNodeIds.length ? `移动 ${plan.movedNodeIds.length} 个节点` : "节点位置未变",
        plan.portChanges ? `调整 ${plan.portChanges} 组端口` : "端口未变",
        plan.collisionsReduced ? `减少 ${plan.collisionsReduced} 处冲突` : ""
      ].filter(Boolean).join(" · ");
      setLayoutMessage(fallbackReason ? `布局已完成（使用回退）` : "布局已完成");
      setNotice(`有未保存修改 · ${summary}${suffix}`);
    } catch (error) {
      if (operationId === layoutOperationRef.current) {
        const message = `${kind === "layered" ? "分层重排" : "智能整理"}未完成：${error instanceof Error ? error.message : "请重试"}`;
        setLayoutMessage(message);
        setNotice(message);
      }
    } finally {
      if (operationId === layoutOperationRef.current) {
        layoutBusyRef.current = false;
        layoutRouteLockRef.current = undefined;
        if (!completed) setViewportOverride(signature === workflowCanvasSignature(orchestrationRef.current) ? previousOverride : undefined);
        setLayoutPreview(undefined);
        setLayoutEdgeTransition(undefined);
        setLayoutBusy(false);
        setLayoutPhase("idle");
      }
    }
  };

  useEffect(() => () => {
    layoutOperationRef.current += 1;
    if (layoutAnimationFrameRef.current !== undefined && typeof window !== "undefined") {
      window.cancelAnimationFrame(layoutAnimationFrameRef.current);
    }
    if (wheelFrameRef.current !== undefined && typeof window !== "undefined") {
      window.cancelAnimationFrame(wheelFrameRef.current);
    }
    if (viewportPersistenceTimerRef.current !== undefined) {
      clearTimeout(viewportPersistenceTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (activeScopedGroupId) return;
      const target = event.target as HTMLElement | null;
      const editable = target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
      if (event.key === "Escape") {
        cancelActiveGestures();
        cancelLayout();
        return;
      }
      if (editable) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedEdgeId) { event.preventDefault(); removeEdge(selectedEdgeId); }
    };
    const onBlur = () => {
      // Browsers can drop pointer capture when focus leaves the window before
      // dispatching pointerup. Preserve the last valid drag sample, then clear
      // any unrelated transient connection or pan gesture.
      finalizeActiveDrag();
      cancelActiveGestures();
    };
    window.addEventListener("keydown", onKeyDown); window.addEventListener("blur", onBlur);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("blur", onBlur); };
  });

  const selectedNode = model.nodes.find((node) => node.id === selectedId);
  const selectedEdge = model.edges.find((edge) => edge.id === selectedEdgeId);
  const selectedEdgeLocked = Boolean(
    selectedEdge && collaborationEdgeLocked(selectedEdge.source, selectedEdge.target)
  );
  const selectedCollaboration = selectedNode?.collaboration;
  const selectedScopedCollaboration = selectedCollaboration && orchestration.scopedWorkflow?.groups.find((group) => group.id === selectedCollaboration.id);
  const selectedMemberDefinition = activeMemberCollaboration && editingGroupMemberId
    ? orchestration.agents.find((entry) => entry.name === editingGroupMemberId)
    : undefined;
  const inspectorNode: CanvasNode | undefined = selectedMemberDefinition
    ? {
        id: selectedMemberDefinition.name,
        kind: "agent",
        name: selectedMemberDefinition.name,
        template: selectedMemberDefinition.template,
        x: selectedNode?.x ?? 0,
        y: selectedNode?.y ?? 0
      }
    : selectedNode;
  const selectedAgent = activeInspectorAgentId ? agents[activeInspectorAgentId] : undefined;
  const selectedDefinition = activeInspectorAgentId
    ? orchestration.agents.find((entry) => entry.name === activeInspectorAgentId)
    : undefined;
  const resolvePresentation = useCallback((node: CanvasNode): CanvasNodePresentation => {
    if (node.kind === "input") return { title: "用户输入", description: "用户提交的任务、约束和已有资料。", modelLabel: "input", color: "#446b9b", softColor: "#eaf0f7" };
    if (node.kind === "finish") return { title: "结束", description: "被指定的终止外层节点完成后进入这里。", modelLabel: "工作流结束", color: "#a65365", softColor: "#f9eaed" };
    if (node.collaboration) return { title: node.displayName ?? node.name, description: node.memberNodeRefs ? `${node.memberNodeRefs.length} 个直接节点` : `${node.memberAgentIds?.length ?? 0} 名现有 Agent 协作`, modelLabel: "COLLABORATION", initials: "组", color: "#5c5bd6", softColor: "#eeedff" };
    const definition = orchestration.agents.find((entry) => entry.name === node.name);
    if (node.name === "main") return { title: "Main Agent", description: definition?.description ?? "理解目标、协调上下文，并在每轮选择一个外层节点。", modelLabel: agents[node.name]?.model ?? "gpt-5.6-sol", initials: "MA", color: "#25714e", softColor: "#e7f1e9" };
    const meta = agentMeta(node.name, node.template ?? "general"); const colors = COLOR_VARS[meta.color] ?? COLOR_VARS.slate!;
    return { title: meta.name, description: definition?.description || meta.description, modelLabel: agents[node.name]?.model ?? "gpt-5.6-sol", initials: node.name === "main" ? "MA" : meta.shortName.slice(0, 2).toUpperCase(), color: colors[0], softColor: colors[1] };
  }, [agents, orchestration.agents]);
  const visibleTargetLabel = useCallback((target: string | undefined): string | undefined => {
    if (!target) return undefined;
    const node = model.nodes.find((item) => item.id === target);
    return node ? resolvePresentation(node).title : target;
  }, [model.nodes, resolvePresentation]);
  const footerInputTarget = model.summary.inputConnected ? visibleTargetLabel(model.summary.inputTarget) : undefined;
  const footerTerminationTarget = model.summary.terminationConnected ? visibleTargetLabel(model.summary.terminationTarget) : undefined;
  const footerCurrentTarget = selectedNode ? resolvePresentation(selectedNode).title : undefined;
  const layoutGraphMode = useMemo(
    () => buildCanvasLayoutGraph(orchestration, model.presentationLayout).mode,
    [model]
  );
  const terminalNodeIds = useMemo(() => {
    const ids = new Set<string>();
    if (model.summary.terminationConnected && model.summary.terminationTarget) ids.add(model.summary.terminationTarget);
    return ids;
  }, [model.summary.terminationConnected, model.summary.terminationTarget]);

  const renderedEdges = useMemo(() => [
    ...(transitionGeometry ?? []).map((item) => ({
      id: `layout-exit:${item.id}`,
      source: item.source,
      target: item.target,
      path: item.path,
      midpoint: item.midpoint,
      kind: item.kind,
      fixed: item.fixed,
      sourcePort: item.sourcePort,
      targetPort: item.targetPort,
      points: item.points,
      samples: item.samples,
      visualOpacity: Math.max(0, 1 - (layoutEdgeTransition?.progress ?? 1)),
      transitionGhost: true
    })),
    ...withCanvasLoopPresentation(geometry, model.edges).map((item) => {
      return {
        id: item.id,
        source: item.source,
        target: item.target,
        path: item.path,
        midpoint: item.midpoint,
        kind: item.kind,
        fixed: item.fixed,
        label: item.label,
        loop: item.loop,
        sourcePort: item.sourcePort,
        targetPort: item.targetPort,
        sourcePortPinned: item.sourcePortPinned,
        targetPortPinned: item.targetPortPinned,
        points: item.points,
        samples: item.samples,
        reroutedBecauseBlocked: item.reroutedBecauseBlocked,
        visualOpacity: layoutEdgeTransition?.progress
      };
    })
  ], [geometry, layoutEdgeTransition?.progress, model.edges, transitionGeometry]);
  const pendingPath = useMemo(
    () => connectionSource && linkPreview ? pendingPathFor(connectionSource, displayNodes, linkPreview) : undefined,
    [connectionSource, displayNodes, linkPreview]
  );
  const focusedNodeId = selectedEdgeId ? undefined : hoveredNodeId ?? selectedId;
  const canvasFocusMode = hoveredNodeId ? "hover" : focusedNodeId ? "selected" : undefined;
  const selectedLoopId = selectedEdge?.loop?.role === "exit" ? undefined : selectedEdge?.loop?.id;
  const relatedEdgeIds = useMemo(
    () => new Set(model.edges.filter((edge) => edge.source === focusedNodeId || edge.target === focusedNodeId).map((edge) => edge.id)),
    [focusedNodeId, model.edges]
  );
  const mutedEdgeIds = useMemo(
    () => selectedEdge || focusedNodeId ? new Set(model.edges.filter((edge) => selectedEdge
      ? edge.id !== selectedEdge.id && !(selectedLoopId && edge.loop?.id === selectedLoopId)
      : !relatedEdgeIds.has(edge.id)
    ).map((edge) => edge.id)) : undefined,
    [focusedNodeId, model.edges, relatedEdgeIds, selectedEdge, selectedLoopId]
  );

  const liveViewport = currentViewportRef.current ?? viewport;
  const renderedViewport = pan
    ? { x: panRef.current?.currentX ?? pan.currentX, y: panRef.current?.currentY ?? pan.currentY, zoom: liveViewport.zoom }
    : liveViewport;
  const canvasWorld = <CanvasWorld ref={viewportRef} worldRef={worldRef} viewport={renderedViewport} worldWidth={CANVAS_WORLD_WIDTH} worldHeight={CANVAS_WORLD_HEIGHT} compact={compact} hint={routed.pending ? "正在优化连线，可继续编辑…" : undefined} connecting={Boolean(connectionSource)} panning={Boolean(pan?.moved || panRef.current?.moved)} layoutBusy={layoutBusy} verticalGuide={guides.vertical} horizontalGuide={guides.horizontal} data-canvas-geometry-phase={dragging ? "dragging" : "release"} data-canvas-geometry-valid={geometryValid} data-canvas-layout-phase={layoutPhase} onPointerDown={beginPan} onPointerMove={onWorldPointerMove} onPointerUp={finishGesture} onPointerCancel={finishGesture} onLostPointerCapture={onLostPointerCapture}>
    <CanvasEdges edges={renderedEdges} nodes={displayNodes} moving={Boolean(dragging || layoutPreview)} focusedNodeId={focusedNodeId} focusMode={canvasFocusMode} selectedEdgeId={selectedEdgeId} selectedLoopId={selectedLoopId} relatedEdgeIds={relatedEdgeIds} mutedEdgeIds={mutedEdgeIds} pendingPath={pendingPath} pendingKind={newEdgeKind} pendingInvalid={invalidConnection} interactive={!effectiveReadOnly} onSelectEdge={(edge) => { setSelectedEdgeId(edge.id); setSelectedId(undefined); }} />
    <CanvasNodes expandedGroupIds={expandedGroupIds} onToggleGroup={toggleGroup} nodes={displayNodes} terminalNodeIds={terminalNodeIds} selectedNodeId={selectedId} draggingNodeId={dragging?.id} connectionSourceId={connectionSource?.id} connectionTargetId={connectionTarget?.id} invalidTargetId={invalidConnection ? connectionTarget?.id : undefined} rejectedConnectionNodeId={connectionFailure?.nodeId} rejectedConnectionPulse={connectionFailure?.pulse} dispatchPort={geometry.find((edge) => edge.kind === "main-dispatch")?.sourcePort} compact={compact} readOnly={effectiveReadOnly || layoutBusy} resolvePresentation={resolvePresentation} onNodeResize={onNodeResize} onSelectNode={(node) => { setSelectedId(node.id); setSelectedEdgeId(undefined); }} onNodePointerEnter={(node) => setHoveredNodeId(node.id)} onNodePointerLeave={() => setHoveredNodeId(undefined)} onNodePointerDown={onNodePointerDown} onPortPointerDown={onPortPointerDown} onPortPointerEnter={(node, port) => { if (!connectionRef.current) return; const target = { id: node.id, port }; connectionTargetRef.current = target; setConnectionTarget(target); setInvalidConnection(Boolean(connectionError(connectionRef.current, target))); }} onPortPointerLeave={() => { if (!connectionRef.current) return; connectionTargetRef.current = undefined; setConnectionTarget(undefined); setInvalidConnection(false); }} />
  </CanvasWorld>;

  const header = !compact && (
    <header className="app-header workflow-editor-header">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true"><Atom size={20} /></div>
        <div className="brand-copy"><strong>ScienceEvolve</strong><small>科研智能体工作台</small></div>
        <span className="header-divider" aria-hidden="true" />
        <label className="workflow-name-field"><span className="sr-only">工作流名称</span><input value={workflowName} onChange={(event) => onWorkflowNameChange?.(event.target.value)} readOnly={!onWorkflowNameChange} maxLength={48} /></label>
      </div>
      <div className="header-actions">
        <span className="save-state" aria-live="polite"><i className={saving ? "is-saving" : ""} />{saving ? "保存中" : notice ? "有未保存修改" : "已同步"}</span>
        {onDownload && <button type="button" className="download-button" onClick={onDownload} title="下载 Workflow 配置"><Download size={15} /><span>下载配置</span></button>}
        {onSave && <button type="button" className="primary-button" onClick={onSave} disabled={saving || effectiveReadOnly || layoutBusy || nameDraftInvalid}><Save size={15} />{saving ? "保存中" : "保存流程"}</button>}
        {onClose && <button type="button" className="canvas-close-button" onClick={onClose} title="关闭 Workflow 编辑器" aria-label="关闭 Workflow 编辑器"><X size={16} /></button>}
      </div>
    </header>
  );
  const addAgentDialog = showAddAgent && (
    <div className="canvas-agent-dialog" role="dialog" aria-modal="true" aria-labelledby="canvas-agent-dialog-title">
      <button type="button" className="canvas-agent-dialog-backdrop" aria-label="关闭新建 Agent" onClick={() => setShowAddAgent(false)} />
      <form className="canvas-agent-dialog-panel" onSubmit={(event) => { event.preventDefault(); if (newAgentName.trim() && newAgentDescription.trim()) addAgent(newAgentName, newAgentTemplate, newAgentDescription, true); }}>
        <div className="dialog-heading"><div><p className="eyebrow">CUSTOM AGENT</p><h2 id="canvas-agent-dialog-title">新建 Agent 模板</h2></div><button type="button" className="icon-button" onClick={() => setShowAddAgent(false)} title="关闭" aria-label="关闭"><X size={16} /></button></div>
        <label><span>Agent 名称</span><input ref={agentNameInputRef} value={newAgentName} onChange={(event) => setNewAgentName(event.target.value)} placeholder="例如 verifier_agent" maxLength={32} required /></label>
        <label><span>职责说明</span><textarea value={newAgentDescription} onChange={(event) => setNewAgentDescription(event.target.value)} placeholder="例如：核验论证、结果和交付质量" rows={3} maxLength={180} required /></label>
        <label><span>模板</span><select value={newAgentTemplate} onChange={(event) => setNewAgentTemplate(event.target.value as AgentTemplate)} aria-label="画布新 Agent 模板">{["general", "idea", "execution", "writing", "review"].map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setShowAddAgent(false)}>取消</button><button type="submit" className="primary-button" disabled={!newAgentName.trim() || !newAgentDescription.trim()}>添加模板和 Agent</button></div>
      </form>
    </div>
  );
  const addCollaborationDialog = showAddCollaboration && (
    <div className="canvas-agent-dialog" role="dialog" aria-modal="true" aria-labelledby="canvas-collaboration-dialog-title">
      <button type="button" className="canvas-agent-dialog-backdrop" aria-label="关闭新建协作组" onClick={() => setShowAddCollaboration(false)} />
      <div className="canvas-agent-dialog-panel collaboration-dialog-panel" onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        if (gitEnabled && newGroupId.trim() && newGroupDisplayName.trim() && newGroupMembers.size >= 2 && newGroupLeaderId) createCollaboration();
      }}>
        <div className="dialog-heading"><div><p className="eyebrow">COLLABORATION</p><h2 id="canvas-collaboration-dialog-title">新增协作组</h2></div><button type="button" className="icon-button" onClick={() => setShowAddCollaboration(false)} title="关闭" aria-label="关闭"><X size={16} /></button></div>
        <label><span>组 ID</span><input aria-label="新协作组 ID" value={newGroupId} onChange={(event) => setNewGroupId(event.target.value)} placeholder="例如 evidence_team" maxLength={32} required /></label>
        <label><span>显示名称</span><input aria-label="新协作组显示名称" value={newGroupDisplayName} onChange={(event) => setNewGroupDisplayName(event.target.value)} placeholder="例如 证据协作组" maxLength={64} required /></label>
        <fieldset className="collaboration-member-fieldset"><legend>选择现有普通 Agent（至少两个）</legend>
          {orchestration.agents.filter((entry) => entry.name !== "main").map((definition) => {
            const shared = (orchestration.collaborations ?? []).some((group) => group.memberAgentIds.includes(definition.name));
            return <label key={definition.name}><input type="checkbox" checked={newGroupMembers.has(definition.name)} onChange={(event) => { const next = new Set(newGroupMembers); if (event.target.checked) next.add(definition.name); else next.delete(definition.name); setNewGroupMembers(next); }} /><span>{definition.name}{shared ? " · 已被其他组引用" : ""}</span></label>;
          })}
        </fieldset>
        <label><span>本组 Leader（不执行业务）</span><select aria-label="新协作组 Leader" value={newGroupLeaderId} onChange={(event) => setNewGroupLeaderId(event.target.value)}><option value="">选择现有 Agent</option>{orchestration.agents.filter((entry) => !newGroupMembers.has(entry.name)).map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}</select></label>
        {orchestration.schemaVersion !== 3 && (orchestration.collaborations?.length ?? 0) > 0 && <fieldset className="collaboration-member-fieldset"><legend>旧平铺组升级：为每组选择非成员 Leader</legend>{orchestration.collaborations?.map((group) => <label key={group.id}>{group.displayName}<select aria-label={`${group.displayName} 迁移 Leader`} value={legacyLeaderSelections[group.id] ?? ""} onChange={(event) => setLegacyLeaderSelections((current) => ({ ...current, [group.id]: event.target.value }))}><option value="">选择 Agent</option>{orchestration.agents.filter((entry) => !group.memberAgentIds.includes(entry.name)).map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}</select></label>)}</fieldset>}
        {!gitEnabled && <p className="edge-type-help" role="status">创建协作组需要先启用 Git 机制</p>}
        <p className="edge-type-help">新组添加的是现有 Agent 的图节点引用；原范围节点、连线和 session 不会删除。新组会作为独立复合节点加入外层画布。</p>
        <div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setShowAddCollaboration(false)}>取消</button><button type="button" className="primary-button" disabled={!gitEnabled || !newGroupId.trim() || !newGroupDisplayName.trim() || newGroupMembers.size < 2 || !newGroupLeaderId} onClick={createCollaboration}>创建可编排协作组</button></div>
      </div>
    </div>
  );
  const upgradeLegacyDialog = showLegacyUpgrade && orchestration.schemaVersion !== 3 && (
    <div className="canvas-agent-dialog" role="dialog" aria-modal="true" aria-label="升级旧协作组">
      <button type="button" className="canvas-agent-dialog-backdrop" aria-label="取消升级" onClick={() => setShowLegacyUpgrade(false)} />
      <div className="canvas-agent-dialog-panel collaboration-dialog-panel">
        <div className="dialog-heading"><div><p className="eyebrow">WORKFLOW UPGRADE</p><h2>升级旧协作组</h2></div><button type="button" className="icon-button" aria-label="关闭升级" onClick={() => setShowLegacyUpgrade(false)}><X size={16} /></button></div>
        <p>旧组原有的并行成员会转换为从“进入协作组”发出的并行边；外层节点和连线保持原样。请为每组选择一名不参与该组业务的 Leader。</p>
        {(orchestration.collaborations ?? []).map((group) => <label key={group.id}><span>{group.displayName} 的 Leader</span><select aria-label={`${group.displayName} 迁移 Leader`} value={legacyLeaderSelections[group.id] ?? ""} onChange={(event) => setLegacyLeaderSelections((current) => ({ ...current, [group.id]: event.target.value }))}><option value="">选择 Agent</option>{orchestration.agents.filter((agent) => !group.memberAgentIds.includes(agent.name)).map((agent) => <option key={agent.name} value={agent.name}>{agent.name}</option>)}</select></label>)}
        <div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setShowLegacyUpgrade(false)}>取消</button><button type="button" className="primary-button" disabled={(orchestration.collaborations ?? []).some((group) => !legacyLeaderSelections[group.id])} onClick={() => {
          if (lockedGroupIds.size) { setNotice("运行中的协作组不能升级"); return; }
          const preview = structuredClone(orchestration);
          try { upgradeLegacyGroups(preview, legacyLeaderSelections); }
          catch (error) { setNotice(error instanceof Error ? error.message : "升级失败"); return; }
          if (commit((next) => { upgradeLegacyGroups(next, legacyLeaderSelections); next.canvas = normalizeCanvasLayout(next.canvas, next); })) {
            setShowLegacyUpgrade(false);
            setActiveScopedGroupId(orchestration.collaborations?.[0]?.id);
          }
        }}>确认升级</button></div>
      </div>
    </div>
  );
  const dissolutionGroup = dissolutionDraft
    ? (orchestration.collaborations ?? []).find((group) => group.id === dissolutionDraft.groupId)
    : undefined;
  const dissolutionError = dissolutionGroup && dissolutionDraft?.plan
    ? dissolutionPlanError(orchestration, dissolutionGroup, dissolutionDraft.plan)
    : undefined;
  const dissolutionDialog = dissolutionGroup && dissolutionDraft && !compact ? (
    <div className="canvas-agent-dialog" role="dialog" aria-modal="true" aria-labelledby="canvas-dissolution-dialog-title">
      <button type="button" className="canvas-agent-dialog-backdrop" aria-label="取消解散协作组" onClick={() => setDissolutionDraft(undefined)} />
      <div className="canvas-agent-dialog-panel collaboration-dissolution-dialog-panel">
        <div className="dialog-heading">
          <div><p className="eyebrow">DISSOLVE COLLABORATION</p><h2 id="canvas-dissolution-dialog-title">解散「{dissolutionGroup.displayName}」</h2></div>
          <button type="button" className="icon-button" aria-label="关闭解散协作组" onClick={() => setDissolutionDraft(undefined)}><X size={16} /></button>
        </div>
        {dissolutionDraft.plan ? <>
          <p className="edge-type-help">该协作组没有可安全自动恢复的快照。请逐条确认入边、成员出边、输入和终止节点；非法或不可达的拓扑不能保存。</p>
          <CollaborationDissolutionPlanner
            orchestration={orchestration}
            group={dissolutionGroup}
            plan={dissolutionDraft.plan}
            onChange={(plan) => setDissolutionDraft((current) => current ? { ...current, plan } : current)}
          />
        </> : <div className="collaboration-dissolution-mapping" aria-label="成组前拓扑恢复预览">
          <section><strong>精确恢复预览 · Workflow revision {dissolutionGroup.formationSnapshot?.workflowRevision}</strong>
            {Object.entries(dissolutionGroup.formationSnapshot?.inboundRoutes ?? {}).map(([source, routes]) => <p key={source}>{source} → {routes.map((edge) => edge.target).join("、")}</p>)}
            {dissolutionGroup.memberAgentIds.map((member) => <p key={member}>{member} → {(dissolutionGroup.formationSnapshot?.memberRoutes[member] ?? []).map((edge) => edge.target).join("、")}</p>)}
            {dissolutionGroup.formationSnapshot?.inputTarget && <p>用户输入 → {dissolutionGroup.formationSnapshot.inputTarget}</p>}
            {dissolutionGroup.formationSnapshot?.terminationAgent && <p>终止 Agent → {dissolutionGroup.formationSnapshot.terminationAgent}</p>}
          </section>
        </div>}
        <p className="edge-type-help">解散仅改变后续 Workflow；Agent、历史运行、Git 分支、PR、commit 与产物都不会删除。</p>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={() => setDissolutionDraft(undefined)}>取消</button>
          <button type="button" className="danger-button" disabled={Boolean(dissolutionError)} onClick={() => applyCollaborationDissolution(dissolutionGroup, dissolutionDraft.plan)}>确认解散</button>
        </div>
      </div>
    </div>
  ) : null;
  const inspector = (
<CanvasInspector
        node={inspectorNode}
        harnessConstraint={activeInspectorAgentId ? agentHarnessConstraint?.(activeInspectorAgentId) : undefined}
        selectedEdge={selectedMemberDefinition ? undefined : selectedEdge}
        agent={selectedAgent}
        definition={selectedDefinition}
        collaboration={selectedMemberDefinition ? undefined : selectedCollaboration}
        scopedCollaboration={selectedMemberDefinition ? undefined : selectedScopedCollaboration}
        collaborationParent={selectedMemberDefinition ? activeMemberCollaboration : undefined}
        collaborationLocked={Boolean((activeMemberCollaboration ?? selectedCollaboration) && lockedGroupIds.has((activeMemberCollaboration ?? selectedCollaboration)!.id))}
        collaborationLockReason={collaborationLockReason}
        onCollaborationChange={updateCollaboration}
        onScopedCollaborationChange={updateScopedCollaboration}
        onDissolveCollaboration={dissolveCollaboration}
        onEnterCollaboration={(id) => setActiveScopedGroupId(id)}
        onEditCollaborationMember={(agentId) => {
          setEditingGroupMemberId(agentId);
          setSelectedEdgeId(undefined);
          setNameDraftInvalid(false);
        }}
        onReturnToCollaboration={() => {
          setEditingGroupMemberId(undefined);
          setNameDraftInvalid(false);
        }}
        orchestration={orchestration}
        onOrchestrationChange={(value) => commit((next) => { Object.assign(next, structuredClone(value)); })}
        gitEnabled={gitEnabled}
        onGitEnabledChange={onGitEnabledChange ? setCanvasGitMode : undefined}
        githubAccounts={githubAccounts}
        githubAccountId={githubAccountId}
        githubAccountsLoading={githubAccountsLoading}
        gitRepositoryName={gitRepositoryName}
        gitRepositoryVisibility={gitRepositoryVisibility}
        onGitRepositoryConfigure={onGitRepositoryNameChange && onGitRepositoryVisibilityChange ? () => openGitRepositoryDialog(false) : undefined}
        readOnly={effectiveReadOnly || layoutBusy || selectedEdgeLocked || Boolean(activeMemberCollaboration && lockedGroupIds.has(activeMemberCollaboration.id)) || Boolean(activeInspectorAgentId && agentIdentityLockedByGroup(activeInspectorAgentId))}
        skills={skills}
        onAddSkill={onAddSkill}
        mcpOptions={mcpOptions}
        mcpDirectory={mcpDirectory}
        gateways={gateways}
        harnesses={harnesses}
        allEdges={model.edges}
        layoutMode={layoutGraphMode}
        onSelectProblemNode={(id) => { setEditingGroupMemberId(undefined); setSelectedId(id); setSelectedEdgeId(undefined); }}
        edges={inspectorNode?.kind === "agent" ? model.edges.filter((edge) => edge.source === inspectorNode.id) : inspectorNode?.kind === "input" ? model.edges.filter((edge) => edge.source === CANVAS_INPUT_NODE_ID) : inspectorNode?.kind === "finish" ? model.edges.filter((edge) => edge.target === CANVAS_FINISH_NODE_ID) : []}
        newEdgeKind={newEdgeKind}
        onNewEdgeKindChange={setNewEdgeKind}
        onRemoveAgent={() => removeAgent()}
        onAgentPatch={updateAgentPatch}
        onDescriptionChange={(description) => {
          if (!activeInspectorAgentId) return;
          if (agentIdentityLockedByGroup(activeInspectorAgentId)) { setNotice(collaborationLockedNotice); return; }
          commit((next) => {
            const definition = next.agents.find((entry) => entry.name === activeInspectorAgentId);
            if (definition) definition.description = description.slice(0, 180);
          });
        }}
        onRenameAgent={renameAgent}
        onRenameValidityChange={setNameDraftInvalid}
        onTemplateChange={(template) => {
          if (!activeInspectorAgentId) return;
          if (agentIdentityLockedByGroup(activeInspectorAgentId)) { setNotice(collaborationLockedNotice); return; }
          commit((next) => {
            const definition = next.agents.find((entry) => entry.name === activeInspectorAgentId);
            if (definition) definition.template = template;
          });
        }}
        onInputTargetChange={updateInputTarget}
        onTerminationAgentChange={updateTerminationAgent}
        onTerminationConditionChange={(condition) => commit((next) => { next.termination.condition = condition; })}
        onDecisionPlanChange={(value) => { if (!activeInspectorAgentId) return; commit((next) => { next.decisionPlans[activeInspectorAgentId] = value; }); }}
        onSessionPersistenceChange={(enabled) => { if (!activeInspectorAgentId || activeInspectorAgentId === "main") return; updateAgentPatch({ sessionPersistence: enabled }); }}
        onWeakDecisionByChange={(decisionBy) => { if (!activeInspectorAgentId || activeInspectorAgentId === "main") return; updateAgentPatch({ decisionBy }); }}
        onEdgeKindChange={updateEdgeKind}
        onEdgeTargetChange={updateEdgeTarget}
        onAddConnection={addConnectionFromInspector}
        onEdgeLayoutChange={updateEdgeLayout}
        onEdgeRemove={removeEdge}
        onLoopChange={updateLoop}
        onAddMcp={addSelectedMcp}
        onToggleMcp={updateSelectedMcp}
      />
  );
  const canvasBody = (
    <div className="workspace workflow-editor-workspace">
      <aside className="left-panel">
        <button type="button" className={`workflow-settings-entry${selectedId === undefined && !selectedEdgeId ? " is-active" : ""}`} onClick={() => { setSelectedId(undefined); setSelectedEdgeId(undefined); setEditingGroupMemberId(undefined); }}><SlidersHorizontal size={15} /><span><strong>流程设置</strong><small>交付、介入与 Git 机制</small></span></button>
        <AgentLibraryPanel orchestration={orchestration} selectedId={selectedId} readOnly={effectiveReadOnly || layoutBusy} gitEnabled={gitEnabled} onSelectMain={() => { setSelectedId("main"); setSelectedEdgeId(undefined); setEditingGroupMemberId(undefined); }} onSelectCollaboration={(id) => { if (orchestration.schemaVersion === 3 && orchestration.scopedWorkflow?.groups.some((group) => group.id === id && group.parentGroupId)) setActiveScopedGroupId(id); else { setSelectedId(id); setSelectedEdgeId(undefined); setEditingGroupMemberId(undefined); } }} onAddCopy={addAgentCopy} onRemoveTemplate={removeAgentTemplate} onShowCreate={() => { setShowAddAgent(true); setNewAgentName(""); setNewAgentDescription(""); setTimeout(() => agentNameInputRef.current?.focus(), 0); }} onShowCreateCollaboration={() => { if (!gitEnabled) { setSelectedId(undefined); setSelectedEdgeId(undefined); setNotice("创建协作组需要先启用 Git 机制"); return; } setNewGroupId(""); setNewGroupDisplayName(""); setNewGroupMembers(new Set()); setNewGroupLeaderId(""); setShowAddCollaboration(true); }} />
        {orchestration.schemaVersion !== 3 && (orchestration.collaborations?.length ?? 0) > 0 && <button type="button" className="workflow-settings-entry" disabled={effectiveReadOnly || lockedGroupIds.size > 0} onClick={() => setShowLegacyUpgrade(true)}>升级旧协作组为组内 Workflow</button>}
        {addAgentDialog}
        {addCollaborationDialog}
        <SavedFlowsPanel flows={savedFlows} activeId={activeSavedFlowId} saving={saving} readOnly={effectiveReadOnly || layoutBusy} onLoad={onLoadSavedFlow} onSave={onSaveSavedFlow} onRename={onRenameSavedFlow} onDelete={onDeleteSavedFlow} onCreate={onCreateSavedFlow} />
        <section className="edge-guide" aria-label="连接类型说明"><div><span className="edge-sample strong" /><span>强边 · 必经执行</span><small>直接执行</small></div><div><span className="edge-sample weak" /><span>弱边 · 可选执行</span><small>Main 决策</small></div></section>
      </aside>
      <section className="canvas-area">
        <CanvasToolbar edgeKind={newEdgeKind} zoom={viewport.zoom} connecting={Boolean(connectionSource)} connectStatus={notice} layoutStatus={layoutMessage} layoutPhase={layoutPhase} readOnly={effectiveReadOnly || layoutBusy} layoutBusy={layoutBusy} canUndo={history.length > 0} canRedo={redoHistory.length > 0 && lockedGroupIds.size === 0} onAddAgent={() => { setShowAddAgent(true); setNewAgentName(""); setNewAgentDescription(""); setTimeout(() => agentNameInputRef.current?.focus(), 0); }} onToggleConnect={() => setNotice("从节点端口拖动到目标端口即可连线")} onEdgeKindChange={setNewEdgeKind} onZoomOut={() => persistViewport(zoomCanvasViewportAt(viewport, { x: viewportSize.width / 2, y: viewportSize.height / 2 }, viewport.zoom - .1))} onResetZoom={() => persistViewport(fitViewport)} onZoomIn={() => persistViewport(zoomCanvasViewportAt(viewport, { x: viewportSize.width / 2, y: viewportSize.height / 2 }, viewport.zoom + .1))} onClear={clearCanvas} onUndo={undo} onRedo={redo} onTidy={() => void applyLayout("tidy")} onLayered={() => void applyLayout("layered")} onFit={() => void applyLayout("fit")} />
        <div className="canvas-world-host">{canvasWorld}</div>
        <CanvasFooter agentCount={model.summary.agentCount} strongEdgeCount={model.summary.strongEdgeCount} weakEdgeCount={model.summary.weakEdgeCount} inputTarget={footerInputTarget} terminationTarget={footerTerminationTarget} currentTarget={footerCurrentTarget} inputConnected={model.summary.inputConnected} terminationConnected={model.summary.terminationConnected} />
      </section>
      {inspectorTabs || inspectorContent ? <aside className="inspector workflow-inspector-host">{inspectorTabs}<div hidden={inspectorContent !== undefined}>{inspector}</div>{inspectorContent}</aside> : inspector}
    </div>
  );
  const repositoryDialog = gitRepositoryDialog && !compact ? (
    <div className="canvas-agent-dialog" role="dialog" aria-modal="true" aria-label="配置 GitHub 仓库">
      <button type="button" className="canvas-agent-dialog-backdrop" aria-label="取消 GitHub 仓库配置" onClick={closeGitRepositoryDialog} />
      <div className="canvas-agent-dialog-panel git-repository-dialog-panel">
        <div className="dialog-heading">
          <div><h2>配置 GitHub 仓库</h2><p>这里只保存创建设置；启动项目后才会真正创建仓库。</p></div>
          <button type="button" className="icon-button" aria-label="关闭 GitHub 仓库配置" onClick={closeGitRepositoryDialog}><X size={16} /></button>
        </div>
        <GitRepositorySettings
          accounts={githubAccounts}
          selectedAccountId={gitRepositoryDialog.accountId}
          accountsLoading={githubAccountsLoading}
          repositoryName={gitRepositoryDialog.repositoryName}
          visibility={gitRepositoryDialog.visibility}
          compact
          onAccountChange={(accountId) => setGitRepositoryDialog((current) => current ? { ...current, accountId } : current)}
          onRepositoryNameChange={(repositoryName) => setGitRepositoryDialog((current) => current ? { ...current, repositoryName } : current)}
          onVisibilityChange={(visibility) => setGitRepositoryDialog((current) => current ? { ...current, visibility } : current)}
        />
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={closeGitRepositoryDialog}>取消</button>
          <button type="button" className="primary-button" disabled={!gitRepositoryDialog.accountId || Boolean(gitRepositoryNameError(gitRepositoryDialog.repositoryName))} onClick={confirmGitRepositoryDialog}>确认设置</button>
        </div>
      </div>
    </div>
  ) : null;
  return <section className={`workflow-canvas-editor canvas-workbench ${compact ? "compact center-preview" : ""} ${className}`} aria-label="Workflow 画布编辑器">{header}{compact ? <div className="compact-canvas-only" role="button" tabIndex={0} aria-label="打开 Workflow 画布编辑器" onClick={() => onOpenTextEditor?.()} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenTextEditor?.(); } }}>{canvasWorld}</div> : activeScopedGroupId && orchestration.schemaVersion === 3 ? <ScopedWorkflowEditor inspectorTabs={inspectorTabs} inspectorContent={inspectorContent} agentHarnessConstraint={agentHarnessConstraint} key={activeScopedGroupId} orchestration={orchestration} agents={agents} groupId={activeScopedGroupId} readOnly={effectiveReadOnly || layoutBusy} lockedGroupIds={lockedGroupIds} skills={skills} onAddSkill={onAddSkill} mcpOptions={mcpOptions} mcpDirectory={mcpDirectory} gateways={gateways} harnesses={harnesses} isAgentLocked={agentIdentityLockedByGroup} onSharedAgentPatch={(id, patch) => updateAgentPatch(patch, id)} onSharedAgentRename={(id, value) => renameAgent(value, id)} onSharedAgentDescriptionChange={(id, value) => { if (agentIdentityLockedByGroup(id)) { setNotice(collaborationLockedNotice); return; } commit((next) => { const definition = next.agents.find((entry) => entry.name === id); if (definition) definition.description = value.slice(0, 180); }); }} onSharedAgentMcpAdd={(id, name, url) => addSelectedMcp(name, url, id)} onSharedAgentMcpToggle={(id, server, enabled) => updateSelectedMcp(server, enabled, id)} onNavigate={setActiveScopedGroupId} onChange={(value) => commit((next) => { Object.assign(next, value); })} /> : canvasBody}{repositoryDialog}{dissolutionDialog}{upgradeLegacyDialog}</section>;
}

/** Adding one card need not reroute every existing edge. */
function routeAddedNodeFromCache(
  cache: (SettledRouteLock & { nodes?: CanvasNode[] }) | undefined,
  edges: readonly CanvasEdge[],
  nodes: readonly CanvasNode[]
): EdgeGeometry[] | undefined {
  if (!cache?.nodes?.length || nodes.length !== cache.nodes.length + 1) return undefined;
  const oldNodes = new Map(cache.nodes.map((node) => [node.id, node]));
  const added = nodes.filter((node) => !oldNodes.has(node.id));
  if (added.length !== 1 || added[0]?.kind !== "agent") return undefined;
  if (!cache.nodes.every((before) => {
    const current = nodes.find((node) => node.id === before.id);
    if (!current || current.x !== before.x || current.y !== before.y) return false;
    const oldSize = canvasNodeSize(before);
    const currentSize = canvasNodeSize(current);
    return oldSize.width === currentSize.width && oldSize.height === currentSize.height;
  })) return undefined;

  const currentEdges = new Map(edges.map((edge) => [edge.id, edge]));
  if (!cache.routes.every((route) => {
    const edge = currentEdges.get(route.edgeId);
    if (!edge || edge.source !== route.source || edge.target !== route.target || edge.fixed !== route.fixed) return false;
    if (route.kind === "main-dispatch") return edge.systemRoute === "main-dispatch";
    return edge.systemRoute !== "main-dispatch"
      && edge.kind === route.kind
      && edge.sourcePort === route.sourceSide && edge.targetPort === route.targetSide
      && edge.sourcePortPinned === route.sourcePinned && edge.targetPortPinned === route.targetPinned;
  })) return undefined;

  const addedNode = added[0]!;
  const size = canvasNodeSize(addedNode);
  const rect = { left: addedNode.x, top: addedNode.y, right: addedNode.x + size.width, bottom: addedNode.y + size.height };
  if (cache.routes.some((route) => polylineIntersectsRect(route.samples, rect))) return undefined;

  const oldIds = new Set(cache.routes.map((route) => route.edgeId));
  const freshEdges = edges.filter((edge) => !oldIds.has(edge.id));
  const fresh = routeCanvasEdges(freshEdges, nodes, { fastEvaluation: true, smoothFallback: true });
  return [...geometryFromRouteLocks(cache.routes), ...fresh];
}

function pendingPathFor(source: Connection, nodes: readonly CanvasNode[], target: { x: number; y: number }): string {
  const node = nodes.find((item) => item.id === source.id);
  if (!node) return "";
  const start = canvasPortPoint(node, source.port);
  return `M ${start.x} ${start.y} C ${start.x + (source.port === "left" ? -70 : 70)} ${start.y}, ${target.x} ${target.y}, ${target.x} ${target.y}`;
}
function routeIndex(edgeId: string, source: string, target: string, routes: WorkflowEdge[]): number {
  const prefix = `${source}->${target}:`; const parsed = edgeId.startsWith(prefix) ? Number(edgeId.slice(prefix.length)) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 && parsed < routes.length ? parsed : routes.findIndex((route) => route.target === target || (target === "finish" && route.target === "finish"));
}
function setCanvasConnection(
  layout: ReturnType<typeof normalizeCanvasLayout>,
  key: "input" | "termination",
  connected: boolean
): void {
  layout.connections = {
    input: key === "input" ? connected : layout.connections?.input !== false,
    termination: key === "termination" ? connected : layout.connections?.termination !== false
  };
}

function workflowCanvasSignature(orchestration: AgentOrchestrationTemplate): string {
  return JSON.stringify({
    agents: orchestration.agents,
    collaborations: orchestration.collaborations,
    input: orchestration.input,
    routes: orchestration.routes,
    loops: orchestration.loops,
    termination: orchestration.termination,
    nodes: orchestration.canvas?.nodes ?? {},
    edges: orchestration.canvas?.edges ?? {},
    connections: orchestration.canvas?.connections,
    viewport: orchestration.canvas?.viewport
  });
}

/** Stable key for absolute route geometry. Topology alone is insufficient:
 * undo can restore node coordinates without changing a single edge. */
function canvasNodeFrameKey(nodes: readonly CanvasNode[]): string {
  return JSON.stringify(
    [...nodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => {
        const size = canvasNodeSize(node);
        return [node.id, node.x, node.y, size.width, size.height];
      })
  );
}

function canvasLayoutPlanCacheKey(
  kind: "layered" | "tidy",
  orchestration: AgentOrchestrationTemplate,
  nodeSizes: Readonly<Record<string, CanvasSize>>,
  viewportSize: CanvasSize
): string {
  return JSON.stringify({
    kind,
    agents: orchestration.agents,
    collaborations: orchestration.collaborations,
    input: orchestration.input,
    routes: orchestration.routes,
    termination: orchestration.termination,
    edges: orchestration.canvas?.edges ?? {},
    connections: orchestration.canvas?.connections,
    ...(kind === "tidy" ? { nodes: orchestration.canvas?.nodes ?? {} } : {}),
    nodeSizes: Object.entries(nodeSizes).sort(([left], [right]) => left.localeCompare(right)),
    viewportSize: {
      width: Math.round(viewportSize.width),
      height: Math.round(viewportSize.height)
    }
  });
}

function sameCanvasViewport(
  left: { x: number; y: number; zoom: number },
  right: { x: number; y: number; zoom: number }
): boolean {
  return Math.abs(left.x - right.x) <= .25
    && Math.abs(left.y - right.y) <= .25
    && Math.abs(left.zoom - right.zoom) <= .002;
}

function interpolateCanvasLayout(
  from: WorkflowCanvasLayout,
  to: WorkflowCanvasLayout,
  progress: number
): WorkflowCanvasLayout {
  const eased = Math.max(0, Math.min(1, progress));
  const next = structuredClone(to);
  next.nodes = Object.fromEntries(Object.keys(to.nodes).map((id) => {
    const target = to.nodes[id]!;
    const start = from.nodes[id] ?? target;
    return [id, {
      x: start.x + (target.x - start.x) * eased,
      y: start.y + (target.y - start.y) * eased
    }];
  }));
  // Port optimization is part of the target layout. Apply it from the first
  // preview frame so every rendered route uses one coherent endpoint model.
  next.edges = structuredClone(to.edges);
  next.viewport = interpolateCanvasViewport(from.viewport, to.viewport, eased);
  return next;
}

function interpolateCanvasViewport(
  from: { x: number; y: number; zoom: number },
  to: { x: number; y: number; zoom: number },
  progress: number
): { x: number; y: number; zoom: number } {
  const value = Math.max(0, Math.min(1, progress));
  return {
    x: from.x + (to.x - from.x) * value,
    y: from.y + (to.y - from.y) * value,
    zoom: from.zoom + (to.zoom - from.zoom) * value
  };
}

function animateCanvasFrames(
  duration: number,
  isCurrent: () => boolean,
  update: (progress: number) => void,
  frameRef: { current: number | undefined }
): Promise<boolean> {
  const reducedMotion = typeof window === "undefined"
    || typeof window.requestAnimationFrame !== "function"
    || (typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  if (reducedMotion) {
    if (!isCurrent()) return Promise.resolve(false);
    update(1);
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let startedAt: number | undefined;
    const frame = (timestamp: number) => {
      if (!isCurrent()) {
        frameRef.current = undefined;
        resolve(false);
        return;
      }
      startedAt ??= timestamp;
      const linear = duration <= 0 ? 1 : Math.min(1, (timestamp - startedAt) / duration);
      const eased = 1 - Math.pow(1 - linear, 3);
      update(eased);
      if (linear < 1) {
        frameRef.current = window.requestAnimationFrame(frame);
      } else {
        frameRef.current = undefined;
        resolve(true);
      }
    };
    frameRef.current = window.requestAnimationFrame(frame);
  });
}

/** Let React publish the busy state before synchronous layout scoring begins. */
function yieldLayoutPlanningTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
