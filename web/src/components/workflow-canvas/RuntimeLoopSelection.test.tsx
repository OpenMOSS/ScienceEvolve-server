import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_ORCHESTRATION, DEFAULT_AGENTS, normalizeProject } from "../../lib";
import { RuntimeCanvasSurface } from "./WorkflowCanvasRuntime";
import { adaptWorkflowToCanvas } from "./core/canvas-adapter";
import { routeCanvasEdges } from "./core/canvas-router";
import { buildWorkflowRuntimeState } from "./core/workflow-runtime";

describe("runtime Loop selection", () => {
  it("selects all edges from the read-only exit and leaves execution states and configuration intact", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    orchestration.routes.idea = [{ target: "execution", kind: "strong" }];
    orchestration.routes.execution = [{ target: "writing", kind: "strong" }];
    orchestration.routes.writing = [{ target: "idea", kind: "strong" }];
    orchestration.loops = [{ id: "evidence", from: "writing", to: "idea", exitTo: "review", maxIterations: 3 }];
    const project = normalizeProject({ id: "prj_loop", title: "Loop", status: "completed", orchestration, agents: DEFAULT_AGENTS });
    const model = adaptWorkflowToCanvas(project.orchestration);
    const runtime = buildWorkflowRuntimeState(project, []);
    const before = JSON.stringify({ model, runtime, orchestration: project.orchestration });
    const view = render(<RuntimeCanvasSurface model={model} geometry={routeCanvasEdges(model.edges, model.nodes)}
      runtime={runtime} project={project} onSelectNode={vi.fn()} />);
    const exit = view.container.querySelector('[data-loop-role="exit"]')!;
    expect(exit).toHaveAttribute("role", "button");
    fireEvent.click(exit);
    expect(view.container.querySelectorAll('[data-loop-id="evidence"].is-selected')).toHaveLength(4);
    expect(view.container.querySelectorAll('.flow-particle.is-loop-flow')).toHaveLength(4);
    expect(view.container.querySelectorAll('[data-loop-id="evidence"].runtime-edge-active')).toHaveLength(0);
    expect(JSON.stringify({ model, runtime, orchestration: project.orchestration })).toBe(before);
  });
});
