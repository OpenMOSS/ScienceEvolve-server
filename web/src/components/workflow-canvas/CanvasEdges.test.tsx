import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CanvasEdges, type CanvasEdgeGeometry } from "./CanvasEdges";

function edge(id: string, loopId?: string): CanvasEdgeGeometry {
  return {
    id,
    source: id.split("-")[0],
    target: id.split("-")[1],
    path: "M 0 0 L 100 0",
    midpoint: { x: 50, y: 0 },
    kind: "strong",
    ...(loopId ? { loop: { id: loopId, role: "member" as const, maxIterations: 3, exitTo: "main", virtual: false } } : {})
  };
}

function loopExit(id: string): CanvasEdgeGeometry {
  return {
    ...edge("b-main"),
    id: `loop:${id}:exit`,
    fixed: true,
    loop: { id, role: "exit", maxIterations: 3, exitTo: "main", virtual: true }
  };
}

describe("CanvasEdges Loop presentation", () => {
  it("keeps every dense connection selectable while bounding decorative motion during group selection and dragging", () => {
    const edges = Array.from({ length: 100 }, (_, index) => edge(`a-${index}`));
    const props = { edges, focusedNodeId: "a", relatedEdgeIds: new Set(edges.map((edge) => edge.id)), selectedEdgeIds: new Set(edges.map((edge) => edge.id)) };
    const view = render(<CanvasEdges {...props} />);
    expect(view.container.querySelectorAll(".workflow-edge-group")).toHaveLength(100);
    expect(view.container.querySelectorAll(".edge-hit")).toHaveLength(100);
    expect(view.container.querySelectorAll(".flow-particle")).toHaveLength(0);
    view.rerender(<CanvasEdges {...props} selectedEdgeId="a-42" />);
    expect(view.container.querySelectorAll(".flow-particle")).toHaveLength(1);
    expect(view.container.querySelector(".flow-particle")).toHaveAttribute("data-flow-route", "a-42");
    view.rerender(<CanvasEdges {...props} selectedEdgeId="a-42" moving />);
    expect(view.container.querySelectorAll(".workflow-edge-group")).toHaveLength(100);
    expect(view.container.querySelectorAll(".flow-particle")).toHaveLength(0);
  });
  it("allows passive runtime selection to show directions on fixed edges without enabling editing", () => {
    const edges = [{ ...edge("a-b"), fixed: true }, { ...edge("b-c"), fixed: true }];
    const props = { edges, focusedNodeId: "b", relatedEdgeIds: new Set(["a-b", "b-c"]), interactive: false };
    const view = render(<CanvasEdges {...props} />);
    expect(view.container.querySelector('.flow-particle')).not.toBeInTheDocument();
    view.rerender(<CanvasEdges {...props} flowFixedEdges />);
    expect(view.container.querySelectorAll('.flow-particle')).toHaveLength(2);
    expect(view.container.querySelector('[data-flow-route="a-b"]')).toHaveClass("is-incoming-flow");
    expect(view.container.querySelector('[data-flow-route="b-c"]')).toHaveClass("is-outgoing-flow");
    expect(view.container.querySelector('[role="button"]')).not.toBeInTheDocument();
  });
  it("uses one non-ordinary color per Loop and highlights the selected group only", () => {
    const view = render(<CanvasEdges edges={[
      edge("a-b", "alpha"), edge("b-a", "alpha"), loopExit("alpha"),
      edge("c-d", "beta"), edge("d-main")
    ]} selectedLoopId="alpha" />);
    const find = (id: string) => view.container.querySelector<SVGGElement>(`[data-edge-id="${id}"]`)!;
    const first = find("a-b");
    const second = find("b-a");
    const exit = find("loop:alpha:exit");
    const other = find("c-d");
    const ordinary = find("d-main");

    const loopColor = first.style.getPropertyValue("--loop-color");
    expect(loopColor).toMatch(/^hsl\(/);
    expect(second.style.getPropertyValue("--loop-color")).toBe(loopColor);
    expect(other.style.getPropertyValue("--loop-color")).not.toBe(loopColor);
    expect(ordinary.style.getPropertyValue("--loop-color")).toBe("");
    expect(first).toHaveClass("is-selected");
    expect(second).toHaveClass("is-selected");
    expect(exit).toHaveClass("is-selected");
    expect(exit.querySelector(".workflow-edge")).toHaveClass("loop-exit");
    expect(exit.querySelector(".workflow-edge")).toHaveAttribute("marker-end", expect.stringMatching(/loop-exit-highlight\)$/));
    expect(other).not.toHaveClass("is-selected");
    expect(ordinary).not.toHaveClass("is-selected");
  });

  it("shows directional flow particles for one selected edge or every selected Loop edge, including its exit", () => {
    const edges = [
      edge("a-b", "alpha"), edge("b-a", "alpha"), loopExit("alpha"),
      edge("c-d", "beta"), edge("d-main")
    ];
    const view = render(<CanvasEdges edges={edges} selectedLoopId="alpha" selectedEdgeId="a-b" />);
    const particles = () => [...view.container.querySelectorAll<SVGGElement>("[data-flow-route]")];

    expect(particles().map((particle) => particle.dataset.flowRoute)).toEqual(["a-b", "b-a", "loop:alpha:exit"]);
    for (const particle of particles()) {
      expect(particle).toHaveClass("is-loop-flow");
      expect(particle.querySelector("animateMotion mpath")).toHaveAttribute("href", expect.stringMatching(/-path-/));
    }
    const exitParticle = particles().find((particle) => particle.dataset.flowRoute === "loop:alpha:exit")!;
    const exitPath = view.container.querySelector<SVGPathElement>('[data-edge-id="loop:alpha:exit"] .workflow-edge')!;
    expect(exitParticle).toHaveClass("is-outgoing-flow");
    expect(exitParticle.style.getPropertyValue("--loop-color")).toBe("#247b8a");
    expect(exitParticle.querySelector("animateMotion mpath")).toHaveAttribute("href", `#${exitPath.id}`);

    view.rerender(<CanvasEdges edges={edges} selectedEdgeId="d-main" />);
    expect(particles().map((particle) => particle.dataset.flowRoute)).toEqual(["d-main"]);
    expect(particles()[0]).not.toHaveClass("is-loop-flow");

    view.rerender(<CanvasEdges edges={edges} focusedNodeId="a" relatedEdgeIds={new Set(["a-b", "b-a"])} />);
    expect(particles().map((particle) => particle.dataset.flowRoute)).toEqual(["a-b", "b-a"]);
  });
});
