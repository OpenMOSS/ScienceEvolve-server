import type { AgentConfig, AgentOrchestrationTemplate, ProjectMcpDefinitions, ProjectSkillDefinitions } from "./types";
import type * as Contract from "../../server/src/internal/shared/workflow-adjustment-contracts";

export type { WorkflowConfigurationVersion, WorkflowAdjustmentSource, WorkflowAdjustmentStatus,
  WorkflowAdjustmentChange, WorkflowAdjustmentTransition, WorkflowAdjustmentSummary, WorkflowAdjustmentPageInput } from "../../server/src/internal/shared/workflow-adjustment-contracts";

/** Public editable snapshots contain no Gateway transport snapshot or migration hints. */
export interface WorkflowAdjustmentSnapshot {
  orchestration: AgentOrchestrationTemplate;
  agents: Record<string, Omit<AgentConfig, "gatewaySnapshot" | "legacyReasoningEffort" | "reasoningMigrationWarning">>;
  skillDefinitions: ProjectSkillDefinitions;
  mcpDefinitions: ProjectMcpDefinitions;
}
export type WorkflowAdjustmentRecord = Contract.WorkflowAdjustmentRecord<WorkflowAdjustmentSnapshot>;
export type WorkflowAdjustmentContext = Contract.WorkflowAdjustmentContext<WorkflowAdjustmentSnapshot>;
export type WorkflowAdjustmentSubmission = Omit<Contract.SubmitUserWorkflowAdjustmentInput<WorkflowAdjustmentSnapshot>, "projectId">;
export type WorkflowAdjustmentSubmissionResult = Contract.WorkflowAdjustmentSubmissionResult<WorkflowAdjustmentSnapshot>;
export type WorkflowAdjustmentWithdrawalResult = Contract.WorkflowAdjustmentWithdrawalResult<WorkflowAdjustmentSnapshot>;
export interface WorkflowAdjustmentWithdrawal { operationId: string; note?: string }

export type WorkflowAdjustmentPage = Contract.WorkflowAdjustmentPage<WorkflowAdjustmentSnapshot>;
export type WorkflowAdjustmentDetail = Contract.WorkflowAdjustmentDetail<WorkflowAdjustmentSnapshot>;
