import { createHash } from "node:crypto";
import type { ScopedWorkflow } from "./scoped-workflow-contract.js";

export interface ScopedActivationPlan {
  /** Stable across replay, but distinct for separate arrivals at one node. */
  requestId: string;
  groupRunId: string;
  workflowRevision: number;
  sourceRunId: string;
  targetNodeId: string;
}

export type ScopedRoutePlan =
  | { kind: "activate"; activation: ScopedActivationPlan }
  | { kind: "finish"; requestId: string; sourceRunId: string };

/** Each Input arrival owns a path instance. Two parallel paths entering the
 * same Loop share the Agent FIFO, not the Loop's batch counters. */
export interface ScopedPathContext {
  pathId: string;
  loops: Record<string, { batch: number; iterations: number; totalIterations: number }>;
}

export function scopedPathAtEntry(workflow: ScopedWorkflow, target: string,
  context: ScopedPathContext): ScopedPathContext {
  const next = structuredClone(context);
  const loop = workflow.loops?.find((item) => item.to === target);
  if (loop) {
    const prior = next.loops[loop.id];
    next.loops[loop.id] = { batch: (prior?.batch ?? 0) + 1, iterations: 1,
      totalIterations: (prior?.totalIterations ?? 0) + 1 };
  }
  return next;
}

/** Same batch algorithm as the outer workflow. Counting and successor
 * persistence belong to the source's merge transaction, never a model turn. */
export function planScopedPathSuccessor(workflow: ScopedWorkflow, groupRunId: string,
  revision: number, sourceNodeId: string, sourceRunId: string, context: ScopedPathContext,
  selectedWeakTarget?: string): { route: ScopedRoutePlan; context: ScopedPathContext; loop?: {
    id: string; exhausted: boolean; batch: number; iterations: number; totalIterations: number;
  } } {
  const loop = workflow.loops?.find((item) => item.from === sourceNodeId);
  const next = structuredClone(context);
  if (!context.pathId || Object.values(context.loops).some((counter) =>
    ![counter.batch, counter.iterations, counter.totalIterations].every((value) => Number.isSafeInteger(value) && value >= 0))) {
    throw new Error("Scoped path has invalid persisted Loop counters");
  }
  if (loop) {
    // Validate the original sole-strong route; metadata cannot bypass routing.
    planScopedSuccessor(workflow, groupRunId, revision, sourceNodeId, sourceRunId, selectedWeakTarget);
    const prior = next.loops[loop.id] ?? { batch: 0, iterations: 0, totalIterations: 0 };
    const exhausted = prior.iterations >= loop.maxIterations;
    if (!exhausted) next.loops[loop.id] = { batch: prior.batch + (prior.iterations === 0 ? 1 : 0),
      iterations: prior.iterations + 1, totalIterations: prior.totalIterations + 1 };
    const counter = next.loops[loop.id] ?? prior;
    const target = exhausted ? loop.exitTo : loop.to;
    const routes = { ...workflow.routes, [sourceNodeId]: [{ kind: "strong" as const, target }] };
    return { route: planScopedSuccessor({ ...workflow, routes }, groupRunId, revision, sourceNodeId, sourceRunId),
      context: next, loop: { id: loop.id, exhausted, ...counter } };
  }
  const route = planScopedSuccessor(workflow, groupRunId, revision, sourceNodeId, sourceRunId, selectedWeakTarget);
  return { route, context: route.kind === "activate" ? scopedPathAtEntry(workflow, route.activation.targetNodeId, next) : next };
}

function requestId(parts: readonly string[]): string {
  return `scoped_${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

function requireNode(workflow: ScopedWorkflow, nodeId: string): void {
  if (!workflow.nodes.some((node) => node.nodeId === nodeId)) {
    throw new Error(`Scoped node ${nodeId} does not belong to this group`);
  }
}

/** Call only after the group branch and its exact base have been persisted. */
export function planScopedInputFanOut(
  workflow: ScopedWorkflow,
  groupRunId: string,
  workflowRevision: number
): ScopedActivationPlan[] {
  if (!groupRunId || !Number.isSafeInteger(workflowRevision) || workflowRevision < 1) {
    throw new Error("A scoped activation requires a group run and workflow revision");
  }
  if (!workflow.input.edges.length) throw new Error("A scoped group requires an Input edge");
  const seen = new Set<string>();
  return workflow.input.edges.map((edge) => {
    if (edge.kind !== "parallel") throw new Error("Only parallel edges may leave a group Input");
    requireNode(workflow, edge.target);
    if (seen.has(edge.target)) throw new Error(`Duplicate scoped Input target ${edge.target}`);
    seen.add(edge.target);
    return {
      requestId: requestId([groupRunId, String(workflowRevision), "input", edge.target]),
      groupRunId,
      workflowRevision,
      sourceRunId: `input:${groupRunId}`,
      targetNodeId: edge.target
    };
  });
}

/** A successor is emitted only after the source execution's required PR has
 * been authoritatively merged and synchronized. The caller supplies the
 * chosen weak target from the existing routing decision; unchosen weak paths
 * are never activated and therefore never enter the completion barrier. */
export function planScopedSuccessor(
  workflow: ScopedWorkflow,
  groupRunId: string,
  workflowRevision: number,
  sourceNodeId: string,
  sourceRunId: string,
  selectedWeakTarget?: string
): ScopedRoutePlan {
  if (!groupRunId || !sourceRunId || !Number.isSafeInteger(workflowRevision) || workflowRevision < 1) {
    throw new Error("A scoped route requires run identities and workflow revision");
  }
  requireNode(workflow, sourceNodeId);
  const edges = workflow.routes[sourceNodeId] ?? [];
  if (!edges.length) throw new Error(`Scoped node ${sourceNodeId} has no route`);
  const strong = edges.filter((edge) => edge.kind === "strong");
  if (strong.length > 1 || (strong.length && edges.length !== 1)) {
    throw new Error(`Scoped node ${sourceNodeId} has invalid strong routes`);
  }
  const selected = strong[0] ?? edges.find((edge) =>
    edge.kind === "weak" && edge.target === selectedWeakTarget
  );
  if (!selected || (strong.length && selectedWeakTarget !== undefined)) {
    throw new Error(`Scoped node ${sourceNodeId} requires a valid route decision`);
  }
  if (selected.target === "finish") {
    return {
      kind: "finish",
      requestId: requestId([groupRunId, String(workflowRevision), sourceRunId, "finish"]),
      sourceRunId
    };
  }
  requireNode(workflow, selected.target);
  return {
    kind: "activate",
    activation: {
      requestId: requestId([groupRunId, String(workflowRevision), sourceRunId, selected.target]),
      groupRunId,
      workflowRevision,
      sourceRunId,
      targetNodeId: selected.target
    }
  };
}
