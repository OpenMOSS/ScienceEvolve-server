import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloneAgentsConfig, DEFAULT_AGENTS, DEFAULT_AGENT_ORCHESTRATION } from "../../lib";
import type { AgentOrchestrationTemplate, WorkflowCanvasPort } from "../../types";
import { ScopedWorkflowEditor } from "./ScopedWorkflowEditor";
import { canvasEdgeId } from "./core/canvas-layout";
import { canvasPortPoint } from "./core/canvas-router";
import { addScopedGroup, upgradeLegacyGroups } from "./core/scoped-workflow";

afterEach(() => vi.restoreAllMocks());

function editor(readOnly = false, useDefaultViewport = false) {
  const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
  upgradeLegacyGroups(initial);
  addScopedGroup(initial, { id: "research", displayName: "Research", leaderAgentId: "main",
    memberAgentIds: ["idea", "execution", "writing"] });
  const group = initial.scopedWorkflow!.groups[0]!;
  const ids = Object.fromEntries(group.workflow.nodes.map(ref => [ref.kind === "agent" ? ref.agentId : ref.groupId, ref.nodeId]));
  group.workflow.routes[ids.idea!] = [];
  group.workflow.canvas!.viewport = useDefaultViewport ? { x: 0, y: 0, zoom: .82 } : { x: 25, y: 30, zoom: .8 };
  group.workflow.canvas!.nodes[ids.idea!] = { x: 160, y: 100 };
  group.workflow.canvas!.nodes[ids.execution!] = { x: 550, y: 100 };
  const change = vi.fn();
  let latest = initial;
  function Harness() {
    const [value, setValue] = useState(initial);
    latest = value;
    return <section className="canvas-workbench" role="dialog" aria-label="Workflow 编辑"><ScopedWorkflowEditor orchestration={value}
      agents={cloneAgentsConfig(DEFAULT_AGENTS)} groupId="research" readOnly={readOnly}
      isAgentLocked={() => false} onChange={next => { change(next); setValue(next); }} onNavigate={vi.fn()}
      onSharedAgentPatch={vi.fn()} onSharedAgentRename={vi.fn()} onSharedAgentDescriptionChange={vi.fn()}
      onSharedAgentMcpAdd={async (_agent, name, url) => ({ name, url })} onSharedAgentMcpToggle={vi.fn()} />
    </section>;
  }
  const view = render(<Harness />);
  const world = screen.getByLabelText("Agent 工作流画布");
  const port = (id: string, side: WorkflowCanvasPort) => view.container.querySelector<HTMLButtonElement>(
    `[data-node-id="${id}"] [data-port="${side}"]`)!;
  const point = (id: string, side: WorkflowCanvasPort) => {
    const layout = latest.scopedWorkflow!.groups[0]!.workflow.canvas!;
    const position = canvasPortPoint(layout.nodes[id]!, side);
    return { clientX: layout.viewport.x + position.x * layout.viewport.zoom,
      clientY: layout.viewport.y + position.y * layout.viewport.zoom };
  };
  const workflow = () => latest.scopedWorkflow!.groups[0]!.workflow;
  const start = () => fireEvent.pointerDown(port(ids.idea!, "right"),
    { pointerId: 41, button: 0, ...point(ids.idea!, "right") });
  return { ...view, world, port, point, ids, workflow, start, change,
    latest: (): AgentOrchestrationTemplate => latest };
}

describe("scoped canvas pointer gestures", () => {
  it("previews a captured drag and connects on release coordinates without hover events", () => {
    const view = editor();
    view.start();
    fireEvent.pointerMove(view.world, { pointerId: 41, ...view.point(view.ids.execution!, "left") });
    expect(view.world.querySelector(".pending-edge")).toBeInTheDocument();
    fireEvent.pointerUp(view.world, { pointerId: 41, ...view.point(view.ids.execution!, "left") });
    expect(view.workflow().routes[view.ids.idea!]).toEqual([{ kind: "strong", target: view.ids.execution }]);
    expect(view.workflow().canvas!.edges[canvasEdgeId(view.ids.idea!, view.ids.execution!)]).toMatchObject({
      sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true
    });
    expect(view.world).not.toHaveClass("is-connecting");
  });

  it("allows a stationary port click followed by a target-node click without dragging that node", () => {
    const view = editor();
    const before = structuredClone(view.workflow().canvas!.nodes[view.ids.execution!]);
    view.start();
    fireEvent.pointerUp(view.world, { pointerId: 41, ...view.point(view.ids.idea!, "right") });
    fireEvent.lostPointerCapture(view.world, { pointerId: 41 });
    const node = view.container.querySelector(`[data-node-id="${view.ids.execution}"]`)!;
    fireEvent.pointerDown(node, { pointerId: 42, button: 0, ...view.point(view.ids.execution!, "left") });
    fireEvent.pointerUp(view.world, { pointerId: 42, ...view.point(view.ids.execution!, "left") });
    expect(view.workflow().routes[view.ids.idea!]).toEqual([{ kind: "strong", target: view.ids.execution }]);
    expect(view.workflow().canvas!.nodes[view.ids.execution!]).toEqual(before);
  });

  it.each(["escape", "pointercancel", "outside-release", "lost-capture"] as const)("cancels a pending link on %s without leaving a hidden connection", mode => {
    const view = editor();
    view.start();
    if (mode === "escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (mode === "pointercancel") fireEvent.pointerCancel(view.world, { pointerId: 41 });
    else if (mode === "lost-capture") fireEvent.lostPointerCapture(view.world, { pointerId: 41 });
    else {
      fireEvent.pointerMove(window, { pointerId: 41, clientX: -80, clientY: -80 });
      fireEvent.pointerUp(window, { pointerId: 41, clientX: -80, clientY: -80 });
    }
    expect(view.world).not.toHaveClass("is-connecting");
    expect(view.world.querySelector(".pending-edge")).toBeNull();
    fireEvent.pointerDown(view.port(view.ids.execution!, "left"),
      { pointerId: 42, button: 0, ...view.point(view.ids.execution!, "left") });
    expect(view.workflow().routes[view.ids.idea!]).toEqual([]);
  });

  it("ignores another pointer's release while the original connection is captured", () => {
    const view = editor();
    view.start();
    fireEvent.pointerUp(view.port(view.ids.execution!, "left"),
      { pointerId: 99, ...view.point(view.ids.execution!, "left") });
    expect(view.workflow().routes[view.ids.idea!]).toEqual([]);
    fireEvent.pointerUp(view.world, { pointerId: 41, ...view.point(view.ids.execution!, "left") });
    expect(view.workflow().routes[view.ids.idea!]).toHaveLength(1);
  });

  it("rejects an input target and clears the drag while preserving all routes", () => {
    const view = editor();
    const before = structuredClone(view.workflow());
    view.start();
    fireEvent.pointerMove(view.world, { pointerId: 41, ...view.point("input", "right") });
    fireEvent.pointerUp(view.world, { pointerId: 41, ...view.point("input", "right") });
    expect(view.workflow()).toEqual(before);
    expect(view.world).not.toHaveClass("is-connecting");
    expect(screen.getByText(/进入协作组只能作为/)).toBeVisible();
  });

  it("finishes read-only panning outside the canvas without persisting a project edit", () => {
    const view = editor(true);
    fireEvent.pointerDown(view.world, { pointerId: 51, button: 0, clientX: 400, clientY: 400 });
    fireEvent.pointerMove(window, { pointerId: 51, clientX: 440, clientY: 425 });
    fireEvent.pointerUp(window, { pointerId: 51, clientX: 440, clientY: 425 });
    expect(view.world.querySelector<HTMLElement>(".workflow-canvas-world")!.style.transform)
      .toContain("translate3d(65px, 55px, 0)");
    expect(view.world).not.toHaveClass("is-panning");
    expect(view.change).not.toHaveBeenCalled();
  });

  it("cancels click-mode connections on whitespace without moving a node", () => {
    const view = editor();
    view.start();
    fireEvent.pointerUp(view.world, { pointerId: 41, ...view.point(view.ids.idea!, "right") });
    fireEvent.click(view.port(view.ids.idea!, "right"));
    expect(view.world).toHaveClass("is-connecting");
    fireEvent.pointerDown(view.world, { pointerId: 42, button: 0, clientX: -80, clientY: -80 });
    fireEvent.pointerUp(view.world, { pointerId: 42, clientX: -80, clientY: -80 });
    expect(view.world).not.toHaveClass("is-connecting");
    expect(view.workflow().routes[view.ids.idea!]).toEqual([]);
  });

  it("uses the toolbar to start or cancel a connection and accepts a keyboard-selected target", () => {
    const view = editor();
    fireEvent.click(screen.getByRole("button", { name: "idea" }));
    const connect = screen.getByRole("button", { name: "拖拽连线" });
    fireEvent.click(connect);
    expect(connect).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(connect);
    expect(view.world).not.toHaveClass("is-connecting");
    fireEvent.click(connect);
    fireEvent.keyDown(view.container.querySelector(`[data-node-id="${view.ids.execution}"]`)!, { key: "Enter" });
    expect(view.workflow().routes[view.ids.idea!]).toEqual([{ kind: "strong", target: view.ids.execution }]);
    expect(view.world).not.toHaveClass("is-connecting");
  });

  it("allows scoped undo and redo inside the surrounding Workflow dialog", () => {
    const view = editor();
    view.start();
    fireEvent.pointerUp(view.world, { pointerId: 41, ...view.point(view.ids.execution!, "left") });
    expect(view.workflow().routes[view.ids.idea!]).toHaveLength(1);
    fireEvent.keyDown(view.world, { key: "z", ctrlKey: true });
    expect(view.workflow().routes[view.ids.idea!]).toEqual([]);
    fireEvent.keyDown(view.world, { key: "z", ctrlKey: true, shiftKey: true });
    expect(view.workflow().routes[view.ids.idea!]).toEqual([{ kind: "strong", target: view.ids.execution }]);
  });

  it("commits the last node-drag sample once when pointer capture is lost", () => {
    const view = editor();
    const node = view.container.querySelector(`[data-node-id="${view.ids.idea}"]`)!;
    fireEvent.pointerDown(node, { pointerId: 61, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(view.world, { pointerId: 61, clientX: 280, clientY: 248 });
    fireEvent.lostPointerCapture(view.world, { pointerId: 61 });
    expect(view.workflow().canvas!.nodes[view.ids.idea!]).toEqual({ x: 260, y: 160 });
    fireEvent.pointerUp(view.world, { pointerId: 61, clientX: 280, clientY: 248 });
    expect(view.change).toHaveBeenCalledTimes(1);
  });

  it("keeps sidebar wheel events separate from canvas zoom and blocks page scrolling during canvas zoom", () => {
    const view = editor(true);
    const initial = view.world.querySelector<HTMLElement>(".workflow-canvas-world")!.style.transform;
    expect(fireEvent.wheel(screen.getByLabelText("组内节点属性"), { deltaY: 120, cancelable: true })).toBe(true);
    expect(view.world.querySelector<HTMLElement>(".workflow-canvas-world")!.style.transform).toBe(initial);
    expect(fireEvent.wheel(view.world, { deltaY: 120, clientX: 300, clientY: 200, cancelable: true })).toBe(false);
    expect(view.world.querySelector<HTMLElement>(".workflow-canvas-world")!.style.transform).not.toBe(initial);
    expect(view.change).not.toHaveBeenCalled();
  });

  it("disables advanced Loop inputs when the group is read-only", () => {
    editor(true);
    for (const name of ["组内 Loop ID", "组内 Loop 返回源", "组内 Loop 入口", "组内 Loop 退出至", "组内 Loop 最大迭代"])
      expect(screen.getByLabelText(name)).toBeDisabled();
  });

  it.each([false, true])("fits a default group viewport without overwriting saved view choices (saved=%s)", saved => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function(this: Element) {
      return this.classList.contains("scoped-canvas-host") ? 800 : 0;
    });
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function(this: Element) {
      return this.classList.contains("scoped-canvas-host") ? 480 : 0;
    });
    const view = editor(true, !saved);
    const transform = view.world.querySelector<HTMLElement>(".workflow-canvas-world")!.style.transform;
    if (saved) expect(transform).toBe("translate3d(25px, 30px, 0) scale(0.8)");
    else {
      const match = transform.match(/translate3d\(([-\d.e]+)px, ([-\d.e]+)px, 0\) scale\(([-\d.e]+)\)/)!;
      expect(match).not.toBeNull();
      const x = Number(match[1]), y = Number(match[2]), zoom = Number(match[3]);
      for (const point of Object.values(view.workflow().canvas!.nodes)) {
        expect(x + point.x * zoom).toBeGreaterThanOrEqual(0);
        expect(y + point.y * zoom).toBeGreaterThanOrEqual(0);
        expect(x + (point.x + 194) * zoom).toBeLessThanOrEqual(800);
        expect(y + (point.y + 92) * zoom).toBeLessThanOrEqual(480);
      }
      expect(view.workflow().canvas!.viewport).toEqual({ x: 0, y: 0, zoom: .82 });
    }
    expect(view.change).not.toHaveBeenCalled();
  });
});
