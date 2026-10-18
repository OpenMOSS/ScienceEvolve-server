export interface WorkflowCanvasSavedFlow {
  id: string;
  name: string;
  builtin?: boolean;
  readOnly?: boolean;
  agentCount?: number;
  pathCount?: number;
  updatedAt?: string;
}
