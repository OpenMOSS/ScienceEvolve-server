import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SessionRef } from "./harness-runtime/contracts.js";
import { validateSessionRef } from "./harness-runtime/session-ref.js";
import { sameDurableSession } from "./control-result-receipts.js";
import { CollaborationStateError } from "./collaboration-state/errors.js";
import type { WorkflowAdjustmentNotificationFact } from "./workflow-adjustment-notifications.js";

/** The original scheduler's input intent. A native Session may not exist yet.
 * This is never an opened/stopped or received fact. */
export interface SerialWorkflowNotificationContext {
  projectId: string;
  agentId: string;
  invocationId: string;
  agentExecutionId: string;
  mainInvocationSeq?: number;
}
export interface SerialWorkflowNotificationInput {
  schemaVersion: 1;
  context: SerialWorkflowNotificationContext;
  inputId: string;
  expectedSession?: SessionRef;
  facts: WorkflowAdjustmentNotificationFact[];
  text: string;
}
export function assertSerialWorkflowNotificationContext(context: SerialWorkflowNotificationContext): void {
  if (![context.projectId, context.agentId, context.invocationId, context.agentExecutionId].every(value => typeof value === "string" && value.trim()) ||
    context.mainInvocationSeq !== undefined && (!Number.isSafeInteger(context.mainInvocationSeq) || context.mainInvocationSeq < 1))
    throw new CollaborationStateError("UNSAFE_CONFIGURATION", "Workflow input requires its exact original task and invocation identity");
}
export function assertSerialWorkflowNotificationSession(session: SessionRef): void {
  if (!validateSessionRef(session).valid || !session.durable || session.nativeId.startsWith("pending:"))
    throw new CollaborationStateError("UNSAFE_CONFIGURATION", "Workflow receipt requires the actual durable native Session, not an allocation placeholder");
}
export function sameSerialWorkflowNotificationContext(left: SerialWorkflowNotificationContext, right: SerialWorkflowNotificationContext): boolean {
  return isDeepStrictEqual(left, right);
}
export function sameSerialWorkflowNotificationSession(left: SessionRef | undefined, right: SessionRef | undefined): boolean {
  return left === undefined || right === undefined ? left === right : sameDurableSession(left, right);
}
export function serialWorkflowNotificationRequest(context: SerialWorkflowNotificationContext, inputId: string): string {
  return `serial-workflow-input:${createHash("sha256").update(JSON.stringify([context.projectId, context.invocationId, inputId])).digest("hex")}`;
}
