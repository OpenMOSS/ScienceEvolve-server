import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  agentOrchestrationError,
  cloneAgentsConfig,
  defaultAgentConfig,
  DEFAULT_AGENTS,
  DEFAULT_AGENT_ORCHESTRATION
} from "../../lib";
import type {
  AgentOrchestrationTemplate,
  AgentsConfig,
  GatewayRecord,
  GitHubAccountRecord,
  HarnessCatalogEntry
} from "../../types";
import { canvasEdgeId, loopExitCanvasEdgeId, normalizeCanvasLayout } from "./core/canvas-layout";
import { addScopedGroup, upgradeLegacyGroups } from "./core/scoped-workflow";
import * as canvasRouter from "./core/canvas-router";
import { WorkflowCanvasEditor, type CanvasLayoutOperationSnapshot } from "./WorkflowCanvasEditor";
import eightAgentR7Fixture from "../../../../docs/openfars-collaboration/research/fixtures/eight-agent-v2.json";

type HarnessState = {
  orchestration: AgentOrchestrationTemplate;
  agents: AgentsConfig;
};

function renderEditor(
  initialOrchestration: AgentOrchestrationTemplate = structuredClone(DEFAULT_AGENT_ORCHESTRATION),
  initialAgents: AgentsConfig = cloneAgentsConfig(DEFAULT_AGENTS),
  options: {
    onLayoutSnapshot?: (snapshot: CanvasLayoutOperationSnapshot) => void;
    onGeometryObservation?: (observation: import("./core/canvas-geometry-observer").CanvasGeometryObservation) => void;
    onSave?: () => void;
    gateways?: GatewayRecord[];
    harnesses?: HarnessCatalogEntry[];
    gitEnabled?: boolean;
    lockedGroupIds?: ReadonlySet<string>;
  } = {}
) {
  let latest: HarnessState = {
    orchestration: initialOrchestration,
    agents: initialAgents
  };
  const orchestrationChanges = vi.fn();
  const agentChanges = vi.fn();
  let replaceOrchestration: (value: AgentOrchestrationTemplate) => void = (_value) => {
    throw new Error("Editor harness is not mounted");
  };

  function Harness() {
    const [orchestration, setOrchestration] = useState(initialOrchestration);
    const [agents, setAgents] = useState(initialAgents);
    latest = { orchestration, agents };
    replaceOrchestration = setOrchestration;
    return (
      <WorkflowCanvasEditor
        orchestration={orchestration}
        agents={agents}
        onOrchestrationChange={(next) => {
          orchestrationChanges(next);
          setOrchestration(next);
        }}
        onAgentsChange={(next) => {
          agentChanges(next);
          setAgents(next);
        }}
        gateways={options.gateways}
        harnesses={options.harnesses}
        gitEnabled={options.gitEnabled}
        lockedGroupIds={options.lockedGroupIds}
        onLayoutSnapshot={options.onLayoutSnapshot}
        onGeometryObservation={options.onGeometryObservation}
        onSave={options.onSave}
      />
    );
  }

  const view = render(<Harness />);
  return {
    ...view,
    latest: () => latest,
    replaceOrchestration,
    orchestrationChanges,
    agentChanges
  };
}

function edge(container: HTMLElement, id: string): SVGGElement {
  const element = container.querySelector<SVGGElement>(`[data-edge-id="${id}"]`);
  if (!element) throw new Error(`Missing edge ${id}`);
  return element;
}

function port(container: HTMLElement, node: string, side: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(
    `[data-node-id="${node}"] [data-port="${side}"]`
  );
  if (!element) throw new Error(`Missing ${node}:${side} port`);
  return element;
}

function directedLayoutFixture(): AgentOrchestrationTemplate {
  const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
  orchestration.routes = {
    main: [{ target: "idea", kind: "weak" }],
    idea: [{ target: "execution", kind: "strong" }],
    execution: [{ target: "writing", kind: "strong" }],
    writing: [{ target: "review", kind: "strong" }],
    review: [{ target: "finish", kind: "weak" }]
  };
  orchestration.canvas = normalizeCanvasLayout(undefined, orchestration);
  return orchestration;
}

function eightAgentCollaborationFixture(): AgentOrchestrationTemplate {
  return structuredClone(
    eightAgentR7Fixture.orchestration
  ) as unknown as AgentOrchestrationTemplate;
}

function eightAgentConfigs(): AgentsConfig {
  return Object.fromEntries(eightAgentCollaborationFixture().agents.map((definition) => [
    definition.name,
    defaultAgentConfig(definition.name, definition.template ?? "general")
  ]));
}

describe("WorkflowCanvasEditor interactions", () => {
  it("keeps a dense draft interactive before routing completes and commits the release point before a pending animation frame", () => {
    const pendingFrames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { pendingFrames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => pendingFrames.delete(id));
    const workers: Array<{ terminate: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal("Worker", class {
      onmessage = null;
      onerror = null;
      terminate = vi.fn();
      postMessage = vi.fn();
      constructor() { workers.push(this); }
    });
    const route = vi.spyOn(canvasRouter, "routeCanvasEdges");
    try {
      const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
      initial.canvas = normalizeCanvasLayout(undefined, initial);
      const agents = cloneAgentsConfig(DEFAULT_AGENTS);
      for (let index = 0; index < 15; index++) {
        const name = `parallel_${index}`;
        initial.agents.push({ name, template: "general" });
        initial.routes.main.push({ target: name, kind: "weak" });
        initial.routes[name] = [{ target: "main", kind: "weak" }];
        initial.canvas!.nodes[name] = { x: 1200, y: index * 180 };
        agents[name] = defaultAgentConfig(name, "general");
      }
      initial.canvas!.viewport = { x: 0, y: 0, zoom: 1 };
      initial.canvas!.nodes.idea = { x: 100, y: 100 };
      const view = renderEditor(initial, agents);
      expect(route).not.toHaveBeenCalled();
      const originalPathCount = view.container.querySelectorAll("path.workflow-edge").length;
      expect(originalPathCount).toBeGreaterThan(30);
      const world = screen.getByLabelText("Agent 工作流画布");
      const node = view.container.querySelector<HTMLElement>('[data-node-id="idea"]')!;
      fireEvent.pointerDown(node, { pointerId: 901, button: 0, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(world, { pointerId: 901, clientX: 160, clientY: 160 });
      fireEvent.pointerMove(world, { pointerId: 901, clientX: 180, clientY: 180 });
      expect(pendingFrames.size).toBe(1);
      fireEvent.pointerUp(world, { pointerId: 901, clientX: 417, clientY: 429 });
      expect(pendingFrames.size).toBe(0);
      expect(view.latest().orchestration.canvas!.nodes.idea).toEqual({ x: 417, y: 429 });
      expect(view.container.querySelectorAll("path.workflow-edge")).toHaveLength(originalPathCount);
      expect(route).not.toHaveBeenCalled();
      view.unmount();
      expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
    } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });

  it("reuses scoped routes for selection, zoom and inspector edits but updates changed geometry", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(orchestration);
    addScopedGroup(orchestration, {
      id: "research", displayName: "Research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"]
    });
    const view = renderEditor(orchestration, cloneAgentsConfig(DEFAULT_AGENTS), { gitEnabled: true });
    fireEvent.click(view.container.querySelector('[data-node-id="research"]')!);
    fireEvent.click(screen.getByRole("button", { name: "进入组内 Workflow" }));
    const scoped = screen.getByLabelText("Research 组内 Workflow 编辑器");
    const nodeId = orchestration.scopedWorkflow!.groups[0]!.workflow.nodes[0]!.nodeId;
    const incomingId = canvasEdgeId("input", nodeId);
    const paths = () => [...scoped.querySelectorAll("path.workflow-edge")].map((path) => path.getAttribute("d"));
    const before = paths();
    const route = vi.spyOn(canvasRouter, "routeCanvasEdges");
    const scopedCalls = () => route.mock.calls.filter(([, nodes]) => nodes.some((node) => node.id === nodeId));
    try {
      fireEvent.keyDown(edge(scoped, incomingId), { key: "Enter" });
      expect(edge(scoped, incomingId)).toHaveClass("is-selected");
      fireEvent.click(within(scoped).getByRole("button", { name: "缩小画布" }));
      fireEvent.change(screen.getByLabelText("协作组显示名称"), { target: { value: "Renamed" } });
      expect(paths()).toEqual(before);
      expect(scopedCalls()).toHaveLength(0);

      const moved = structuredClone(view.latest().orchestration);
      moved.scopedWorkflow!.groups[0]!.workflow.canvas!.nodes[nodeId]!.x += 90;
      act(() => view.replaceOrchestration(moved));
      expect(scopedCalls()).toHaveLength(1);
      expect(paths()).not.toEqual(before);

      route.mockClear();
      const pinned = structuredClone(view.latest().orchestration);
      pinned.scopedWorkflow!.groups[0]!.workflow.canvas!.edges[incomingId] = {
        sourcePort: "bottom", targetPort: "top", sourcePortPinned: true, targetPortPinned: true
      };
      act(() => view.replaceOrchestration(pinned));
      expect(scopedCalls()).toHaveLength(1);
      expect(edge(scoped, incomingId)).toHaveAttribute("data-edge-source-port", "bottom");
      expect(edge(scoped, incomingId)).toHaveAttribute("data-edge-target-port", "top");
    } finally {
      route.mockRestore();
    }
  });

  it("shows v3 direct Agent and child-group references when legacy member lists are empty", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    orchestration.schemaVersion = 3;
    orchestration.collaborations = [
      { id: "parent", displayName: "Parent", memberAgentIds: [], renamePolicy: "editable" },
      { id: "child", displayName: "Child", memberAgentIds: [], renamePolicy: "editable" }
    ];
    orchestration.scopedWorkflow = {
      schemaVersion: 1,
      rootAgentIds: ["main"],
      groups: [
        { id: "parent", leaderAgentId: "main", allowLeaderReconfiguration: false, workflow: {
          nodes: [
            { kind: "agent", nodeId: "parent_idea", agentId: "idea" },
            { kind: "collaboration", nodeId: "child_ref", groupId: "child" }
          ],
          input: { source: "input", edges: [{ kind: "parallel", target: "parent_idea" }] },
          routes: { parent_idea: [{ kind: "strong", target: "child_ref" }], child_ref: [{ kind: "strong", target: "finish" }] }
        } },
        { id: "child", parentGroupId: "parent", leaderAgentId: "main", allowLeaderReconfiguration: false, workflow: {
          nodes: [{ kind: "agent", nodeId: "child_execution", agentId: "execution" }],
          input: { source: "input", edges: [{ kind: "parallel", target: "child_execution" }] },
          routes: { child_execution: [{ kind: "strong", target: "finish" }] }
        } }
      ]
    };
    orchestration.input.target = "main";
    orchestration.routes = { main: [{ kind: "weak", target: "parent" }], parent: [{ kind: "strong", target: "main" }] };
    orchestration.termination.agent = "main";
    const before = structuredClone(orchestration);
    const view = renderEditor(orchestration, cloneAgentsConfig(DEFAULT_AGENTS), { gitEnabled: true });

    const library = screen.getByLabelText("协作组库");
    expect(within(library).getByText("2 个直接节点 · 根图协作组")).toBeVisible();
    expect(within(library).getByText("1 个直接节点 · 嵌套协作组")).toBeVisible();
    const card = view.container.querySelector<HTMLElement>('[data-node-id="parent"]')!;
    expect(within(card).getByText("2 个直接节点")).toBeVisible();
    fireEvent.click(within(card).getByRole("button", { name: "展开Parent成员" }));
    const members = within(card).getByLabelText("Parent成员摘要");
    expect(within(members).getByText("idea")).toBeVisible();
    expect(within(members).getByText("child")).toBeVisible();
    expect(within(members).getByText("协作组 · child_ref")).toBeVisible();

    fireEvent.click(card);
    const inspector = screen.getByLabelText("协作组属性面板");
    expect(within(inspector).getByText("2 个直接节点")).toBeVisible();
    expect(within(inspector).getByText("Agent · parent_idea")).toBeVisible();
    expect(within(inspector).getByText("协作组 · child_ref")).toBeVisible();
    fireEvent.click(within(inspector).getByRole("button", { name: "进入组内 Workflow" }));
    expect(screen.getByLabelText("Parent 组内 Workflow 编辑器")).toBeVisible();
    expect(view.latest().orchestration).toEqual(before);
    expect(view.orchestrationChanges).not.toHaveBeenCalled();
  });

  it("creates a v3 group without moving outer Agents and navigates its scoped graph", () => {
    const view = renderEditor(structuredClone(DEFAULT_AGENT_ORCHESTRATION), cloneAgentsConfig(DEFAULT_AGENTS), { gitEnabled: true });
    fireEvent.click(screen.getByRole("button", { name: "新增协作组" }));
    const dialog = screen.getByRole("dialog", { name: "新增协作组" });
    fireEvent.change(within(dialog).getByLabelText("新协作组 ID"), { target: { value: "research" } });
    fireEvent.change(within(dialog).getByLabelText("新协作组显示名称"), { target: { value: "Research" } });
    fireEvent.click(within(dialog).getByLabelText("idea"));
    fireEvent.click(within(dialog).getByLabelText("execution"));
    fireEvent.change(within(dialog).getByLabelText("新协作组 Leader"), { target: { value: "main" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建可编排协作组" }));
    expect(view.latest().orchestration.schemaVersion).toBe(3);
    expect(screen.getByLabelText("Research 组内 Workflow 编辑器")).toBeInTheDocument();
    expect(screen.getByText("2 个直接节点 · 2 条并行入口")).toBeInTheDocument();
    fireEvent.click(within(screen.getByLabelText("Research 组内 Workflow 编辑器")).getByRole("button", { name: "缩小画布" }));
    expect(view.latest().orchestration.scopedWorkflow?.groups[0]?.workflow.canvas?.viewport.zoom).toBeLessThan(.82);
    fireEvent.click(screen.getByRole("switch", { name: "允许 Leader 自动调整本组 Workflow" }));
    expect(view.latest().orchestration.scopedWorkflow?.groups[0]?.allowLeaderReconfiguration).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "返回父图" }));
    expect(view.container.querySelector('[data-node-id="idea"]')).not.toBeNull();
    expect(view.container.querySelector('[data-node-id="execution"]')).not.toBeNull();
    expect(view.container.querySelector('[data-node-id="research"]')).not.toBeNull();
    fireEvent.click(view.container.querySelector('[data-node-id="research"]')!);
    fireEvent.click(screen.getByRole("button", { name: "进入组内 Workflow" }));
    expect(screen.getByLabelText("Research 组内 Workflow 编辑器")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回父图" }));
    expect(view.container.querySelector('[data-node-id="idea"]')).not.toBeNull();
  });

  it("uses root canvas tidy and layered planning inside a group with scoped undo", async () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(orchestration);
    addScopedGroup(orchestration, {
      id: "research", displayName: "Research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"]
    });
    const workflow = orchestration.scopedWorkflow!.groups[0]!.workflow;
    const [first, second] = workflow.nodes.map((ref) => ref.nodeId);
    workflow.canvas!.nodes[second!] = { ...workflow.canvas!.nodes[first!]! };
    const before = structuredClone(workflow.canvas);
    const rootCanvas = structuredClone(orchestration.canvas);
    const routes = structuredClone(workflow.routes);
    const input = structuredClone(workflow.input);
    const view = renderEditor(orchestration, cloneAgentsConfig(DEFAULT_AGENTS), { gitEnabled: true });
    fireEvent.click(view.container.querySelector('[data-node-id="research"]')!);
    fireEvent.click(screen.getByRole("button", { name: "进入组内 Workflow" }));
    const scoped = screen.getByLabelText("Research 组内 Workflow 编辑器");

    fireEvent.click(within(scoped).getByRole("button", { name: "智能整理布局" }));
    await waitFor(() => expect(view.latest().orchestration.scopedWorkflow!.groups[0]!.workflow.canvas?.nodes[second!])
      .not.toEqual(before!.nodes[second!]), { timeout: 8_000 });
    expect(view.latest().orchestration.scopedWorkflow!.groups[0]!.workflow.routes).toEqual(routes);
    expect(view.latest().orchestration.scopedWorkflow!.groups[0]!.workflow.input).toEqual(input);
    expect(view.latest().orchestration.canvas).toEqual(rootCanvas);
    expect(edge(scoped, canvasEdgeId("input", first!))).toBeInTheDocument();
    expect(edge(scoped, canvasEdgeId("input", second!))).toBeInTheDocument();
    const tidied = structuredClone(view.latest().orchestration.scopedWorkflow!.groups[0]!.workflow.canvas);
    fireEvent.click(within(scoped).getByRole("button", { name: "撤销" }));
    expect(view.latest().orchestration.scopedWorkflow!.groups[0]!.workflow.canvas).toEqual(before);
    fireEvent.click(within(scoped).getByRole("button", { name: "重做" }));
    expect(view.latest().orchestration.scopedWorkflow!.groups[0]!.workflow.canvas).toEqual(tidied);
    expect(view.latest().orchestration.canvas).toEqual(rootCanvas);
    fireEvent.click(within(scoped).getByRole("button", { name: "撤销" }));

    class ImmediateElk {
      async layout() {
        return { children: Object.entries(before!.nodes).map(([id, point], index) => ({
          id, x: point.x + index * 50, y: point.y + index * 28
        })) };
      }
    }
    window.ELK = ImmediateElk;
    window.__openfarsElkPromise = undefined;
    try {
      fireEvent.click(within(scoped).getByRole("button", { name: "依次执行分层重排、智能整理和适应画布" }));
      await waitFor(() => expect(view.latest().orchestration.scopedWorkflow!.groups[0]!.workflow.canvas?.layoutMode)
        .toBe("layered"), { timeout: 8_000 });
      expect(view.latest().orchestration.scopedWorkflow!.groups[0]!.workflow.routes).toEqual(routes);
      expect(view.latest().orchestration.scopedWorkflow!.groups[0]!.workflow.input).toEqual(input);
      expect(view.latest().orchestration.canvas).toEqual(rootCanvas);
      fireEvent.click(within(scoped).getByRole("button", { name: "撤销" }));
      expect(view.latest().orchestration.scopedWorkflow!.groups[0]!.workflow.canvas).toEqual(before);
    } finally {
      delete window.ELK;
      window.__openfarsElkPromise = undefined;
    }
  });

  it("does not publish a scoped layout that finishes after leaving the group", async () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(orchestration);
    addScopedGroup(orchestration, {
      id: "research", displayName: "Research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"]
    });
    const before = structuredClone(orchestration.scopedWorkflow!.groups[0]!.workflow.canvas);
    let resolveLayout: ((value: { children: Array<{ id: string; x: number; y: number }> }) => void) | undefined;
    class DeferredElk {
      layout() {
        return new Promise<{ children: Array<{ id: string; x: number; y: number }> }>((resolve) => { resolveLayout = resolve; });
      }
    }
    window.ELK = DeferredElk;
    window.__openfarsElkPromise = undefined;
    try {
      const view = renderEditor(orchestration, cloneAgentsConfig(DEFAULT_AGENTS), { gitEnabled: true });
      fireEvent.click(view.container.querySelector('[data-node-id="research"]')!);
      fireEvent.click(screen.getByRole("button", { name: "进入组内 Workflow" }));
      const scoped = screen.getByLabelText("Research 组内 Workflow 编辑器");
      fireEvent.click(within(scoped).getByRole("button", { name: "依次执行分层重排、智能整理和适应画布" }));
      await waitFor(() => expect(resolveLayout).toBeDefined());
      fireEvent.click(within(scoped).getByRole("button", { name: "返回父图" }));
      await act(async () => { resolveLayout!({ children: Object.entries(before!.nodes).map(([id, point]) => ({ id, x: point.x + 120, y: point.y + 60 })) }); });
      expect(view.latest().orchestration.scopedWorkflow!.groups[0]!.workflow.canvas).toEqual(before);
    } finally {
      delete window.ELK;
      window.__openfarsElkPromise = undefined;
    }
  });

  it("labels scoped endpoints and selects each parallel fan-out or finish bundle together", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(orchestration);
    addScopedGroup(orchestration, {
      id: "research", displayName: "Research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"]
    });
    const group = orchestration.scopedWorkflow!.groups.find((item) => item.id === "research")!;
    for (const ref of group.workflow.nodes) group.workflow.routes[ref.nodeId] = [{ target: "finish", kind: "weak" }];
    const view = renderEditor(orchestration, cloneAgentsConfig(DEFAULT_AGENTS), { gitEnabled: true });
    fireEvent.click(view.container.querySelector('[data-node-id="research"]')!);
    fireEvent.click(screen.getByRole("button", { name: "进入组内 Workflow" }));
    const scoped = screen.getByLabelText("Research 组内 Workflow 编辑器");
    expect(within(scoped.querySelector<HTMLElement>('[data-node-id="input"]')!).getByText("进入协作组")).toBeVisible();
    expect(within(scoped.querySelector<HTMLElement>('[data-node-id="finish"]')!).getByText("结束协作组")).toBeVisible();
    const [first, second] = group.workflow.nodes.map((ref) => ref.nodeId);
    const parallelA = edge(scoped, canvasEdgeId("input", first!));
    const parallelB = edge(scoped, canvasEdgeId("input", second!));
    const finishA = edge(scoped, canvasEdgeId(first!, "finish"));
    const finishB = edge(scoped, canvasEdgeId(second!, "finish"));
    expect(parallelA.querySelector(".edge-label.parallel")?.textContent).toBe("并行");

    fireEvent.click(parallelA);
    expect(parallelA).toHaveClass("is-selected");
    expect(parallelB).toHaveClass("is-selected");
    expect(finishA).not.toHaveClass("is-selected");
    fireEvent.click(scoped.querySelector('[data-node-id="finish"]')!);
    expect(finishA).toHaveClass("is-selected");
    expect(finishB).toHaveClass("is-selected");
    expect(parallelA).not.toHaveClass("is-selected");
    fireEvent.click(scoped.querySelector('[data-node-id="input"]')!);
    expect(parallelA).toHaveClass("is-selected");
    expect(parallelB).toHaveClass("is-selected");
    expect(finishA).not.toHaveClass("is-selected");
    expect(within(scoped).getByRole("button", { name: "返回父图" })).toHaveClass("scoped-parent-link");
  });

  it("reuses the outer connection inspector and Loop selection inside a collaboration", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(orchestration);
    addScopedGroup(orchestration, {
      id: "research", displayName: "Research", leaderAgentId: "main",
      memberAgentIds: ["idea", "execution", "writing"]
    });
    const group = orchestration.scopedWorkflow!.groups[0]!;
    const refs = Object.fromEntries(group.workflow.nodes.map((ref) => [ref.kind === "agent" ? ref.agentId : ref.groupId, ref.nodeId]));
    group.workflow.routes[refs.idea!] = [{ target: refs.execution!, kind: "strong" }];
    group.workflow.routes[refs.execution!] = [{ target: refs.idea!, kind: "strong" }];
    group.workflow.routes[refs.writing!] = [{ target: "finish", kind: "weak" }];
    group.workflow.loops = [{ id: "drafting", from: refs.execution!, to: refs.idea!, exitTo: refs.writing!, maxIterations: 3 }];
    const view = renderEditor(orchestration, cloneAgentsConfig(DEFAULT_AGENTS), { gitEnabled: true });
    fireEvent.click(view.container.querySelector('[data-node-id="research"]')!);
    fireEvent.click(screen.getByRole("button", { name: "进入组内 Workflow" }));
    const scoped = screen.getByLabelText("Research 组内 Workflow 编辑器");
    const member = edge(scoped, canvasEdgeId(refs.idea!, refs.execution!));
    const returned = edge(scoped, canvasEdgeId(refs.execution!, refs.idea!));
    const exit = edge(scoped, loopExitCanvasEdgeId("drafting"));
    expect(member).toHaveAttribute("data-loop-role", "member");
    expect(returned).toHaveAttribute("data-loop-role", "return");
    expect(exit).toHaveAttribute("data-loop-role", "exit");
    fireEvent.click(member);
    expect(screen.getByRole("heading", { name: "Loop 配置" })).toBeVisible();
    expect(member).toHaveClass("is-selected");
    expect(returned).toHaveClass("is-selected");
    expect(exit).toHaveClass("is-selected");
    fireEvent.change(screen.getByLabelText("Loop 每批迭代数"), { target: { value: "5" } });
    expect(view.latest().orchestration.scopedWorkflow?.groups[0]?.workflow.loops?.[0]?.maxIterations).toBe(5);
    fireEvent.click(screen.getByRole("button", { name: "删除所选强边并拆开 Loop" }));
    expect(view.latest().orchestration.scopedWorkflow?.groups[0]?.workflow.loops ?? []).toEqual([]);
    expect(view.latest().orchestration.scopedWorkflow?.groups[0]?.workflow.routes[refs.idea!]).toEqual([]);
    expect(scoped.querySelector(`[data-edge-id="${loopExitCanvasEdgeId("drafting")}"]`)).toBeNull();
  });

  it("automatically creates a scoped Loop when a new strong edge closes a cycle", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(orchestration);
    addScopedGroup(orchestration, {
      id: "research", displayName: "Research", leaderAgentId: "main",
      memberAgentIds: ["idea", "execution", "writing"]
    });
    const group = orchestration.scopedWorkflow!.groups[0]!;
    const refs = Object.fromEntries(group.workflow.nodes.map((ref) => [ref.kind === "agent" ? ref.agentId : ref.groupId, ref.nodeId]));
    group.workflow.routes[refs.idea!] = [{ target: refs.execution!, kind: "strong" }];
    group.workflow.routes[refs.execution!] = [];
    const view = renderEditor(orchestration, cloneAgentsConfig(DEFAULT_AGENTS), { gitEnabled: true });
    fireEvent.click(view.container.querySelector('[data-node-id="research"]')!);
    fireEvent.click(screen.getByRole("button", { name: "进入组内 Workflow" }));
    const scoped = screen.getByLabelText("Research 组内 Workflow 编辑器");
    fireEvent.click(scoped.querySelector(`[data-node-id="${refs.execution}"]`)!);
    fireEvent.change(within(scoped).getByLabelText("组内连线目标"), { target: { value: refs.idea } });
    fireEvent.click(within(scoped).getByRole("button", { name: "添加连线" }));

    expect(view.latest().orchestration.scopedWorkflow?.groups[0]?.workflow.loops).toEqual([
      expect.objectContaining({ from: refs.execution, to: refs.idea, exitTo: refs.writing, maxIterations: 3 })
    ]);
    expect(within(scoped).getByText(/已自动创建/)).toBeVisible();
  });

  it("reuses the canvas toolbar and undoes scoped graph edits without losing shared Agent configuration", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(orchestration);
    addScopedGroup(orchestration, {
      id: "research", displayName: "Research", leaderAgentId: "main",
      memberAgentIds: ["idea", "execution", "writing"]
    });
    const group = orchestration.scopedWorkflow!.groups[0]!;
    const refs = Object.fromEntries(group.workflow.nodes.map((ref) => [ref.kind === "agent" ? ref.agentId : ref.groupId, ref.nodeId]));
    group.workflow.routes[refs.idea!] = [{ target: refs.execution!, kind: "strong" }];
    group.workflow.routes[refs.execution!] = [];
    const view = renderEditor(orchestration, cloneAgentsConfig(DEFAULT_AGENTS), { gitEnabled: true });
    fireEvent.click(view.container.querySelector('[data-node-id="research"]')!);
    fireEvent.click(screen.getByRole("button", { name: "进入组内 Workflow" }));
    const scoped = screen.getByLabelText("Research 组内 Workflow 编辑器");
    const toolbar = within(scoped).getByLabelText("画布工具栏");
    expect(within(toolbar).getByRole("button", { name: "引用 Agent" })).toBeVisible();
    expect(within(toolbar).getByRole("button", { name: "撤销" })).toBeDisabled();
    fireEvent.click(scoped.querySelector(`[data-node-id="${refs.execution}"]`)!);
    fireEvent.change(within(scoped).getByLabelText("组内连线目标"), { target: { value: refs.idea } });
    fireEvent.click(within(scoped).getByRole("button", { name: "添加连线" }));
    expect(view.latest().orchestration.scopedWorkflow?.groups[0]?.workflow.loops).toHaveLength(1);
    expect(within(toolbar).getByRole("button", { name: "撤销" })).toBeEnabled();

    fireEvent.click(scoped.querySelector(`[data-node-id="${refs.idea}"]`)!);
    const instructions = within(scoped).getByRole("textbox", { name: "Agent 指令" });
    fireEvent.change(instructions, { target: { value: "保留共享配置" } });
    fireEvent.blur(instructions);
    fireEvent.click(within(screen.getByRole("dialog", { name: "确认修改共享 Agent" }))
      .getByRole("button", { name: "应用到所有引用" }));
    fireEvent.click(within(toolbar).getByRole("button", { name: "撤销" }));
    expect(view.latest().orchestration.scopedWorkflow?.groups[0]?.workflow.routes[refs.execution!]).toEqual([]);
    expect(view.latest().orchestration.scopedWorkflow?.groups[0]?.workflow.loops ?? []).toEqual([]);
    expect(view.latest().agents.idea.instructions).toBe("保留共享配置");
    expect(within(toolbar).getByRole("button", { name: "撤销" })).toBeDisabled();
    expect(within(toolbar).getByRole("button", { name: "重做" })).toBeEnabled();
    const selectedNode = scoped.querySelector(`[data-node-id="${refs.idea}"]`)!;
    const beforeSelection = structuredClone(view.latest().orchestration);
    fireEvent.pointerDown(selectedNode, { pointerId: 9, button: 0, clientX: 80, clientY: 80 });
    fireEvent.pointerUp(selectedNode, { pointerId: 9, button: 0, clientX: 80, clientY: 80 });
    fireEvent.click(selectedNode);
    expect(view.latest().orchestration).toEqual(beforeSelection);
    expect(within(toolbar).getByRole("button", { name: "重做" })).toBeEnabled();
    fireEvent.click(within(toolbar).getByRole("button", { name: "重做" }));
    expect(view.latest().orchestration.scopedWorkflow?.groups[0]?.workflow.loops).toHaveLength(1);
    expect(view.latest().agents.idea.instructions).toBe("保留共享配置");
    fireEvent.click(within(toolbar).getByRole("button", { name: "撤销" }));
    fireEvent.click(within(scoped).getByRole("switch", { name: "允许 Leader 自动调整本组 Workflow" }));
    expect(view.latest().orchestration.scopedWorkflow?.groups[0]?.allowLeaderReconfiguration).toBe(true);
    expect(within(toolbar).getByRole("button", { name: "重做" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(view.latest().orchestration.scopedWorkflow?.groups[0]?.allowLeaderReconfiguration).toBe(false);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    expect(view.latest().orchestration.scopedWorkflow?.groups[0]?.allowLeaderReconfiguration).toBe(true);
    expect(view.latest().agents.idea.instructions).toBe("保留共享配置");
  });

  it("edits the shared Agent from a scoped node only after confirming the effect on every reference", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(orchestration);
    addScopedGroup(orchestration, {
      id: "research", displayName: "Research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"]
    });
    const scopedIdeaId = orchestration.scopedWorkflow!.groups[0]!.workflow.nodes
      .find((ref) => ref.kind === "agent" && ref.agentId === "idea")!.nodeId;
    const view = renderEditor(orchestration, cloneAgentsConfig(DEFAULT_AGENTS), { gitEnabled: true });
    fireEvent.click(view.container.querySelector('[data-node-id="research"]')!);
    fireEvent.click(screen.getByRole("button", { name: "进入组内 Workflow" }));
    fireEvent.click(view.container.querySelector(`[data-node-id="${scopedIdeaId}"]`)!);
    expect(screen.getByText(/这里引用的是同一个 Agent/)).toBeVisible();

    const instructions = screen.getByRole("textbox", { name: "Agent 指令" });
    fireEvent.change(instructions, { target: { value: "共享的新指令" } });
    fireEvent.blur(instructions);
    const confirmation = screen.getByRole("dialog", { name: "确认修改共享 Agent" });
    expect(within(confirmation).getByText(/外层和其他协作组中的所有引用/)).toBeVisible();
    expect(view.latest().agents.idea.instructions).not.toBe("共享的新指令");
    fireEvent.click(within(confirmation).getByRole("button", { name: "取消" }));
    expect(view.latest().agents.idea.instructions).not.toBe("共享的新指令");

    const retry = screen.getByRole("textbox", { name: "Agent 指令" });
    fireEvent.change(retry, { target: { value: "共享的新指令" } });
    fireEvent.blur(retry);
    fireEvent.click(within(screen.getByRole("dialog", { name: "确认修改共享 Agent" }))
      .getByRole("button", { name: "应用到所有引用" }));
    expect(view.latest().agents.idea.instructions).toBe("共享的新指令");
    expect(view.latest().agents.execution.instructions).not.toBe("共享的新指令");
    fireEvent.click(screen.getByRole("button", { name: "返回父图" }));
    fireEvent.click(view.container.querySelector('[data-node-id="idea"]')!);
    expect(screen.getByRole("textbox", { name: "Agent 指令" })).toHaveValue("共享的新指令");
  });

  it("renames the shared Agent across root and scoped references without changing the scoped node identity", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(orchestration);
    addScopedGroup(orchestration, {
      id: "research", displayName: "Research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"]
    });
    const scopedIdeaId = orchestration.scopedWorkflow!.groups[0]!.workflow.nodes
      .find((ref) => ref.kind === "agent" && ref.agentId === "idea")!.nodeId;
    const view = renderEditor(orchestration, cloneAgentsConfig(DEFAULT_AGENTS), { gitEnabled: true });
    fireEvent.click(view.container.querySelector('[data-node-id="research"]')!);
    fireEvent.click(screen.getByRole("button", { name: "进入组内 Workflow" }));
    fireEvent.click(view.container.querySelector(`[data-node-id="${scopedIdeaId}"]`)!);
    const name = screen.getByRole("textbox", { name: "Agent 名称" });
    fireEvent.change(name, { target: { value: "research_idea" } });
    fireEvent.blur(name);
    expect(view.latest().orchestration.agents.some((agent) => agent.name === "idea")).toBe(true);
    fireEvent.click(within(screen.getByRole("dialog", { name: "确认修改共享 Agent" }))
      .getByRole("button", { name: "应用到所有引用" }));
    expect(view.latest().orchestration.agents.some((agent) => agent.name === "research_idea")).toBe(true);
    expect(view.latest().orchestration.scopedWorkflow?.groups[0]?.workflow.nodes)
      .toContainEqual({ kind: "agent", nodeId: scopedIdeaId, agentId: "research_idea" });
    expect(view.latest().orchestration.scopedWorkflow?.rootAgentIds).toContain("research_idea");
    expect(view.latest().agents.research_idea).toBeDefined();
    expect(view.latest().agents.idea).toBeUndefined();
  });

  it("keeps shared Agent editing locked while a scoped group is active", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(orchestration);
    addScopedGroup(orchestration, {
      id: "research", displayName: "Research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"]
    });
    const scopedIdeaId = orchestration.scopedWorkflow!.groups[0]!.workflow.nodes
      .find((ref) => ref.kind === "agent" && ref.agentId === "idea")!.nodeId;
    const view = renderEditor(orchestration, cloneAgentsConfig(DEFAULT_AGENTS), {
      gitEnabled: true, lockedGroupIds: new Set(["research"])
    });
    fireEvent.click(view.container.querySelector('[data-node-id="research"]')!);
    fireEvent.click(screen.getByRole("button", { name: "进入组内 Workflow" }));
    fireEvent.click(view.container.querySelector(`[data-node-id="${scopedIdeaId}"]`)!);
    expect(screen.getByRole("textbox", { name: "Agent 指令" })).toBeDisabled();
    expect(screen.queryByRole("dialog", { name: "确认修改共享 Agent" })).not.toBeInTheDocument();
  });

  it("locks a shared Agent's outer settings while its ancestor group scope runs", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(orchestration);
    addScopedGroup(orchestration, { id: "research", displayName: "Research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"] });
    addScopedGroup(orchestration, { id: "inner", displayName: "Inner", parentGroupId: "research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"] });
    const view = renderEditor(orchestration, cloneAgentsConfig(DEFAULT_AGENTS), { gitEnabled: true, lockedGroupIds: new Set(["research"]) });
    fireEvent.click(view.container.querySelector('[data-node-id="idea"]')!);
    expect(screen.getByRole("textbox", { name: "Agent 指令" })).toBeDisabled();
  });

  it("collects account, repository name and visibility when Git is enabled from the canvas", () => {
    const account: GitHubAccountRecord = {
      id: "gha_11111111111111111111111111111111",
      login: "alice",
      providerUserId: 7,
      status: "ready",
      scopes: ["repo"],
      isDefault: true,
      createdAt: "2026-09-24T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z"
    };
    const onGitEnabledChange = vi.fn();
    const onGitHubAccountChange = vi.fn();
    const onGitRepositoryNameChange = vi.fn();
    const onGitRepositoryVisibilityChange = vi.fn();
    render(
      <WorkflowCanvasEditor
        orchestration={structuredClone(DEFAULT_AGENT_ORCHESTRATION)}
        agents={cloneAgentsConfig(DEFAULT_AGENTS)}
        githubAccounts={[account]}
        githubAccountId={account.id}
        onGitEnabledChange={onGitEnabledChange}
        onGitHubAccountChange={onGitHubAccountChange}
        onGitRepositoryNameChange={onGitRepositoryNameChange}
        onGitRepositoryVisibilityChange={onGitRepositoryVisibilityChange}
        onOrchestrationChange={vi.fn()}
        onAgentsChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /流程设置/ }));
    fireEvent.click(screen.getByRole("switch", { name: "画布启用 Git 机制" }));
    expect(onGitEnabledChange).toHaveBeenCalledWith(true);
    const dialog = screen.getByRole("dialog", { name: "配置 GitHub 仓库" });
    fireEvent.change(within(dialog).getByLabelText("GitHub 仓库名称"), {
      target: { value: "canvas-repository" }
    });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Public 仓库" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("会公开研究过程");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认设置" }));

    expect(onGitHubAccountChange).toHaveBeenCalledWith(account.id);
    expect(onGitRepositoryNameChange).toHaveBeenCalledWith("canvas-repository");
    expect(onGitRepositoryVisibilityChange).toHaveBeenCalledWith("public");
  });

  it("projects eight Agents as six ordinary outer nodes plus one group in compact and full canvases", () => {
    const orchestration = eightAgentCollaborationFixture();
    const expectedCanvasIds = ["input", "main", "research_group", "c", "d", "e", "f", "g", "h", "finish"];
    const full = renderEditor(orchestration, eightAgentConfigs(), {
      gitEnabled: true,
      lockedGroupIds: new Set(["research_group"])
    });
    const nodeIds = [...full.container.querySelectorAll<HTMLElement>(".nodes-layer > [data-node-id]")]
      .map((node) => node.dataset.nodeId);
    expect(nodeIds).toEqual(expectedCanvasIds);
    expect(full.container.querySelector('[data-node-id="a"]')).toBeNull();
    expect(full.container.querySelector('[data-node-id="b"]')).toBeNull();
    expect(full.container.querySelector('[data-edge-id^="main->a:"]')).toBeNull();
    expect(full.container.querySelector('[data-edge-id^="main->b:"]')).toBeNull();
    expect(full.container.querySelector('[data-edge-id^="main->research_group:"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: /删除 (a|b)$/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "新增协作组" }));
    const createDialog = screen.getByRole("dialog", { name: "新增协作组" });
    expect(within(createDialog).getAllByRole("checkbox")).toHaveLength(8);
    const leaderSelect = within(createDialog).getByRole("combobox", { name: "新协作组 Leader" });
    expect(within(leaderSelect).getByRole("option", { name: "main" })).toBeInTheDocument();
    fireEvent.click(within(createDialog).getByRole("button", { name: "关闭" }));

    const groupNode = full.container.querySelector<HTMLElement>('[data-node-id="research_group"]')!;
    expect(groupNode.querySelectorAll(".node-port")).toHaveLength(4);
    fireEvent.click(within(groupNode).getByRole("button", { name: "展开Research group成员" }));
    const nestedMembers = within(groupNode).getByRole("list", { name: "Research group成员摘要" });
    expect(nestedMembers).toHaveTextContent("a");
    expect(nestedMembers).toHaveTextContent("b");
    expect(nestedMembers.querySelector("[data-node-id]")).toBeNull();
    expect(nestedMembers.querySelector(".node-port")).toBeNull();

    fireEvent.click(groupNode);
    const inspector = screen.getByLabelText("协作组属性面板");
    expect(within(inspector).getByRole("status")).toHaveTextContent("运行中不可编辑");
    expect(within(inspector).getByLabelText("协作组显示名称")).toBeDisabled();
    expect(within(inspector).getByLabelText("协作组成员").querySelector("input")).toBeNull();
    fireEvent.click(within(inspector).getByRole("button", { name: "查看组内 Agent a" }));
    expect(screen.getByText("Research group · 组内 Agent")).toBeVisible();
    expect(screen.getByLabelText("a Harness")).toBeDisabled();
    expect(screen.getByRole("button", { name: "返回协作组 Research group" })).toBeVisible();
    expect(within(inspector).queryByRole("button", { name: /删除协作组/ })).toBeNull();
    full.unmount();

    const compact = render(
      <WorkflowCanvasEditor
        orchestration={orchestration}
        agents={eightAgentConfigs()}
        compact
        gitEnabled
        onOrchestrationChange={vi.fn()}
        onAgentsChange={vi.fn()}
      />
    );
    expect([...compact.container.querySelectorAll<HTMLElement>(".nodes-layer > [data-node-id]")]
      .map((node) => node.dataset.nodeId)).toEqual(expectedCanvasIds);
    expect(compact.container.querySelector('[data-node-id="a"]')).toBeNull();
    expect(compact.container.querySelector('[data-node-id="b"]')).toBeNull();
  });

  it("diagnoses Git-off collaboration and never offers an existing-group migration control", () => {
    const orchestration = eightAgentCollaborationFixture();
    expect(agentOrchestrationError(orchestration, false)).toContain("启用 Git 机制");
    const view = renderEditor(orchestration, eightAgentConfigs());
    fireEvent.click(screen.getByRole("button", { name: "新增协作组" }));
    expect(screen.getByText("创建协作组需要先启用 Git 机制")).toBeInTheDocument();
    fireEvent.click(view.container.querySelector('[data-node-id="research_group"]')!);
    const members = screen.getByLabelText("协作组成员");
    expect(within(members).queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /删除协作组/ })).toBeNull();
  });

  it("edits an Agent inside an unlocked collaboration without exposing outer routes", () => {
    const orchestration = eightAgentCollaborationFixture();
    const view = renderEditor(orchestration, eightAgentConfigs(), { gitEnabled: true });

    fireEvent.click(view.container.querySelector('[data-node-id="research_group"]')!);
    fireEvent.click(screen.getByRole("button", { name: "编辑组内 Agent a" }));

    expect(screen.getByText("Research group · 组内 Agent")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "连接" })).not.toBeInTheDocument();
    expect(screen.queryByText("弱边决策")).not.toBeInTheDocument();

    const instructions = screen.getByRole("textbox", { name: "Agent 指令" });
    fireEvent.change(instructions, { target: { value: "更新组内研究指令" } });
    fireEvent.blur(instructions);
    expect(view.latest().agents.a.instructions).toBe("更新组内研究指令");

    const name = screen.getByRole("textbox", { name: "Agent 名称" });
    fireEvent.change(name, { target: { value: "research_a" } });
    fireEvent.blur(name);
    expect(view.latest().orchestration.collaborations?.[0]?.memberAgentIds).toContain("research_a");
    expect(view.latest().orchestration.collaborations?.[0]?.memberAgentIds).not.toContain("a");
    expect(view.latest().agents.research_a).toBeDefined();
    expect(view.latest().agents.a).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "返回协作组 Research group" }));
    expect(screen.getByLabelText("协作组成员")).toHaveTextContent("research_a");
  });

  it("blocks locked-group node movement, incoming/outgoing port edits, edge controls and clear", () => {
    const orchestration = eightAgentCollaborationFixture();
    const beforeRoutes = structuredClone(orchestration.routes);
    const view = renderEditor(orchestration, eightAgentConfigs(), {
      gitEnabled: true,
      lockedGroupIds: new Set(["research_group"])
    });
    const world = screen.getByLabelText("Agent 工作流画布");
    const group = view.container.querySelector<HTMLElement>('[data-node-id="research_group"]')!;

    fireEvent.pointerDown(group, { pointerId: 70, button: 0, clientX: 200, clientY: 180 });
    fireEvent.pointerMove(world, { pointerId: 70, clientX: 360, clientY: 260 });
    fireEvent.pointerUp(world, { pointerId: 70, clientX: 360, clientY: 260 });
    expect(view.latest().orchestration.canvas?.nodes.research_group).toBeUndefined();

    const incomingNeighbor = view.container.querySelector<HTMLElement>('[data-node-id="c"]')!;
    const incomingNeighborLeft = incomingNeighbor.style.left;
    fireEvent.pointerDown(incomingNeighbor, { pointerId: 73, button: 0, clientX: 260, clientY: 180 });
    fireEvent.pointerUp(world, { pointerId: 73, clientX: 420, clientY: 260 });
    expect(incomingNeighbor.style.left).toBe(incomingNeighborLeft);

    fireEvent.pointerDown(port(view.container, "research_group", "right"), {
      pointerId: 71,
      button: 0,
      clientX: 200,
      clientY: 180
    });
    expect(world).not.toHaveClass("is-connecting");

    fireEvent.pointerDown(port(view.container, "input", "right"), {
      pointerId: 72,
      button: 0,
      clientX: 40,
      clientY: 100
    });
    fireEvent.pointerEnter(port(view.container, "research_group", "left"));
    fireEvent.pointerUp(world, { pointerId: 72, clientX: 220, clientY: 180 });
    expect(world).not.toHaveClass("is-connecting");
    expect(view.latest().orchestration.input.target).toBe("c");
    expect(view.latest().orchestration.routes).toEqual(beforeRoutes);

    fireEvent.click(edge(view.container, canvasEdgeId("c", "research_group", 0)));
    expect(screen.getByLabelText("起点连接点")).toBeDisabled();
    expect(screen.getByRole("button", { name: "删除连接" })).toBeDisabled();

    const confirm = vi.spyOn(window, "confirm");
    fireEvent.click(screen.getByRole("button", { name: "清空画布" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(view.latest().orchestration.collaborations).toHaveLength(1);
    expect(view.orchestrationChanges).not.toHaveBeenCalled();
    expect(screen.getAllByText(/完成最终 PR 事实核对前不能修改/).length).toBeGreaterThan(0);
  });

  it("blocks redirecting the termination edge away from a locked group", () => {
    const orchestration = eightAgentCollaborationFixture();
    orchestration.routes.research_group = [{ target: "finish", kind: "weak" }];
    orchestration.routes.h = [];
    orchestration.termination.agent = "research_group";
    orchestration.canvas = normalizeCanvasLayout(undefined, orchestration);
    const view = renderEditor(orchestration, eightAgentConfigs(), {
      gitEnabled: true,
      lockedGroupIds: new Set(["research_group"])
    });

    fireEvent.click(view.container.querySelector('[data-node-id="finish"]')!);
    const termination = screen.getByLabelText("结束节点");
    expect(termination).toHaveValue("research_group");
    fireEvent.change(termination, { target: { value: "h" } });

    expect(view.latest().orchestration.termination.agent).toBe("research_group");
    expect(view.latest().orchestration.routes.research_group).toEqual([
      { target: "finish", kind: "weak" }
    ]);
    expect(screen.getAllByText(/完成最终 PR 事实核对前不能修改/).length).toBeGreaterThan(0);
  });

  it("hides compact member rows without clearing the controlled full-canvas preference", () => {
    const orchestration = eightAgentCollaborationFixture();
    const expanded = new Set(["research_group"]);
    const props = {
      orchestration,
      agents: eightAgentConfigs(),
      expandedGroupIds: expanded,
      onOrchestrationChange: vi.fn(),
      onAgentsChange: vi.fn()
    };
    const view = render(<WorkflowCanvasEditor {...props} compact />);
    expect(view.container.querySelector(".collaboration-member-list")).toBeNull();
    expect(view.container.querySelector(".collaboration-expand-button")).toBeNull();

    view.rerender(<WorkflowCanvasEditor {...props} />);
    expect(screen.getByRole("list", { name: "Research group成员摘要" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起Research group成员" })).toBeInTheDocument();
  });

  it("opens the full editor when any blank area of the compact preview is clicked", () => {
    const onOpen = vi.fn();
    const { container } = render(
      <WorkflowCanvasEditor
        orchestration={structuredClone(DEFAULT_AGENT_ORCHESTRATION)}
        agents={cloneAgentsConfig(DEFAULT_AGENTS)}
        compact
        onOrchestrationChange={vi.fn()}
        onAgentsChange={vi.fn()}
        onOpenTextEditor={onOpen}
      />
    );

    expect(container.querySelector(".edge-hit")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开 Workflow 画布编辑器" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("uses the server Harness catalog, explains disabled entries, and persists the derived route inputs", () => {
    const gatewayId = "gwy_0123456789abcdef0123456789abcdef";
    const gateway: GatewayRecord = {
      id: gatewayId,
      name: "Chat 网关",
      url: "https://gateway.example.test/v1",
      models: ["route-model"],
      defaultModel: "route-model",
      protocol: "chat-completions",
      revision: 1,
      apiKeyConfigured: true,
      test: {
        status: "passed", protocol: "chat-completions", model: "route-model",
        harness: "claude-code", nativeProtocol: "anthropic-messages", routeMode: "proxy",
        routeDirection: "anthropic-messages->chat-completions", probeKind: "adapter-smoke",
        cacheKey: "claude-code-route-model", adapterVersion: "1",
        executableFingerprint: "fixture-claude-code", gatewayRevision: 1,
        routerCompatibilityVersion: "1"
      },
      tests: [
        {
          status: "passed", protocol: "chat-completions", model: "route-model",
          harness: "claude-code", nativeProtocol: "anthropic-messages", routeMode: "proxy",
          routeDirection: "anthropic-messages->chat-completions", probeKind: "route"
        },
        {
          status: "passed", protocol: "chat-completions", model: "route-model",
          harness: "claude-code", nativeProtocol: "anthropic-messages", routeMode: "proxy",
          routeDirection: "anthropic-messages->chat-completions", probeKind: "adapter-smoke",
          cacheKey: "claude-code-route-model", adapterVersion: "1",
          executableFingerprint: "fixture-claude-code", gatewayRevision: 1,
          routerCompatibilityVersion: "1"
        }
      ],
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z"
    };
    const harnesses: HarnessCatalogEntry[] = [
      {
        id: "codex",
        label: "Codex",
        adapterVersion: "1",
        nativeProtocol: "responses",
        purposes: ["workflow", "explainer", "probe"],
        mode: "workflow",
        notes: "Embedded Codex",
        capabilities: {
          structuredEvents: true, toolResults: true, durableSession: true,
          permissionPrompts: ["workspace", "compute", "yolo"], workspaceInputs: true, autoSkills: true,
          officialEvents: true, toolEvents: true, usageEvents: true,
          readOnlyExplainer: true, webSearch: true, skills: true, mcp: true
        },
        available: true
      },
      {
        id: "dsh",
        label: "dsh",
        adapterVersion: "1",
        nativeProtocol: "chat-completions",
        purposes: ["workflow", "probe"],
        mode: "workflow",
        notes: "Embedded dsh",
        capabilities: {
          structuredEvents: true, toolResults: true, durableSession: true,
          permissionPrompts: ["workspace", "compute", "yolo"], workspaceInputs: true, autoSkills: true,
          officialEvents: true, toolEvents: true, usageEvents: true,
          readOnlyExplainer: false, webSearch: true, skills: true, mcp: true
        },
        available: false,
        availabilityReason: "项目内置 dsh 入口不可执行"
      },
      {
        id: "claude-code",
        label: "Claude Code",
        adapterVersion: "1",
        nativeProtocol: "anthropic-messages",
        purposes: ["workflow", "explainer", "probe"],
        mode: "workflow",
        notes: "Embedded Claude Code",
        capabilities: {
          structuredEvents: true, toolResults: true, durableSession: true,
          permissionPrompts: ["workspace"], workspaceInputs: true, autoSkills: false,
          officialEvents: true, toolEvents: true, usageEvents: true,
          readOnlyExplainer: true, webSearch: false, skills: false, mcp: false
        },
        available: true
      }
    ];
    const initialAgents = cloneAgentsConfig(DEFAULT_AGENTS);
    initialAgents.idea.harness = "dsh";
    const view = renderEditor(
      structuredClone(DEFAULT_AGENT_ORCHESTRATION),
      initialAgents,
      { gateways: [gateway], harnesses }
    );

    fireEvent.click(view.container.querySelector('[data-node-id="idea"]')!);
    const harnessSelect = screen.getByLabelText("idea Harness");
    expect(within(harnessSelect).getByRole("option", { name: "dsh · 不可用" })).toBeDisabled();
    expect(screen.getByText("项目内置 dsh 入口不可执行")).toHaveAttribute("role", "alert");

    fireEvent.change(harnessSelect, { target: { value: "claude-code" } });
    fireEvent.change(screen.getByLabelText("idea全局网关"), { target: { value: gatewayId } });

    expect(screen.getByLabelText("idea model")).toHaveValue("");
    expect(screen.getByText("切换网关后需要重新选择 model")).toHaveAttribute("role", "alert");
    fireEvent.change(screen.getByLabelText("idea model"), { target: { value: "route-model" } });

    expect(view.latest().agents.idea).toMatchObject({
      harness: "claude-code",
      gatewayId,
      model: "route-model",
      skills: [],
      autoSkills: [],
      mcpServers: [],
      permission: "workspace",
      webSearch: false
    });
    expect(screen.getByText("已启用自动路由：Anthropic Messages → OpenAI Chat Completions")).toBeVisible();
    expect(view.agentChanges).toHaveBeenCalled();
  });

  it("supports keyboard focus and Enter/Space selection for canvas nodes", () => {
    const view = renderEditor();
    const idea = view.container.querySelector<HTMLElement>('[data-node-id="idea"]')!;
    const execution = view.container.querySelector<HTMLElement>('[data-node-id="execution"]')!;

    expect(idea).toHaveAttribute("tabindex", "0");
    expect(idea).toHaveAccessibleName(/构思智能体 AGENT/);
    idea.focus();
    fireEvent.keyDown(idea, { key: "Enter" });
    expect(idea).toHaveClass("is-selected");

    execution.focus();
    fireEvent.keyDown(execution, { key: " " });
    expect(execution).toHaveClass("is-selected");
    expect(idea).not.toHaveClass("is-selected");
  });

  it("adds a fluorescent highlight to every edge connected to the selected Agent", () => {
    const view = renderEditor();
    const idea = view.container.querySelector<HTMLElement>('[data-node-id="idea"]')!;
    fireEvent.click(idea);

    const edgeGroups = [...view.container.querySelectorAll<SVGGElement>("[data-edge-id]")];
    const connected = edgeGroups.filter((group) =>
      group.dataset.edgeSource === "idea" || group.dataset.edgeTarget === "idea"
    );
    expect(connected.length).toBeGreaterThanOrEqual(3);
    for (const group of connected) {
      expect(group).toHaveClass("is-related-highlight");
      const path = group.querySelector<SVGPathElement>(".workflow-edge");
      expect(path).toHaveClass("is-related-highlight");
      expect(path).toHaveAttribute("marker-end", expect.stringMatching(/-highlight\)$/));
    }

    const unrelated = edgeGroups.find((group) =>
      group.dataset.edgeSource === "main" && group.dataset.edgeTarget === "execution"
    );
    expect(unrelated).toHaveClass("is-unrelated-muted");
    expect(unrelated?.querySelector(".workflow-edge")).not.toHaveClass("is-related-highlight");
  });

  it("highlights only an ordinary selected edge, without selecting its source Agent", () => {
    const view = renderEditor();
    const selected = edge(view.container, canvasEdgeId("idea", "main"));
    fireEvent.click(selected);
    expect(selected).toHaveClass("is-selected");
    expect(view.container.querySelector('[data-node-id="idea"]')).not.toHaveClass("is-selected");
    expect(selected).not.toHaveClass("is-unrelated-muted");
    expect(edge(view.container, canvasEdgeId("input", "idea"))).toHaveClass("is-unrelated-muted");
    expect(edge(view.container, canvasEdgeId("main", "idea"))).toHaveClass("is-unrelated-muted");
  });

  it("emits one shared geometry observation across drag start, live frame and release", () => {
    const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    initial.canvas = normalizeCanvasLayout(undefined, initial);
    const observations: Array<{ phase: string; valid: boolean; edges: Array<{ sourceEndpointDistance: number; targetEndpointDistance: number; midpointSampleDistance: number; unrelatedRouteChanged: boolean }> }> = [];
    const orchestrationChanges = vi.fn();
    function Harness() {
      const [orchestration, setOrchestration] = useState(initial);
      return (
        <WorkflowCanvasEditor
          orchestration={orchestration}
          agents={cloneAgentsConfig(DEFAULT_AGENTS)}
          onOrchestrationChange={(next) => { orchestrationChanges(next); setOrchestration(next); }}
          onAgentsChange={vi.fn()}
          onGeometryObservation={(observation) => observations.push({
            phase: observation.phase,
            valid: observation.valid,
            edges: observation.edges.map((edge) => ({
              sourceEndpointDistance: edge.sourceEndpointDistance,
              targetEndpointDistance: edge.targetEndpointDistance,
              midpointSampleDistance: edge.midpointSampleDistance,
              unrelatedRouteChanged: edge.unrelatedRouteChanged
            }))
          })}
        />
      );
    }
    const view = render(<Harness />);
    const node = view.container.querySelector<HTMLElement>('[data-node-id="idea"]')!;
    const world = screen.getByLabelText("Agent 工作流画布");
    fireEvent.pointerDown(node, { pointerId: 90, button: 0, clientX: 100, clientY: 100 });
    expect(observations.some((frame) => frame.phase === "start")).toBe(true);
    fireEvent.pointerMove(world, { pointerId: 90, clientX: 180, clientY: 150 });
    const pathsAtRelease = Object.fromEntries(
      [...view.container.querySelectorAll<SVGGElement>("[data-edge-id]")].map((edge) => [
        edge.dataset.edgeId!,
        edge.querySelector(".workflow-edge")?.getAttribute("d")
      ])
    );
    fireEvent.pointerUp(world, { pointerId: 90, clientX: 180, clientY: 150 });
    const pathsAfterRelease = Object.fromEntries(
      [...view.container.querySelectorAll<SVGGElement>("[data-edge-id]")].map((edge) => [
        edge.dataset.edgeId!,
        edge.querySelector(".workflow-edge")?.getAttribute("d")
      ])
    );
    expect(observations.some((frame) => frame.phase === "drag")).toBe(true);
    expect(observations.some((frame) => frame.phase === "release")).toBe(true);
    const dragFrames = observations.filter((frame) => frame.phase === "start" || frame.phase === "drag" || frame.phase === "release");
    expect(dragFrames.every((frame) => frame.edges.every((edge) => !edge.unrelatedRouteChanged))).toBe(true);
    expect(dragFrames.every((frame) => frame.edges.every((edge) =>
      edge.sourceEndpointDistance <= .75 && edge.targetEndpointDistance <= .75 && edge.midpointSampleDistance < 1
    ))).toBe(true);
    expect(pathsAfterRelease).toEqual(pathsAtRelease);
    expect(orchestrationChanges).toHaveBeenCalled();
  });

  it.each([2, 3] as const)("adds an Agent and template beyond the old limits in a v%s canvas", schemaVersion => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    const agents = cloneAgentsConfig(DEFAULT_AGENTS);
    for (let index = 0; index < 46; index += 1) {
      const name = `researcher_${index}`;
      orchestration.agents.push({ name, template: "general" });
      orchestration.routes[name] = [{ target: "main", kind: "strong" }];
      orchestration.routes.main.push({ target: name, kind: "weak" });
      orchestration.decisionPlans[name] = "Return verified research to Main.";
      agents[name] = defaultAgentConfig(name, "general");
    }
    orchestration.agentTemplates = Array.from({ length: 50 }, (_, index) => ({ name: `template_${index}`, template: "general" as const }));
    if (schemaVersion === 3) upgradeLegacyGroups(orchestration);
    const view = renderEditor(orchestration, agents, { gitEnabled: schemaVersion === 3 });
    fireEvent.click(screen.getByRole("button", { name: "添加 Agent 模板" }));
    const dialog = screen.getByRole("dialog", { name: "新建 Agent 模板" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Agent 名称" }), { target: { value: "extra_researcher" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "职责说明" }), { target: { value: "Verify the additional research results" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "添加模板和 Agent" }));
    expect(view.latest().orchestration.agents).toHaveLength(52);
    expect(view.latest().orchestration.agentTemplates).toHaveLength(51);
    expect(view.latest().agents.extra_researcher).toBeDefined();
    expect(view.latest().orchestration.routes.main).toContainEqual({ target: "extra_researcher", kind: "weak" });
    if (schemaVersion === 3) expect(view.latest().orchestration.scopedWorkflow!.rootAgentIds).toContain("extra_researcher");
    expect(view.container.querySelector('[data-node-id="extra_researcher"]')).not.toBeNull();
  });

  it("creates a persistent template and an Agent on the canvas", () => {
    const view = renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "添加 Agent 模板" }));
    const dialog = screen.getByRole("dialog", { name: "新建 Agent 模板" });
    const dialogQueries = within(dialog);
    expect(dialogQueries.getByRole("button", { name: "添加模板和 Agent" })).toBeDisabled();
    fireEvent.change(dialogQueries.getByRole("textbox", { name: "Agent 名称" }), {
      target: { value: "verifier_agent" }
    });
    fireEvent.change(dialogQueries.getByRole("textbox", { name: "职责说明" }), {
      target: { value: "核验论证、结果和交付质量" }
    });
    fireEvent.change(dialogQueries.getByRole("combobox", { name: "画布新 Agent 模板" }), {
      target: { value: "review" }
    });
    fireEvent.click(dialogQueries.getByRole("button", { name: "添加模板和 Agent" }));

    const node = view.container.querySelector('[data-node-id="verifier_agent"]');
    expect(node).toHaveTextContent("核验论证、结果和交付质量");
    expect(view.latest().orchestration.agents).toContainEqual({
      name: "verifier_agent",
      template: "review",
      description: "核验论证、结果和交付质量"
    });
    expect(view.latest().agents.verifier_agent).toEqual(DEFAULT_AGENTS.review);
    expect(view.latest().orchestration.routes.verifier_agent).toEqual([]);
    expect(view.container.querySelector('[data-edge-source="verifier_agent"]')).toBeNull();
    expect(view.latest().orchestration.agentTemplates).toContainEqual({
      name: "verifier_agent", template: "review", description: "核验论证、结果和交付质量"
    });
    const library = screen.getByLabelText("Agent 模板库");
    expect(within(library).getByText("verifier_agent")).toBeInTheDocument();

    fireEvent.click(within(library).getByRole("button", { name: "添加 verifier_agent 副本" }));
    expect(view.latest().orchestration.agents.map((entry) => entry.name)).toContain("verifier_agent_copy1");
    expect(view.latest().orchestration.routes.verifier_agent_copy1).toEqual([]);
    expect(view.container.querySelector('[data-edge-source="verifier_agent_copy1"]')).toBeNull();
    expect(view.container.querySelector('[data-node-id="verifier_agent_copy1"]')).toHaveTextContent("verifier_agent（副本1）");
    expect(within(library).queryByText("verifier_agent（副本1）")).not.toBeInTheDocument();

    fireEvent.click(view.container.querySelector('[data-node-id="verifier_agent"]')!);
    fireEvent.click(screen.getByRole("button", { name: "从画布删除 Agent" }));
    expect(view.container.querySelector('[data-node-id="verifier_agent"]')).toBeNull();
    expect(within(library).getByRole("button", { name: "添加 verifier_agent 副本" })).toBeInTheDocument();

    fireEvent.click(within(library).getByRole("button", { name: "删除 verifier_agent 模板" }));
    expect(within(library).queryByText("verifier_agent")).not.toBeInTheDocument();
    expect(view.container.querySelector('[data-node-id="verifier_agent_copy1"]')).not.toBeNull();
  });

  it("uses the library as templates and keeps Main as a single instance", () => {
    const view = renderEditor();
    const library = screen.getByLabelText("Agent 模板库");
    expect(within(library).queryByRole("button", { name: /Main Agent.*副本/ })).not.toBeInTheDocument();
    const originalIdeaPosition = (view.container.querySelector('[data-node-id="idea"]') as HTMLElement).style.cssText;

    const addIdea = within(library).getByRole("button", { name: "添加 构思智能体 副本" });
    fireEvent.click(addIdea);
    fireEvent.click(addIdea);
    fireEvent.click(addIdea);

    expect(view.latest().orchestration.agents.map((entry) => entry.name)).toEqual([
      "main", "idea", "execution", "writing", "review", "idea_copy1", "idea_copy2", "idea_copy3"
    ]);
    expect(view.latest().agents.idea_copy1).toEqual(DEFAULT_AGENTS.idea);
    expect((view.container.querySelector('[data-node-id="idea"]') as HTMLElement).style.cssText).toBe(originalIdeaPosition);
    expect(view.container.querySelector('[data-node-id="idea_copy1"]')).toHaveTextContent("构思智能体（副本1）");
    expect(view.container.querySelector('[data-node-id="idea_copy2"]')).toHaveTextContent("构思智能体（副本2）");
    expect(view.container.querySelector('[data-node-id="idea_copy3"]')).toHaveTextContent("构思智能体（副本3）");
    expect(screen.getByLabelText("Agent 工作流画布")).toHaveAttribute("data-canvas-geometry-valid", "true");
    expect(within(library).queryByText("构思智能体（副本1）")).not.toBeInTheDocument();
    expect(within(library).getAllByText("Main Agent")).toHaveLength(1);
  });

  it("lets the name field become empty while preventing a save until the name is valid", () => {
    const onSave = vi.fn();
    const view = renderEditor(undefined, undefined, { onSave });
    fireEvent.click(view.container.querySelector('[data-node-id="idea"]')!);
    const name = screen.getByRole("textbox", { name: "Agent 名称" });

    fireEvent.change(name, { target: { value: "" } });
    expect(name).toHaveValue("");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "保存流程" })).toBeDisabled();
    fireEvent.blur(name);
    expect(view.latest().orchestration.agents.some((agent) => agent.name === "idea")).toBe(true);

    fireEvent.change(name, { target: { value: "hypothesis" } });
    fireEvent.blur(name);
    expect(view.latest().orchestration.agents.some((agent) => agent.name === "hypothesis")).toBe(true);
    expect(screen.getByRole("button", { name: "保存流程" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "保存流程" }));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("does not recompute canvas geometry when an Agent setting changes", () => {
    const onGeometryObservation = vi.fn();
    const view = renderEditor(undefined, undefined, { onGeometryObservation });
    fireEvent.click(view.container.querySelector('[data-node-id="idea"]')!);
    const before = onGeometryObservation.mock.calls.length;
    const model = screen.getByRole("textbox", { name: "idea model" });
    fireEvent.change(model, { target: { value: "another-model" } });
    expect(view.latest().agents.idea.model).toBe(DEFAULT_AGENTS.idea.model);
    fireEvent.blur(model);
    expect(view.latest().agents.idea.model).toBe("another-model");
    expect(onGeometryObservation).toHaveBeenCalledTimes(before);
  });

  it("adds an outgoing connection from the selected Agent inspector", () => {
    const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    initial.routes.idea = [];
    initial.canvas = normalizeCanvasLayout(undefined, initial);
    const view = renderEditor(initial);

    fireEvent.click(view.container.querySelector('[data-node-id="idea"]')!);
    const target = screen.getByRole("combobox", { name: "连接目标" });
    fireEvent.change(target, { target: { value: "execution" } });
    fireEvent.click(screen.getByRole("button", { name: "添加连接" }));

    expect(view.latest().orchestration.routes.idea).toEqual([
      { target: "execution", kind: "strong" }
    ]);
    expect(view.container.querySelector(`[data-edge-id="${canvasEdgeId("idea", "execution", 0)}"]`)).not.toBeNull();
    expect(view.container.querySelector(".save-state")).toHaveTextContent("有未保存修改");

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(view.latest().orchestration.routes.idea).toEqual([]);
  });

  it("adds and undoes an outgoing connection from a scoped group inspector", () => {
    const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(initial);
    addScopedGroup(initial, {
      id: "research", displayName: "Research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"]
    });
    const beforeGroup = structuredClone(initial.scopedWorkflow!.groups[0]);
    const view = renderEditor(initial, undefined, { gitEnabled: true });
    const beforeAgents = structuredClone(view.latest().agents);

    fireEvent.click(view.container.querySelector('[data-node-id="research"]')!);
    const inspector = screen.getByLabelText("协作组属性面板");
    fireEvent.change(within(inspector).getByRole("combobox", { name: "连接目标" }), { target: { value: "review" } });
    const add = within(inspector).getByRole("button", { name: "添加连接" });
    expect(add).toBeEnabled();
    fireEvent.click(add);

    expect(view.latest().orchestration.routes.research).toEqual([{ target: "review", kind: "strong" }]);
    expect(view.container.querySelector(`[data-edge-id="${canvasEdgeId("research", "review", 0)}"]`)).not.toBeNull();
    expect(view.latest().orchestration.scopedWorkflow!.groups[0]).toEqual(beforeGroup);
    expect(view.latest().agents).toEqual(beforeAgents);
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(view.latest().orchestration.routes.research).toEqual(initial.routes.research);
  });

  it("keeps outgoing connections disabled for a locked scoped group", () => {
    const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(initial);
    addScopedGroup(initial, {
      id: "research", displayName: "Research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"]
    });
    const view = renderEditor(initial, undefined, { gitEnabled: true, lockedGroupIds: new Set(["research"]) });
    fireEvent.click(view.container.querySelector('[data-node-id="research"]')!);
    const inspector = screen.getByLabelText("协作组属性面板");
    expect(within(inspector).getByRole("combobox", { name: "连接目标" })).toBeDisabled();
    const add = within(inspector).getByRole("button", { name: "添加连接" });
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(view.orchestrationChanges).not.toHaveBeenCalled();
  });

  it("clears the local unsaved notice only after a save revision advances", () => {
    function Harness() {
      const [revision, setRevision] = useState(0);
      const [orchestration, setOrchestration] = useState(structuredClone(DEFAULT_AGENT_ORCHESTRATION));
      const [agents, setAgents] = useState(cloneAgentsConfig(DEFAULT_AGENTS));
      return <>
        <WorkflowCanvasEditor
          orchestration={orchestration}
          agents={agents}
          saveRevision={revision}
          onOrchestrationChange={setOrchestration}
          onAgentsChange={setAgents}
        />
        <button type="button" onClick={() => setRevision((value) => value + 1)}>标记已保存</button>
      </>;
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "添加 通用智能体 副本" }));
    expect(screen.getByText("有未保存修改")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "标记已保存" }));
    expect(screen.getByText("已同步")).toBeVisible();
  });

  it("deletes and restores the input presentation edge without changing input semantics", () => {
    const view = renderEditor();
    expect(view.container.querySelector(".flow-summary")).toHaveTextContent("输入：构思智能体");
    expect(view.container.querySelector(".flow-summary")).toHaveTextContent("结束：评审智能体");
    expect(view.container.querySelector(".flow-summary")).toHaveTextContent("当前：构思智能体");
    expect(view.container.querySelector('[data-node-id="input"]')).toHaveTextContent("用户提交的任务、约束和已有资料。");
    expect(view.container.querySelector('[data-node-id="main"]')).toHaveTextContent("理解目标、协调上下文，并在每轮选择一个外层节点。");
    expect(view.container.querySelector('[data-node-id="finish"]')).toHaveTextContent("被指定的终止外层节点完成后进入这里。");
    fireEvent.click(edge(view.container, canvasEdgeId("input", "idea")));
    fireEvent.click(screen.getByRole("button", { name: "删除连接" }));

    expect(view.latest().orchestration.input.target).toBe("idea");
    expect(view.latest().orchestration.canvas?.connections?.input).toBe(false);
    expect(view.container.querySelector('[data-edge-id="input->idea:0"]')).toBeNull();
    expect(view.container.querySelector(".flow-summary")).toHaveTextContent("输入：未连接");

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(view.latest().orchestration.canvas?.connections?.input).not.toBe(false);
    expect(view.container.querySelector('[data-edge-id="input->idea:0"]')).not.toBeNull();
  });

  it("replaces a disconnected termination owner through a drag connection and supports undo", () => {
    const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    initial.routes.idea = [{ target: "main", kind: "weak" }];
    initial.canvas = normalizeCanvasLayout(undefined, initial);
    const view = renderEditor(initial);

    fireEvent.click(edge(view.container, canvasEdgeId("review", "finish", 1)));
    fireEvent.click(screen.getByRole("button", { name: "删除连接" }));
    expect(view.latest().orchestration.canvas?.connections?.termination).toBe(false);

    fireEvent.pointerDown(port(view.container, "idea", "right"), {
      pointerId: 1,
      button: 0,
      clientX: 100,
      clientY: 100
    });
    fireEvent.pointerDown(port(view.container, "finish", "left"), {
      pointerId: 1,
      button: 0,
      clientX: 200,
      clientY: 100
    });

    expect(view.latest().orchestration.termination.agent).toBe("idea");
    expect(view.latest().orchestration.routes.idea).toEqual([
      { target: "main", kind: "weak" },
      { target: "finish", kind: "weak" }
    ]);
    expect(view.latest().orchestration.routes.review).toEqual([
      { target: "main", kind: "weak" }
    ]);
    expect(view.latest().orchestration.canvas?.connections?.termination).toBe(true);
    expect(view.container.querySelector('[data-edge-id="idea->finish:1"]')).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(view.latest().orchestration.termination.agent).toBe("review");
    expect(view.latest().orchestration.canvas?.connections?.termination).toBe(false);
  });

  it("migrates node and edge layout keys on rename and restores both domains with undo", () => {
    const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    initial.canvas = normalizeCanvasLayout(undefined, initial);
    initial.canvas.nodes.idea = { x: 777, y: 333 };
    const originalInputEdge = initial.canvas.edges[canvasEdgeId("input", "idea")]!;
    const view = renderEditor(initial);

    fireEvent.click(view.container.querySelector('[data-node-id="idea"]')!);
    fireEvent.change(screen.getByLabelText("Agent 名称"), {
      target: { value: "hypothesis" }
    });
    fireEvent.blur(screen.getByLabelText("Agent 名称"));

    const renamed = view.latest();
    expect(renamed.orchestration.agents.some((item) => item.name === "hypothesis")).toBe(true);
    expect(renamed.orchestration.input.target).toBe("hypothesis");
    expect(renamed.orchestration.canvas?.nodes.hypothesis).toEqual({ x: 777, y: 333 });
    expect(renamed.orchestration.canvas?.nodes.idea).toBeUndefined();
    expect(renamed.orchestration.canvas?.edges[canvasEdgeId("input", "hypothesis")]).toEqual(originalInputEdge);
    expect(renamed.orchestration.canvas?.edges[canvasEdgeId("input", "idea")]).toBeUndefined();
    expect(renamed.agents.hypothesis).toEqual(DEFAULT_AGENTS.idea);
    expect(renamed.agents.idea).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(view.latest().orchestration.input.target).toBe("idea");
    expect(view.latest().orchestration.canvas?.nodes.idea).toEqual({ x: 777, y: 333 });
    expect(view.latest().agents.idea).toEqual(DEFAULT_AGENTS.idea);
    expect(view.latest().agents.hypothesis).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    expect(view.latest().orchestration).toEqual(renamed.orchestration);
    expect(view.latest().agents).toEqual(renamed.agents);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(view.latest().orchestration.input.target).toBe("idea");
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    expect(view.latest().orchestration.input.target).toBe("hypothesis");
  });

  it("discards root redo when an external workflow revision arrives", () => {
    const view = renderEditor();
    fireEvent.click(view.container.querySelector('[data-node-id="idea"]')!);
    fireEvent.change(screen.getByLabelText("Agent 名称"), { target: { value: "hypothesis" } });
    fireEvent.blur(screen.getByLabelText("Agent 名称"));
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(screen.getByRole("button", { name: "重做" })).toBeEnabled();
    const revised = structuredClone(view.latest().orchestration);
    revised.decisionPlans.idea = "External revision must be retained";
    act(() => view.replaceOrchestration(revised));
    expect(screen.getByRole("button", { name: "重做" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    expect(view.latest().orchestration).toEqual(revised);
  });

  it("selects the whole Loop from any member edge and removes metadata when its cycle is broken", () => {
    const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    initial.routes.idea = [{ target: "execution", kind: "strong" }];
    initial.routes.execution = [{ target: "idea", kind: "strong" }];
    initial.loops = [{
      id: "drafting",
      from: "execution",
      to: "idea",
      maxIterations: 3,
      exitTo: "writing"
    }];
    initial.canvas = normalizeCanvasLayout(undefined, initial);
    const view = renderEditor(initial);

    const returnEdge = edge(view.container, canvasEdgeId("execution", "idea"));
    expect(returnEdge).toHaveAttribute("data-loop-id", "drafting");
    expect(returnEdge).toHaveAttribute("data-loop-role", "return");
    const memberEdge = edge(view.container, canvasEdgeId("idea", "execution"));
    expect(memberEdge).toHaveAttribute("data-loop-role", "member");
    const virtualExit = view.container.querySelector('[data-edge-id="loop:drafting:exit"]');
    expect(virtualExit).not.toBeNull();
    if (!virtualExit) throw new Error("Loop virtual exit edge was not rendered");
    expect(virtualExit).toHaveAttribute("data-loop-role", "exit");
    fireEvent.click(memberEdge);
    expect(memberEdge).toHaveClass("is-selected");
    expect(returnEdge).toHaveClass("is-selected");
    expect(memberEdge).not.toHaveClass("is-unrelated-muted");
    expect(returnEdge).not.toHaveClass("is-unrelated-muted");
    expect(virtualExit).toHaveClass("is-selected");
    expect(virtualExit).not.toHaveClass("is-unrelated-muted");
    expect(view.container.querySelector('[data-edge-source="main"][data-edge-target="writing"]')).toHaveClass("is-unrelated-muted");
    expect(view.container.querySelector('[data-node-id="idea"]')).not.toHaveClass("is-selected");
    fireEvent.change(screen.getByLabelText("Loop 每批迭代数"), { target: { value: "5" } });
    expect(view.latest().orchestration.loops?.[0]?.maxIterations).toBe(5);

    const ideaNode = view.container.querySelector('[data-node-id="idea"]');
    expect(ideaNode).not.toBeNull();
    if (!ideaNode) throw new Error("idea node was not rendered");
    fireEvent.click(ideaNode);
    fireEvent.click(screen.getByRole("button", { name: "从画布删除 Agent" }));
    expect(view.latest().orchestration.agents.some((agent) => agent.name === "idea")).toBe(true);
    expect(screen.getByText(/idea 属于 Loop drafting，请先断开/)).toBeVisible();

    const executionNode = view.container.querySelector('[data-node-id="execution"]');
    expect(executionNode).not.toBeNull();
    if (!executionNode) throw new Error("execution node was not rendered");
    fireEvent.click(executionNode);
    fireEvent.change(screen.getByLabelText("Agent 名称"), { target: { value: "analysis" } });
    fireEvent.blur(screen.getByLabelText("Agent 名称"));
    expect(view.latest().orchestration.loops?.[0]).toMatchObject({
      from: "analysis",
      to: "idea",
      exitTo: "writing"
    });

    fireEvent.click(edge(view.container, canvasEdgeId("analysis", "idea")));
    fireEvent.click(screen.getByRole("button", { name: "删除所选强边并拆开 Loop" }));
    expect(view.latest().orchestration.loops).toEqual([]);
    expect(view.latest().orchestration.routes.analysis).toEqual([]);
    expect(view.container.querySelector('[data-edge-id="loop:drafting:exit"]')).toBeNull();
  });

  it("automatically creates a Loop when a strong edge closes a valid cycle and undoes both together", () => {
    const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    initial.routes.idea = [{ target: "execution", kind: "strong" }];
    initial.routes.execution = [];
    initial.canvas = normalizeCanvasLayout(undefined, initial);
    const view = renderEditor(initial);

    fireEvent.click(view.container.querySelector('[data-node-id="execution"]')!);
    fireEvent.change(screen.getByRole("combobox", { name: "连接目标" }), { target: { value: "idea" } });
    fireEvent.click(screen.getByRole("button", { name: "添加连接" }));

    expect(view.latest().orchestration.loops).toMatchObject([{
      from: "execution", to: "idea", maxIterations: 3, exitTo: "main"
    }]);
    const member = edge(view.container, canvasEdgeId("idea", "execution"));
    const returning = edge(view.container, canvasEdgeId("execution", "idea"));
    expect(member).toHaveAttribute("data-loop-role", "member");
    expect(returning).toHaveAttribute("data-loop-role", "return");
    expect(member).toHaveClass("is-selected");
    expect(returning).toHaveClass("is-selected");
    expect(screen.getByRole("heading", { name: "Loop 配置" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "设为 Loop" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(view.latest().orchestration.loops ?? []).toEqual([]);
    expect(view.latest().orchestration.routes.execution).toEqual([]);
  });

  it("keeps Main dispatch edges non-interactive and cancels pending links on Escape or blur", () => {
    const view = renderEditor();
    const dispatch = edge(view.container, canvasEdgeId("main", "idea"));
    expect(dispatch).not.toHaveAttribute("role");
    expect(dispatch.querySelector(".edge-hit")).toBeNull();
    fireEvent.click(dispatch);
    fireEvent.keyDown(dispatch, { key: "Delete" });
    expect(view.orchestrationChanges).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-edge-id="main->idea:0"]')).not.toBeNull();

    const world = screen.getByLabelText("Agent 工作流画布");
    fireEvent.pointerDown(port(view.container, "idea", "right"), {
      pointerId: 4,
      button: 0,
      clientX: 100,
      clientY: 100
    });
    expect(world).toHaveClass("is-connecting");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(world).not.toHaveClass("is-connecting");

    fireEvent.pointerDown(port(view.container, "idea", "right"), {
      pointerId: 5,
      button: 0,
      clientX: 100,
      clientY: 100
    });
    expect(world).toHaveClass("is-connecting");
    fireEvent.blur(window);
    expect(world).not.toHaveClass("is-connecting");
  });

  it("keeps click-mode active after pointerup and connects to a card edge", () => {
    const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    initial.routes.idea = [];
    initial.canvas = normalizeCanvasLayout(undefined, initial);
    const view = renderEditor(initial);
    const world = screen.getByLabelText("Agent 工作流画布");

    fireEvent.pointerDown(port(view.container, "idea", "right"), {
      pointerId: 20,
      button: 0,
      clientX: 100,
      clientY: 100
    });
    fireEvent.pointerUp(world, { pointerId: 20, clientX: 100, clientY: 100 });
    expect(world).toHaveClass("is-connecting");

    const execution = view.container.querySelector<HTMLElement>('[data-node-id="execution"]')!;
    // The default viewport is 0.82 and execution starts at (490, 260).
    // Click just inside its left card edge rather than on a port.
    fireEvent.pointerDown(execution, {
      pointerId: 21,
      button: 0,
      clientX: 491 * .82,
      clientY: 314 * .82
    });

    expect(world).not.toHaveClass("is-connecting");
    expect(view.latest().orchestration.routes.idea).toEqual([
      { target: "execution", kind: "strong" }
    ]);
  });

  it("keeps a rejected connection target red and shaking after the preview line clears", async () => {
    const view = renderEditor();
    const world = screen.getByLabelText("Agent 工作流画布");
    const idea = view.container.querySelector<HTMLElement>('[data-node-id="idea"]')!;

    fireEvent.pointerDown(port(view.container, "idea", "right"), {
      pointerId: 25,
      button: 0,
      clientX: 100,
      clientY: 100
    });
    fireEvent.pointerEnter(port(view.container, "idea", "left"));
    expect(idea).toHaveClass("is-link-invalid");

    fireEvent.pointerUp(world, { pointerId: 25, clientX: 100, clientY: 100 });

    expect(world).not.toHaveClass("is-connecting");
    expect(idea).not.toHaveClass("is-link-invalid");
    expect(idea).toHaveClass("is-connection-rejected");
    expect(idea).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("出边不能指向自身")).toBeVisible();
    expect(view.orchestrationChanges).not.toHaveBeenCalled();

    await waitFor(() => expect(idea).not.toHaveClass("is-connection-rejected"), { timeout: 1_000 });
  });

  it("clears transient connections and commits the last drag sample on lost capture", () => {
    const view = renderEditor();
    const world = screen.getByLabelText("Agent 工作流画布");
    const sourcePort = port(view.container, "idea", "right");

    fireEvent.pointerDown(sourcePort, { pointerId: 22, button: 0, clientX: 100, clientY: 100 });
    expect(world).toHaveClass("is-connecting");
    fireEvent.pointerCancel(world, { pointerId: 22, clientX: 100, clientY: 100 });
    expect(world).not.toHaveClass("is-connecting");

    fireEvent.pointerDown(sourcePort, { pointerId: 23, button: 0, clientX: 100, clientY: 100 });
    expect(world).toHaveClass("is-connecting");
    fireEvent.lostPointerCapture(world, { pointerId: 23 });
    expect(world).not.toHaveClass("is-connecting");

    const idea = view.container.querySelector<HTMLElement>('[data-node-id="idea"]')!;
    const before = idea.style.left;
    fireEvent.pointerDown(idea, { pointerId: 24, button: 0, clientX: 100, clientY: 100 });
    expect(idea).toHaveClass("is-dragging");
    fireEvent.pointerMove(world, { pointerId: 24, clientX: 185, clientY: 145 });
    fireEvent.lostPointerCapture(world, { pointerId: 24 });
    expect(idea).not.toHaveClass("is-dragging");
    expect(idea.style.left).not.toBe(before);
    expect(view.orchestrationChanges).toHaveBeenCalledTimes(1);
  });

  it("restores node positions and every rendered edge path together on drag undo", () => {
    const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    initial.canvas = normalizeCanvasLayout(undefined, initial);
    const initialPosition = { ...initial.canvas.nodes.idea! };
    const view = renderEditor(initial);
    const world = screen.getByLabelText("Agent 工作流画布");
    const idea = view.container.querySelector<HTMLElement>('[data-node-id="idea"]')!;
    const renderedPaths = () => Object.fromEntries(
      Array.from(view.container.querySelectorAll<SVGGElement>("[data-edge-id]")).map((group) => [
        group.dataset.edgeId!,
        group.querySelector<SVGPathElement>(".workflow-edge")?.getAttribute("d") ?? ""
      ])
    );
    const beforePaths = renderedPaths();

    fireEvent.pointerDown(idea, { pointerId: 64, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(world, { pointerId: 64, clientX: 260, clientY: 205 });
    fireEvent.pointerUp(world, { pointerId: 64, clientX: 260, clientY: 205 });

    expect(view.latest().orchestration.canvas?.nodes.idea).not.toEqual(initialPosition);
    expect(renderedPaths()).not.toEqual(beforePaths);

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));

    expect(view.latest().orchestration.canvas?.nodes.idea).toEqual(initialPosition);
    expect(renderedPaths()).toEqual(beforePaths);
  });

  it("clears node selection on a stationary whitespace click", () => {
    const view = renderEditor();
    const world = screen.getByLabelText("Agent 工作流画布");
    const idea = view.container.querySelector<HTMLElement>('[data-node-id="idea"]')!;
    fireEvent.click(idea);
    expect(idea).toHaveClass("is-selected");
    fireEvent.pointerDown(world, { pointerId: 61, button: 0, clientX: 980, clientY: 760 });
    fireEvent.pointerUp(world, { pointerId: 61, clientX: 980, clientY: 760 });
    expect(idea).not.toHaveClass("is-selected");
    expect(screen.getByText("流程概览")).toBeVisible();
  });

  it("keeps selection when whitespace is dragged to pan", () => {
    const view = renderEditor();
    const world = screen.getByLabelText("Agent 工作流画布");
    const idea = view.container.querySelector<HTMLElement>('[data-node-id="idea"]')!;
    fireEvent.click(idea);
    fireEvent.pointerDown(world, { pointerId: 62, button: 0, clientX: 980, clientY: 760 });
    fireEvent.pointerMove(world, { pointerId: 62, clientX: 990, clientY: 770 });
    fireEvent.pointerUp(world, { pointerId: 62, clientX: 990, clientY: 770 });
    expect(idea).toHaveClass("is-selected");
  });

  it("finishes dragging outside the canvas and ignores another pointer", () => {
    const view = renderEditor();
    const idea = view.container.querySelector<HTMLElement>('[data-node-id="idea"]')!;
    const before = idea.style.left;
    fireEvent.pointerDown(idea, { pointerId: 40, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 41, clientX: 900, clientY: 900 });
    fireEvent.pointerCancel(window, { pointerId: 41 });
    expect(idea.style.left).toBe(before);
    expect(idea).toHaveClass("is-dragging");
    fireEvent.pointerMove(window, { pointerId: 40, clientX: 180, clientY: 120 });
    expect(idea.style.left).not.toBe(before);
    fireEvent.pointerUp(window, { pointerId: 40, clientX: 180, clientY: 120 });
    expect(idea).not.toHaveClass("is-dragging");
    expect(view.orchestrationChanges).toHaveBeenCalledTimes(1);
  });

  it("commits the pointerup position when a quick drag has no final pointermove frame", () => {
    const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    initial.canvas = normalizeCanvasLayout(undefined, initial);
    const initialPosition = { ...initial.canvas.nodes.idea! };
    const view = renderEditor(initial);
    const idea = view.container.querySelector<HTMLElement>('[data-node-id="idea"]')!;
    const world = screen.getByLabelText("Agent 工作流画布");

    fireEvent.pointerDown(idea, { pointerId: 63, button: 0, clientX: 100, clientY: 100 });
    // Browsers may coalesce the last move while the main thread is busy. The
    // release sample must still commit its coordinates immediately.
    fireEvent.pointerUp(world, { pointerId: 63, clientX: 190, clientY: 155 });

    expect(view.latest().orchestration.canvas?.nodes.idea).not.toEqual(initialPosition);
    expect(idea).not.toHaveClass("is-dragging");
    expect(view.orchestrationChanges).toHaveBeenCalledTimes(1);
  });

  it("keeps the released position visible until a controlled host acknowledges it", () => {
    const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    initial.canvas = normalizeCanvasLayout(undefined, initial);
    const onOrchestrationChange = vi.fn();
    const view = render(
      <WorkflowCanvasEditor
        orchestration={initial}
        agents={cloneAgentsConfig(DEFAULT_AGENTS)}
        onOrchestrationChange={onOrchestrationChange}
        onAgentsChange={vi.fn()}
      />
    );
    const world = screen.getByLabelText("Agent 工作流画布");
    const idea = view.container.querySelector<HTMLElement>('[data-node-id="idea"]')!;
    const before = idea.style.left;

    fireEvent.pointerDown(idea, { pointerId: 65, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(world, { pointerId: 65, clientX: 205, clientY: 155 });

    expect(onOrchestrationChange).toHaveBeenCalledTimes(1);
    expect(idea).not.toHaveClass("is-dragging");
    expect(idea.style.left).not.toBe(before);
  });

  it("persists node dragging, canvas panning, zooming, tidy and fit actions", async () => {
    const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    initial.canvas = normalizeCanvasLayout(undefined, initial);
    const initialPosition = { ...initial.canvas.nodes.idea! };
    const view = renderEditor(initial);
    const node = view.container.querySelector<HTMLElement>('[data-node-id="idea"]')!;
    const world = screen.getByLabelText("Agent 工作流画布");

    fireEvent.pointerDown(node, { pointerId: 7, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(world, { pointerId: 7, clientX: 160, clientY: 145 });
    fireEvent.pointerUp(world, { pointerId: 7, clientX: 160, clientY: 145 });
    expect(view.latest().orchestration.canvas?.nodes.idea).not.toEqual(initialPosition);

    const beforePan = { ...view.latest().orchestration.canvas!.viewport };
    fireEvent.pointerDown(world, { pointerId: 8, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(world, { pointerId: 8, clientX: 70, clientY: 45 });
    fireEvent.pointerUp(world, { pointerId: 8, clientX: 70, clientY: 45 });
    expect(view.latest().orchestration.canvas?.viewport.x).toBeCloseTo(beforePan.x + 50);
    expect(view.latest().orchestration.canvas?.viewport.y).toBeCloseTo(beforePan.y + 25);

    const beforeZoom = view.latest().orchestration.canvas!.viewport.zoom;
    fireEvent.click(screen.getByRole("button", { name: "放大画布" }));
    expect(view.latest().orchestration.canvas?.viewport.zoom).toBeGreaterThan(beforeZoom);

    fireEvent.click(screen.getByRole("button", { name: "智能整理布局" }));
    await waitFor(
      () => expect(world).toHaveAttribute("data-canvas-layout-phase", "idle"),
      { timeout: 5_000 }
    );
    expect(view.orchestrationChanges).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "适应画布" }));
    await waitFor(() => expect(view.latest().orchestration.canvas?.viewport.zoom).toBeGreaterThanOrEqual(.08));
  });

  it("fit changes only the viewport and does not create an undo entry", async () => {
    const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    initial.canvas = normalizeCanvasLayout(undefined, initial);
    const before = structuredClone(initial.canvas);
    const view = renderEditor(initial);

    fireEvent.click(screen.getByRole("button", { name: "适应画布" }));
    await waitFor(() => expect(view.orchestrationChanges).toHaveBeenCalledTimes(1));

    expect(view.latest().orchestration.canvas?.nodes).toEqual(before.nodes);
    expect(view.latest().orchestration.canvas?.edges).toEqual(before.edges);
    expect(view.latest().orchestration.canvas?.layoutMode).toBe(before.layoutMode);
    expect(view.latest().orchestration.canvas?.viewport).not.toEqual(before.viewport);
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
    expect(view.agentChanges).not.toHaveBeenCalled();
  });

  it("commits layered layout as one undo boundary", async () => {
    const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    initial.canvas = normalizeCanvasLayout(undefined, initial);
    const before = structuredClone(initial.canvas);
    class ImmediateElk {
      async layout() {
        return {
          children: Object.entries(before.nodes).map(([id, point], index) => ({
            id,
            x: point.x + 40 + index * 3,
            y: point.y + 20
          }))
        };
      }
    }
    window.ELK = ImmediateElk;
    window.__openfarsElkPromise = undefined;
    try {
      const view = renderEditor(initial);
      const world = screen.getByLabelText("Agent 工作流画布");
      const beforeTransform = world.querySelector<HTMLElement>(".workflow-canvas-world")!.style.transform;
      fireEvent.click(screen.getByRole("button", { name: "依次执行分层重排、智能整理和适应画布" }));
      await waitFor(
        () => expect(view.orchestrationChanges).toHaveBeenCalledTimes(1),
        { timeout: 5_000 }
      );
      expect(world).toHaveAttribute("data-canvas-layout-phase", "idle");

      fireEvent.click(screen.getByRole("button", { name: "撤销" }));
      expect(view.latest().orchestration.canvas).toEqual(before);
      expect(world.querySelector<HTMLElement>(".workflow-canvas-world")!.style.transform).toBe(beforeTransform);
      expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
    } finally {
      delete window.ELK;
      window.__openfarsElkPromise = undefined;
    }
  });

  it("emits one atomic layout plan and one synchronized apply phase", async () => {
    const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    initial.canvas = normalizeCanvasLayout(undefined, initial);
    const snapshots: CanvasLayoutOperationSnapshot[] = [];
    class ImmediateElk {
      async layout(graph: Record<string, unknown>) {
        const children = Array.isArray(graph.children)
          ? graph.children as Array<{ id: string }>
          : [];
        return {
          children: children.map((child, index) => ({
            id: child.id,
            x: 80 + index * 260,
            y: 120 + (index % 2) * 140
          }))
        };
      }
    }
    window.ELK = ImmediateElk;
    window.__openfarsElkPromise = undefined;
    try {
      const view = renderEditor(initial, cloneAgentsConfig(DEFAULT_AGENTS), {
        onLayoutSnapshot: (snapshot) => snapshots.push(snapshot)
      });
      const world = screen.getByLabelText("Agent 工作流画布");
      fireEvent.click(screen.getByRole("button", { name: "依次执行分层重排、智能整理和适应画布" }));
      await waitFor(() => expect(world).toHaveAttribute("data-canvas-layout-phase", "idle"), { timeout: 5_000 });

      expect(snapshots.map((snapshot) => snapshot.phase)).toEqual([
        "planning",
        "planned",
        "applying",
        "final"
      ]);
      const planned = snapshots.find((snapshot) => snapshot.phase === "planned");
      const finalViewport = snapshots.find((snapshot) => snapshot.phase === "final");
      expect(Object.keys(planned?.layout?.nodes ?? {})).toEqual(expect.arrayContaining(["input", "main", "idea", "execution", "writing", "review", "finish"]));
      expect(Object.keys(planned?.layout?.edges ?? {})).toEqual(expect.arrayContaining([canvasEdgeId("idea", "main", 0)]));
      expect(planned?.layoutMode).toBe("main-dispatch");
      expect(planned?.movedNodeCount).toBeGreaterThan(0);
      expect(finalViewport?.finalViewport?.zoom).toBeGreaterThanOrEqual(.08);
      expect(view.orchestrationChanges).toHaveBeenCalledTimes(1);
      expect(view.container.querySelector('[data-layout-transition]')).toBeNull();
      const finalPaths = [...view.container.querySelectorAll<SVGPathElement>("[data-edge-id] .workflow-edge")];
      expect(finalPaths.length).toBeGreaterThan(0);
      for (const path of finalPaths) {
        const data = path.getAttribute("d") ?? "";
        expect(data).not.toContain(" L ");
        expect(data.match(/ C /g)?.length ?? 0, data).toBeLessThanOrEqual(2);
      }
    } finally {
      delete window.ELK;
      window.__openfarsElkPromise = undefined;
    }
  });

  it("commits the final frame without scheduling animation when reduced motion is requested", async () => {
    const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    initial.canvas = normalizeCanvasLayout(undefined, initial);
    const originalMatchMedia = window.matchMedia;
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const requestAnimationFrame = vi.fn(() => 1);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => false)
      }))
    });
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: requestAnimationFrame
    });
    try {
      const view = renderEditor(initial);
      const world = screen.getByLabelText("Agent 工作流画布");
      fireEvent.click(screen.getByRole("button", { name: "依次执行分层重排、智能整理和适应画布" }));
      await waitFor(() => expect(world).toHaveAttribute("data-canvas-layout-phase", "idle"), { timeout: 5_000 });

      expect(view.orchestrationChanges).toHaveBeenCalledTimes(1);
      expect(requestAnimationFrame).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
      Object.defineProperty(window, "requestAnimationFrame", { configurable: true, value: originalRequestAnimationFrame });
    }
  });

  it("does not apply a stale layered result after the workflow changes", async () => {
    const initial = directedLayoutFixture();
    let resolveLayout!: (value: { children: Array<{ id: string; x: number; y: number }> }) => void;
    class DeferredElk {
      layout() {
        return new Promise<{ children: Array<{ id: string; x: number; y: number }> }>((resolve) => {
          resolveLayout = resolve;
        });
      }
    }
    window.ELK = DeferredElk;
    window.__openfarsElkPromise = undefined;
    try {
      const view = renderEditor(initial);
      const world = screen.getByLabelText("Agent 工作流画布");
      fireEvent.click(screen.getByRole("button", { name: "依次执行分层重排、智能整理和适应画布" }));
      await waitFor(() => expect(resolveLayout).toBeTypeOf("function"));

      const replacement = structuredClone(view.latest().orchestration);
      replacement.canvas!.nodes.idea = { x: 912, y: 456 };
      act(() => view.replaceOrchestration(replacement));
      await act(async () => {
        resolveLayout({ children: [{ id: "idea", x: 1, y: 2 }] });
        await Promise.resolve();
      });

      await waitFor(() => expect(world).toHaveAttribute("data-canvas-layout-phase", "idle"));
      expect(view.latest().orchestration.canvas?.nodes.idea).toEqual({ x: 912, y: 456 });
      expect(view.orchestrationChanges).not.toHaveBeenCalled();
    } finally {
      delete window.ELK;
      window.__openfarsElkPromise = undefined;
    }
  });

  it("locks editing and zoom during layout, and discards a cancelled pending result", async () => {
    const initial = directedLayoutFixture();
    initial.canvas!.viewport = { x: 80, y: 40, zoom: .6 };
    let resolveLayout!: (value: { children: Array<{ id: string; x: number; y: number }> }) => void;
    class DeferredElk {
      layout() {
        return new Promise<{ children: Array<{ id: string; x: number; y: number }> }>((resolve) => { resolveLayout = resolve; });
      }
    }
    window.ELK = DeferredElk;
    try {
      const view = renderEditor(initial);
      const world = screen.getByLabelText("Agent 工作流画布");
      const beforeTransform = world.querySelector<HTMLElement>(".workflow-canvas-world")!.style.transform;
      fireEvent.click(screen.getByRole("button", { name: "依次执行分层重排、智能整理和适应画布" }));
      await waitFor(() => expect(resolveLayout).toBeTypeOf("function"));
      expect(world).toHaveAttribute("aria-busy", "true");
      expect(screen.getByRole("button", { name: "放大画布" })).toBeDisabled();
      expect(port(view.container, "idea", "right")).toBeDisabled();
      fireEvent.wheel(world, { deltaY: -100, clientX: 100, clientY: 100 });
      expect(view.orchestrationChanges).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(world).toHaveAttribute("aria-busy", "false");
      expect(world.querySelector<HTMLElement>(".workflow-canvas-world")!.style.transform).toBe(beforeTransform);
      await act(async () => {
        resolveLayout({ children: [{ id: "idea", x: 1, y: 2 }] });
        await Promise.resolve();
      });
      expect(view.orchestrationChanges).not.toHaveBeenCalled();
      expect(view.latest().orchestration).toEqual(initial);
    } finally {
      delete window.ELK;
      window.__openfarsElkPromise = undefined;
    }
  });
});
