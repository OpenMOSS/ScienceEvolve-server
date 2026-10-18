import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { consumeAcceptanceFault, readAcceptanceArmFile, readConsumedAcceptanceFault,
  type AcceptanceBoundary } from "./acceptance-controller.js";
import type { AgentConfig, TraceSink } from "./types.js";
import type { GatewayModelFetch } from "./protocol-router.js";

/** Bind an observed queued arrival to its actual first model turn. The Agent
 * and existing proxy/native recovery retain all decisions and retry budgets;
 * this controller only returns a synthetic 503 before upstream dispatch. */
export async function createR11GatewayFetch(input: AcceptanceBoundary & {
  arrivalSequence: number; targetNodeId: string; invocationId: string; inputId: string;
  config: AgentConfig; onTrace: TraceSink; directory?: string;
}): Promise<GatewayModelFetch | undefined> {
  const directory = input.directory ?? process.env.OPENFARS_R11_FAULT_DIRECTORY;
  const { execution, config } = input;
  if (!directory || execution.ownershipEpoch !== 1 ||
    input.inputId !== `scoped:${input.arrivalRequestId}:epoch:1`) return;
  const openedAt = new Date().toISOString();
  // Both variants use independent registered projects and operator directories.
  // Read once at route preparation so a late arm cannot affect an active route.
  const bound = await readAcceptanceArmFile({ ...input, directory, case: "R11",
    variant: ["gateway-error-once", "gateway-unavailable"] });
  if (!bound) return;
  const { arm } = bound, target = arm.target, gateway = config.gatewaySnapshot;
  if (!gateway || target.selection !== "queued-arrival" || target.executionId !== undefined ||
    target.invocationId !== undefined || target.branch !== undefined || target.ownershipEpoch !== 1 ||
    target.agentId !== execution.agentId || target.arrivalRequestId !== input.arrivalRequestId ||
    target.arrivalSequence !== input.arrivalSequence || target.targetNodeId !== input.targetNodeId ||
    target.groupRunId !== input.groupRunId || target.base !== input.base ||
    target.repository.owner !== input.repository.owner || target.repository.name !== input.repository.name ||
    target.repository.providerId !== input.repository.providerId || Date.parse(arm.armedAt) > Date.parse(openedAt)) return;
  const route = { gatewayId: gateway.id, model: config.model, harness: config.harness,
    protocol: gateway.protocol, nativeProtocol: gateway.nativeProtocol,
    gatewayUrlSha256: createHash("sha256").update(gateway.url).digest("hex"),
    deliveryMode: gateway.deliveryMode ?? "native-stream" };
  if (!isDeepStrictEqual(target.route, route) || config.gatewayId !== gateway.id) return;
  assert.ok(execution.id && input.invocationId && execution.executionBranch &&
    execution.projectId === arm.projectId, "R11 lacks its actual execution/native binding");
  const binding = { executionId: execution.id, invocationId: input.invocationId, ownershipEpoch: 1,
    branch: execution.executionBranch, inputId: input.inputId, route };
  const suffix = { responses: "responses", "chat-completions": "chat/completions", "anthropic-messages": "messages" }[gateway.protocol];
  const endpoint = `${gateway.url.replace(/\/+$/, "")}/${suffix}`;
  const persistent = arm.variant === "gateway-unavailable";
  let initialClaim: Promise<boolean> | undefined;
  return async (url, init) => {
    init.signal?.throwIfAborted();
    // Only this configured model POST is eligible. No headers, prompts, URLs,
    // keys or model output are copied into the operator evidence or trace.
    if (url !== endpoint || init.method !== "POST" || typeof init.body !== "string") return fetch(url, init);
    let body: { model?: unknown };
    try { body = JSON.parse(init.body); } catch { return fetch(url, init); }
    if (!body || body.model !== config.model) return fetch(url, init);
    const initialRequest = !initialClaim;
    initialClaim ??= consumeAcceptanceFault(bound, { status: "model-transport-fault-bound",
      stage: "before-upstream-dispatch", binding, routeOpenedAt: openedAt, httpStatus: 503,
      observationLimit: "This receipt binds the fault before returning a response; actual proxy/native traces must prove delivery, existing retry or escalation, same model and session/stop facts." });
    const first = await initialClaim && initialRequest;
    if (!first) {
      if (!persistent) return fetch(url, init);
      const receipt = await readConsumedAcceptanceFault(bound);
      // Restart/replay cannot let a different execution or native turn inherit
      // the persistent fault. Interrupted receipts remain errors, not re-arms.
      assert.equal(receipt.status, "model-transport-fault-bound", "R11 receipt is incomplete");
      if (!isDeepStrictEqual(receipt.binding, binding)) return fetch(url, init);
    }
    await input.onTrace("status", "R11 controlled model transport response", {
      diagnostic: true, diagnosticSource: "proxy", stage: "before-upstream-dispatch",
      variant: arm.variant, httpStatus: 503, first, binding, armSha256: bound.armSha256
    });
    return new Response(JSON.stringify({ error: { type: "service_unavailable",
      message: `R11 controlled ${arm.variant}: selected model transport unavailable before upstream dispatch` } }),
    { status: 503, headers: { "content-type": "application/json" } });
  };
}
