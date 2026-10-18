import type { ControlActionEnvelope } from "./types.js";
import type { WorkflowAdjustmentRecord, WorkflowAdjustmentSnapshot, WorkflowConfigurationVersion } from "./workflow-adjustments.js";
import type { WorkflowAdjustmentSession } from "./internal/shared/workflow-adjustment-contracts.js";
import type { WorkflowSessionState } from "./workflow-session-compatibility.js";

/** The actual serial-runner task and tool identities. They are not S route,
 * scoped-group, native-open, or native-stop evidence. */
export interface SerialMainWorkflowAdjustmentInput {
  projectId: string;
  agentExecutionId: string;
  mainInvocationSeq: number;
  envelope: ControlActionEnvelope;
  base: WorkflowConfigurationVersion;
  proposal: WorkflowAdjustmentSnapshot;
  session?: WorkflowAdjustmentSession;
}

/** Called synchronously inside the publication transaction by the serial
 * scheduler. It must check original logical owners, result persistence and
 * stop facts; a queued/paused projection alone is insufficient. */
export interface SerialWorkflowPublicationAuthority {
  sessions: WorkflowSessionState;
  waitingReason(record: Readonly<WorkflowAdjustmentRecord>): string | undefined;
}
