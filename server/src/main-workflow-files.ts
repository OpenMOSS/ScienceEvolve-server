import path from "node:path";

/** Leaf constants shared by storage, prompts and workflow validation. */
export const MAIN_AGENT_ORCHESTRATION_FILE = "workflow.json";
export const MAIN_AGENT_ORCHESTRATION_CURRENT_FILE = ".scienceevolve/workflow-current.json";

/** Fixed Git management keeps its reference in the Agent cwd. SDK external
 * authoring has no invocation lineage and isolates both documents per project. */
export function mainWorkflowCurrentReferencePath(input: {
  workspacePath: string; workflowAuthoringPath?: string; workflowAuthoringInvocationId?: string; workflowCurrentPath?: string;
}): string {
  if (input.workflowCurrentPath) return input.workflowCurrentPath;
  return path.join(input.workflowAuthoringPath && !input.workflowAuthoringInvocationId
    ? path.dirname(input.workflowAuthoringPath) : input.workspacePath, MAIN_AGENT_ORCHESTRATION_CURRENT_FILE);
}
