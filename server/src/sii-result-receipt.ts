import type { SiiExperiment } from "./sii-experiments.js";
import { sameDurableSession } from "./control-result-receipts.js";

/** Shared by the delivery gate and public state view; an ACK flag alone
 * cannot prove reception by the original native Session. */
export function experimentResultReceived(experiment: SiiExperiment): boolean {
  const receipt = experiment.notificationReceipt;
  return experiment.acknowledged === true && typeof receipt?.eventId === "string" && !!receipt.eventId &&
    typeof receipt.nativeEventId === "string" && !!receipt.nativeEventId &&
    typeof receipt.invocationId === "string" && !!receipt.invocationId &&
    receipt.session?.durable === true && experiment.session?.durable === true &&
    sameDurableSession(experiment.session, receipt.session);
}
