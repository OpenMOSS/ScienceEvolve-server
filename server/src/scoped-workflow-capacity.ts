import { DEFAULT_AGENT_KIND_CAPACITY } from "./agent-scheduler.js";
import type { ScopedWorkflowContract } from "./scoped-workflow-contract.js";

/** Count Agent identities, not graph references or nested scopes. All child
 * groups share the project's worker pool; nesting never multiplies it. */
export function scopedWorkerCapacity(contract: ScopedWorkflowContract | undefined): number {
  if (!contract) throw new Error("v3 workflow is missing its scoped Agent capacity contract");
  const workers = new Set(contract.rootAgentIds.filter((agentId) => agentId !== "main"));
  for (const group of contract.groups) {
    for (const node of group.workflow.nodes) {
      if (node.kind === "agent" && node.agentId !== "main") workers.add(node.agentId);
    }
  }
  return Math.max(1, Math.min(DEFAULT_AGENT_KIND_CAPACITY, workers.size));
}
