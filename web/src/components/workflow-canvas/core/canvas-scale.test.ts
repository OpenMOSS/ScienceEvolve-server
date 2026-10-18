import { describe, expect, it } from "vitest";
import type { AgentOrchestrationTemplate } from "../../../types";
import { adaptWorkflowToCanvas } from "./canvas-adapter";
import { mainDispatchLayoutTargets, normalizeCanvasLayout } from "./canvas-layout";
import { canvasNodeSize } from "./canvas-model";
import { planningTwoCubicGeometries, polylineIntersectsRect, routeCanvasEdges } from "./canvas-router";

function dispatchWorkflow(workerCount: number): AgentOrchestrationTemplate {
  const workers = Array.from({ length: workerCount }, (_, index) => `worker_${index + 1}`);
  const terminal = workers.at(-1)!;
  return {
    agents: [
      { name: "main", template: "main" },
      ...workers.map((name) => ({ name, template: "general" as const }))
    ],
    input: { source: "input", target: workers[0]! },
    routes: {
      main: workers.map((target) => ({ target, kind: "weak" as const })),
      ...Object.fromEntries(workers.map((name) => [
        name,
        name === terminal ? [{ target: "finish", kind: "weak" as const }] : []
      ]))
    },
    decisionPlans: {},
    allowUserIntervention: true,
    termination: { agent: terminal, condition: "done", decisionBy: "main", automatic: false }
  };
}

describe("canvas scale scenarios", () => {
  it.each([4, 10, 25, 50])("keeps %i-worker dispatch routing bounded and clear", (workerCount) => {
    const orchestration = dispatchWorkflow(workerCount);
    const base = normalizeCanvasLayout(undefined, orchestration);
    const layout = {
      ...base,
      nodes: mainDispatchLayoutTargets(orchestration, base)
    };
    const model = adaptWorkflowToCanvas(orchestration, layout);
    const geometry = routeCanvasEdges(model.edges, model.nodes);

    expect(geometry).toHaveLength(workerCount + 2);
    expect(geometry.every((route) => (route.controlPoints?.length ?? 0) >= 1)).toBe(true);
    expect(geometry.every((route) => (route.controlPoints?.length ?? 0) <= 2)).toBe(true);
    for (const route of geometry) {
      for (const node of model.nodes) {
        if (node.id === route.source || node.id === route.target) continue;
        const size = canvasNodeSize(node);
        const rect = {
          left: node.x,
          top: node.y,
          right: node.x + size.width,
          bottom: node.y + size.height
        };
        const candidateHits = planningTwoCubicGeometries(route.points[0]!, route.points.at(-1)!, route.points)
          .map((candidate, index) => {
            const hits = model.nodes.flatMap((candidateNode) => {
              if (candidateNode.id === route.source || candidateNode.id === route.target) return [];
              const candidateSize = canvasNodeSize(candidateNode);
              return polylineIntersectsRect(candidate.samples, {
                left: candidateNode.x,
                top: candidateNode.y,
                right: candidateNode.x + candidateSize.width,
                bottom: candidateNode.y + candidateSize.height
              }) ? [candidateNode.id] : [];
            });
            return `${index}:${hits.length ? hits.join(",") : "clear"}:${candidate.path}`;
          })
          .join(" | ");
        expect(polylineIntersectsRect(route.samples, rect), `${workerCount}: ${route.id} crossed ${node.id}; ports=${route.sourcePort}->${route.targetPort}; points=${JSON.stringify(route.points)}; path=${route.path}; candidates=${candidateHits}`).toBe(false);
      }
    }
  });

  it("keeps dense layout-frame routes on smooth bounded cubics", () => {
    const orchestration = dispatchWorkflow(18);
    for (const worker of orchestration.agents.filter((agent) => agent.name !== "main")) {
      orchestration.routes[worker.name] = [{ target: "main", kind: "weak" }];
    }
    const base = normalizeCanvasLayout(undefined, orchestration);
    const layout = { ...base, nodes: mainDispatchLayoutTargets(orchestration, base) };
    const model = adaptWorkflowToCanvas(orchestration, layout);
    const geometry = routeCanvasEdges(model.edges, model.nodes, {
      fastEvaluation: true,
      smoothFallback: true
    });

    expect(geometry.every((route) => (route.controlPoints?.length ?? 0) <= 2)).toBe(true);
    expect(geometry.every((route) => !route.path.includes(" L "))).toBe(true);
  });
});
