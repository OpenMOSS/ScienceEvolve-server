import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { consumeAcceptanceFault, readBoundAcceptanceArm, readConsumedAcceptanceFault, type AcceptanceBoundary } from "./acceptance-controller.js";
import type { ControlActionEnvelope } from "./types.js";
import type { AgentGitFacts } from "./agent-git-tools.js";

/** Reject finish only in one explicitly armed initial model turn. There is no
 * fabricated completion and no new recovery loop: the native model returns a
 * handoff and the existing same-session supplement supplies its missing tool. */
export async function rejectR03InitialFinish(input: AcceptanceBoundary & {
  envelope: ControlActionEnvelope; inputId: string; completionAlreadyAccepted: boolean;
  facts?: AgentGitFacts; directory?: string;
}): Promise<void> {
  const { execution, envelope } = input;
  const initialInputId = `scoped:${input.arrivalRequestId}:epoch:${execution.ownershipEpoch}`;
  if (input.completionAlreadyAccepted || input.inputId !== initialInputId || envelope.action.tool !== "finish_task" ||
    envelope.projectId !== execution.projectId || envelope.agent !== execution.agentId || envelope.stateVersion !== execution.ownershipEpoch) return;
  const bound = await readBoundAcceptanceArm({ ...input, case: "R03", variant: "missing-finish-once",
    invocationId: envelope.invocationId, boundaryAt: envelope.receivedAt,
    directory: input.directory ?? process.env.OPENFARS_R03_FAULT_DIRECTORY });
  if (!bound) return;
  await consumeAcceptanceFault(bound, { status: "initial-finish-withheld", inputId: input.inputId,
    firstCallId: envelope.callId, marker: randomUUID(), deliveryAtAttempt: input.facts ?? null,
    observationLimit: "The first model return must lack a finish receipt; native/tool traces must prove retained-session supplement and no repeated business." });
  const receipt = await readConsumedAcceptanceFault(bound);
  assert.ok(receipt.status === "initial-finish-withheld" && receipt.inputId === initialInputId &&
    typeof receipt.marker === "string" && /^[a-f0-9-]{36}$/.test(receipt.marker), "R03 consumed receipt is incomplete; preserve it for review");
  // Repeated attempts inside this same model turn remain explicit failures.
  // Its ordinary supplement has a different inputId and immediately regains
  // the unchanged finish_task capability, even with sessionPersistence=false.
  throw new Error(`R03 controlled omission: no finish_task receipt was recorded for this initial model turn. Retain marker ${receipt.marker}. Complete any outstanding assigned Git work and return your handoff now without another finish_task attempt. On the existing same-session supplement, recall this marker and supply only missing actions; do not repeat business work.`);
}
