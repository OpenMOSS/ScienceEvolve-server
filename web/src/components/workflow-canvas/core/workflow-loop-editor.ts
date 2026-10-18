import { validateWorkflowLoops, workflowLoopMembers } from "../../../../../server/src/internal/shared/workflow-loop-validation.js";
import type { WorkflowEdgeMap, WorkflowLoop } from "../../../types";

type StrongEdge = { source: string; target: string };
type LoopEditableTopology = {
  agents: readonly { name: string }[];
  routes: WorkflowEdgeMap;
  loops?: WorkflowLoop[];
  termination: { agent: string };
};

export interface LoopTopologyEdit {
  loops: WorkflowLoop[];
  created?: WorkflowLoop;
  removed: string[];
  error?: string;
}

function cycleMembers(workflow: LoopEditableTopology, edge: StrongEdge): string[] | undefined {
  if (edge.source === "main" || edge.target === "main" || edge.target === "finish") return undefined;
  const route = workflow.routes[edge.source] ?? [];
  if (!route.some((item) => item.kind === "strong" && item.target === edge.target)) return undefined;
  const visit = (current: string, path: string[], seen: Set<string>): string[] | undefined => {
    if (current === "main" || current === "finish" || seen.has(current)) return undefined;
    const nextPath = [...path, current];
    if (current === edge.source) return nextPath;
    const nextSeen = new Set(seen).add(current);
    for (const outgoing of workflow.routes[current] ?? []) {
      if (outgoing.kind !== "strong") continue;
      const result = visit(outgoing.target, nextPath, nextSeen);
      if (result) return result;
    }
    return undefined;
  };
  return visit(edge.target, [], new Set());
}

function nextLoopId(workflow: LoopEditableTopology, edge: StrongEdge): string {
  const used = new Set((workflow.loops ?? []).map((loop) => loop.id));
  const sanitized = `${edge.target}-${edge.source}-loop`.replace(/[^a-zA-Z0-9_-]/g, "-");
  const stem = (/^[a-zA-Z]/.test(sanitized) ? sanitized : `loop-${sanitized}`).slice(0, 58);
  let id = stem;
  for (let suffix = 2; used.has(id); suffix += 1) id = `${stem.slice(0, 58)}-${suffix}`;
  return id;
}

/** Reconcile one user-authored topology edit; existing unannotated legacy cycles are left untouched. */
export function reconcileLoopTopology(
  before: LoopEditableTopology,
  after: LoopEditableTopology,
  changedEdge?: StrongEdge,
  options?: { exitTo: (members: readonly string[], topology: LoopEditableTopology) => string | undefined }
): LoopTopologyEdit {
  const removed: string[] = [];
  const loops = (before.loops ?? []).filter((loop) => {
    const valid = validateWorkflowLoops({ ...after, loops: [loop] }).length === 0;
    if (!valid) removed.push(loop.id);
    return valid;
  });
  after.loops = loops;
  let created: WorkflowLoop | undefined;
  const members = changedEdge ? cycleMembers(after, changedEdge) : undefined;
  if (changedEdge && members) {
    const alreadyOwned = loops.some((loop) => {
      const owned = workflowLoopMembers(after, loop);
      return owned.length === members.length && members.every((name) => owned.includes(name));
    });
    if (!alreadyOwned) {
      const exitTo = options ? options.exitTo(members, after) : "main";
      if (!exitTo) return { loops, removed, error: "Loop needs an available exit node outside its cycle" };
      created = {
        id: nextLoopId(after, changedEdge),
        from: changedEdge.source,
        to: changedEdge.target,
        maxIterations: 3,
        exitTo
      };
      after.loops = [...loops, created];
    }
  }
  const issue = validateWorkflowLoops(after)[0];
  return {
    loops: after.loops ?? [],
    created,
    removed,
    ...(issue ? { error: issue.message } : {})
  };
}
