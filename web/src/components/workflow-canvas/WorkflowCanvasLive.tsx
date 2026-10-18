import { currentScopedGroupRun, scopedGroupDisplayState } from "../../scoped-runtime";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AgentEvent, Project } from "../../types";
import { agentMeta } from "../../lib";
import type { CanvasModel, CanvasNode } from "./core/canvas-model";
import { collaborationProgress } from "./core/collaboration-activity";
import { runtimeNodeLabel, type WorkflowRuntimeState } from "./core/workflow-runtime";
import { scopedGroupName, scopedReferenceDisplayState } from "./core/scoped-runtime-view";

interface WorkflowCanvasLiveProps {
  model: CanvasModel;
  runtime: WorkflowRuntimeState;
  project: Project;
  events: AgentEvent[];
  scopeId?: string;
  selectedNodeId?: string;
  expandedGroupIds?: ReadonlySet<string>;
  onSelectNode?: (node: CanvasNode) => void;
  onToggleGroup?: (nodeId: string) => void;
  onNavigateGroup?: (groupId: string) => void;
  onClose: () => void;
}

function liveGroup(project: Project, node: CanvasNode, scopeId?: string) {
  // Scoped reference IDs are local and may equal a different group's ID.
  if (scopeId && !node.collaboration) return undefined;
  const definition = project.orchestration.schemaVersion === 3
    ? project.orchestration.scopedWorkflow?.groups.find((group) => group.id === (node.collaboration?.id ?? node.id))
    : undefined;
  if (definition) {
    const run = currentScopedGroupRun(project, definition.id);
    const arrivals = (project.scopedArrivals ?? []).filter((arrival) => run && arrival.groupRunId === run.id);
    const latest = new Map([...arrivals].sort((a, b) => a.sequence - b.sequence).map((arrival) => [arrival.targetNodeId, arrival]));
    const leaderAgentId = run?.leaderAgentId ?? definition.leaderAgentId;
    return {
      id: definition.id,
      canEnter: true,
      leaderAgentId,
      state: scopedGroupDisplayState(project, definition.id),
      members: definition.workflow.nodes.map((ref) => {
        const arrival = latest.get(ref.nodeId);
        const state = scopedReferenceDisplayState(project, definition.id, ref.nodeId);
        const child = ref.kind === "collaboration"
          ? project.orchestration.collaborations?.find((group) => group.id === ref.groupId)
          : undefined;
        return { id: ref.nodeId,
          name: ref.kind === "agent" ? agentMeta(ref.agentId, project.orchestration.agents.find((agent) => agent.name === ref.agentId)?.template).name : child?.displayName ?? ref.groupId,
          ...(ref.kind === "collaboration" ? { groupId: ref.groupId } : {}),
          leader: ref.kind === "agent" && ref.agentId === leaderAgentId,
          state, label: arrival || state !== "waiting" ? runtimeNodeLabel(state) : "尚未执行" };
      })
    };
  }
  if (!node.collaboration || project.orchestration.schemaVersion === 3) return undefined;
  const progress = collaborationProgress(project, node.collaboration);
  return { id: node.collaboration.id, canEnter: false, state: progress.state,
    leaderAgentId: progress.groupRun?.leaderAgentId,
    members: progress.members.map((member) => ({ id: member.agentId, name: member.agentId,
      leader: member.agentId === progress.groupRun?.leaderAgentId, state: member.state, label: member.label })) };
}

/** Only presentation fields cross into the standalone canvas; configuration stays with the host. */
export function buildLiveCanvasSnapshot({ model, runtime, project, events, selectedNodeId, expandedGroupIds, scopeId }: Omit<WorkflowCanvasLiveProps, "onSelectNode" | "onClose" | "onToggleGroup" | "onNavigateGroup">) {
  const firstEventAt = Date.parse(events[0]?.ts ?? "");
  const groups = new Map(model.nodes.map((node) => [node.id, liveGroup(project, node, scopeId)]));
  const nodeStates = { ...runtime.nodeStates };
  for (const [nodeId, group] of groups) if (group && (!scopeId || currentScopedGroupRun(project, group.id))) nodeStates[nodeId] = group.state;
  return {
    projectId: project.id,
    scopeId: scopeId ?? null,
    status: project.status,
    phase: project.phase,
    cycle: project.cycle,
    selectedNodeId,
    workflow: {
      name: scopeId ? `${project.title} / ${scopedGroupName(project, scopeId)}` : project.title,
      viewLayout: "free",
      mainAgentId: scopeId ? undefined : "main",
      inputTarget: model.semanticWorkflow.input.target,
      terminationAgentId: model.semanticWorkflow.termination.agent,
      nodes: model.nodes.map((node) => {
        const definition = project.orchestration.agents.find((agent) => agent.name === node.name);
        const meta = agentMeta(node.name, node.template ?? "general");
        const group = groups.get(node.id);
        return {
          id: node.id,
          type: node.kind === "finish" ? "end" : node.kind === "input" ? "input" : group ? "collaboration" : node.name === "main" ? "main" : "agent",
          name: node.kind === "input" ? scopeId ? "进入协作组" : "用户输入" : node.kind === "finish" ? scopeId ? "结束协作组" : "结束" : group ? node.displayName ?? node.collaboration?.displayName ?? group.id : node.name === "main" ? "Main Agent" : meta.name,
          description: node.kind === "input" ? "本次课题输入" : node.kind === "finish" ? "真实终止路径" : group ? `${group.members.length} 个节点协作` : definition?.description ?? meta.description,
          model: project.agents[node.name]?.model ?? "",
          color: node.kind === "input" ? "blue" : node.kind === "finish" ? "rose" : group ? "violet" : node.name === "main" ? "green" : "teal",
          ...(group ? { groupId: group.id, leaderAgentId: group.leaderAgentId, canEnter: group.canEnter, members: group.members, expanded: expandedGroupIds?.has(group.id) ?? false } : {}),
          x: node.x,
          y: node.y
        };
      }),
      edges: model.edges.map((edge) => {
        const loop = edge.loop ? runtime.loopStates[edge.loop.id] : undefined;
        const label = edge.loop
          ? `${edge.loop.role === "return" ? "↻" : edge.loop.role === "exit" ? "批次退出" : "Loop"} ${edge.loop.id} · B${loop?.batch ?? 0} · ${loop?.iteration ?? 0}/${edge.loop.maxIterations} · Σ${loop?.totalIterations ?? 0}`
          : undefined;
        return { ...edge, termination: edge.kind === "termination", runtimeState: runtime.edgeStates[edge.id] ?? "configured", runtimeLabel: label };
      })
    },
    nodeStates,
    nodeLabels: Object.fromEntries(model.nodes.map((node) => [node.id, runtimeNodeLabel(nodeStates[node.id])])),
    nodeResults: Object.fromEntries(model.nodes.map((node) => [node.id, {
      text: runtime.nodeReasons[node.id] ?? `累计执行 ${runtime.executionCounts[node.id] ?? 0} 次`,
      tone: nodeStates[node.id] === "failed" || nodeStates[node.id] === "interrupted" ? "warning" : "neutral"
    }])),
    currentNodeId: runtime.currentNodeId,
    logs: events.slice(-100).map((event) => ({
      seq: event.seq,
      type: event.type,
      at: Number.isFinite(firstEventAt) ? Math.max(0, Date.parse(event.ts) - firstEventAt) || 0 : 0,
      message: event.message || `${event.agent ?? "课题"} · ${event.type}`
    }))
  };
}

export function WorkflowCanvasLive(props: WorkflowCanvasLiveProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const snapshot = useMemo(() => buildLiveCanvasSnapshot(props), [props.model, props.runtime, props.project, props.events, props.selectedNodeId, props.expandedGroupIds, props.scopeId]);
  const sendSnapshot = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: "scienceevolve.workflow.runtime.snapshot", snapshot }, window.location.origin);
  }, [snapshot]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return;
      if (event.data?.type === "scienceevolve.workflow.runtime.ready") sendSnapshot();
      if (event.data?.type === "scienceevolve.workflow.runtime.close") props.onClose();
      // An action queued by the previous scope must not select a same-named
      // reference in the newly opened group. Old root frames omit scopeId.
      if ((event.data?.scopeId ?? null) !== (props.scopeId ?? null)) return;
      if (event.data?.type === "scienceevolve.workflow.runtime.select") {
        const node = props.model.nodes.find((item) => item.id === event.data.nodeId);
        if (node) props.onSelectNode?.(node);
      }
      if (event.data?.type === "scienceevolve.workflow.runtime.toggle-group" || event.data?.type === "scienceevolve.workflow.runtime.navigate-group") {
        const node = props.model.nodes.find((item) => item.id === event.data.nodeId);
        const group = node && liveGroup(props.project, node, props.scopeId);
        if (!group) return;
        if (event.data.type === "scienceevolve.workflow.runtime.toggle-group") props.onToggleGroup?.(group.id);
        else if (group.canEnter) {
          const target = event.data.groupId;
          const definition = props.project.orchestration.scopedWorkflow?.groups.find((item) => item.id === group.id);
          if (target === group.id || definition?.workflow.nodes.some((ref) => ref.kind === "collaboration" && ref.groupId === target)) {
            props.onNavigateGroup?.(target);
          }
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [props.model.nodes, props.project, props.scopeId, props.onSelectNode, props.onToggleGroup, props.onNavigateGroup, props.onClose, sendSnapshot]);

  useEffect(sendSnapshot, [sendSnapshot]);

  return <iframe
    key={props.project.id}
    ref={frameRef}
    className="workflow-runtime-live-frame"
    title="运行 Workflow 大画布"
    aria-label="运行 Workflow 大画布"
    src={`${import.meta.env.BASE_URL}workflow-canvas-demo/index.html?runtime=1&project=${encodeURIComponent(props.project.id)}`}
    onLoad={sendSnapshot}
  />;
}
