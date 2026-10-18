import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CollaborationStateDatabase } from "./collaboration-state/store.js";
import type { ControlActionEnvelope, CollaborationExecutionContext } from "./types.js";
import type { SessionRef } from "./harness-runtime/contracts.js";
import { validateSessionRef } from "./harness-runtime/session-ref.js";
import { OperationStoreViolationError } from "./collaboration-git/errors.js";
import { redactTrace } from "./utils.js";
import type { RecordedAgentGitOperationRequest } from "./agent-git-operation-journal.js";
import type { queryAgentGitOperation } from "./agent-git-operation-query.js";
import { agentGitResultCoversOperation } from "./agent-git-result-proof.js";
import { agentGitResultText } from "./agent-git-result.js";

export interface ControlResultInput {
  envelope: ControlActionEnvelope;
  requestedCallId: string;
  result?: unknown;
}
export interface ControlResultContext {
  projectId: string;
  agentId: string;
  invocationId: string;
  session: SessionRef;
  executionContext?: CollaborationExecutionContext;
}
export interface ControlResultReceipt extends ControlResultContext {
  schemaVersion: 1;
  id: string;
  callId: string;
  acceptedCallId: string;
  tool: ControlActionEnvelope["action"]["tool"];
  result?: unknown;
  responseText: string;
  origin?: { kind: "journal-observation"; operationId: string; status: string; localStage: string };
}
type Store = Pick<CollaborationStateDatabase, "eventByRequestId" | "appendEvent" | "pendingControlResultEvents">;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const resultRequest = (invocation: string, call: string) => `control-result:${digest([invocation, call])}`;
const nativeRequest = (invocation: string, call: string) => `control-native-result:${digest([invocation, call])}`;
const notificationRequest = (invocation: string) => `control-result-notification:${digest(invocation)}`;
export const controlResultMarker = (id: string) => `[OpenFARS result ${id}]`;

interface ResultNotification {
  context: ControlResultContext;
  inputId: string;
  results: Array<{ id: string; invocationId: string; callId: string; requestId?: string }>;
  text: string;
}

export function sameDurableSession(left: SessionRef, right: SessionRef): boolean {
  // resumedAt describes an open, not a new native memory lineage.
  const { resumedAt: _leftResume, ...leftIdentity } = left;
  const { resumedAt: _rightResume, ...rightIdentity } = right;
  return isDeepStrictEqual(leftIdentity, rightIdentity);
}

/** Shared with the actual MCP response. This is a transport receipt for the
 * returned facts, not an assertion that a staged business action completed. */
export function controlResultText(envelope: ControlActionEnvelope, result?: unknown, receiptId?: string): string {
  const text = envelope.action.tool === "finish_task"
    ? "Task completion requested and saved. Acceptance follows successful preservation of the existing handoff at the turn boundary. For a Git business task, your task memory/summary is also saved once in your actual worktree's agent-memory/<agent>/Memory.md; inspect git_status and commit/push/integrate any pending work-record change before returning. Group/project completion and any other authorized tools remain available."
    : `Action ${envelope.action.tool} staged for atomic invocation commit.${result === undefined ? "" : ` Provider result: ${JSON.stringify(result)}`} Continue the native Harness turn normally; additional non-conflicting tools remain available.`;
  if (receiptId && !/^[a-f0-9]{64}$/.test(receiptId)) throw new Error("Invalid control result receipt identity");
  return receiptId ? `${controlResultMarker(receiptId)}\n${text}` : text;
}

/** Keep immutable receipt text unchanged while clarifying its transport meaning. */
export function controlResultDisplayText(envelope: ControlActionEnvelope, result?: unknown, receiptId?: string): string {
  const summary = agentGitResultText(envelope.action.tool, result);
  return `${summary}${summary ? "\n" : ""}${controlResultText(envelope, result, receiptId)}\nControl-action staging and atomic invocation commit refer to internal control records, not Git staging, automatic Git commits, or successful business operations. Inspect the actual provider result for the Git outcome.`;
}

function assertContext(context: ControlResultContext): void {
  if (!context.projectId || !context.agentId || !context.invocationId ||
    !validateSessionRef(context.session).valid || !context.session.durable) {
    throw new OperationStoreViolationError("Control result requires its exact original durable native Session");
  }
}

/** Existing append-only project facts retain results separately from native
 * receipt evidence. Neither saving a result nor sending it marks reception. */
export function controlResultReceipts(database: Store, context: ControlResultContext) {
  assertContext(context);
  const prepareNotification = (inputId: string): string => {
    if (!inputId) throw new OperationStoreViolationError("Result notification requires its original native input identity");
    const requestId = notificationRequest(context.invocationId);
    const prior = database.eventByRequestId(context.projectId, requestId);
    if (prior) {
      const saved = prior.payload.notification as ResultNotification | undefined;
      if (prior.type !== "control.result.notification.prepared" || saved?.inputId !== inputId ||
        !isDeepStrictEqual(saved.context, context) || typeof saved.text !== "string") {
        throw new OperationStoreViolationError("Result notification changed its immutable native input binding");
      }
      return saved.text;
    }
    const results: ResultNotification["results"] = [];
    let text = "OpenFARS result notification from this original native Session. Read these saved tool returns and journal observations before the next decision. " +
      "This notice does not restore previous permissions or repeat an operation. Staging acknowledgements retain their original meaning; they do not prove final business acceptance.";
    text += `\nDelivery input: ${JSON.stringify({ invocationId: context.invocationId, inputId })}`;
    for (const event of database.pendingControlResultEvents(context.projectId, context.agentId)) {
      const receipt = event.payload.receipt as ControlResultReceipt | undefined;
      if (!receipt || receipt.invocationId === context.invocationId || receipt.projectId !== context.projectId ||
        receipt.agentId !== context.agentId || !sameDurableSession(receipt.session, context.session)) continue;
      const entry = redactTrace(`\n\nOriginal call: ${JSON.stringify({ invocationId: receipt.invocationId, callId: receipt.callId,
        acceptedCallId: receipt.acceptedCallId, tool: receipt.tool, executionContext: receipt.executionContext })}\n${agentGitResultText(receipt.tool, receipt.result)}\n${receipt.responseText}`);
      // Keep each returned result whole inside the ordinary native input
      // preview. Oversized facts stay pending; no truncation counts as receipt.
      if (text.length + entry.length > 32_000) continue;
      text += entry;
      results.push({ id: receipt.id, invocationId: receipt.invocationId, callId: receipt.callId, requestId: event.requestId });
    }
    if (!results.length) return "";
    const notification: ResultNotification = { context: structuredClone(context), inputId, results, text };
    database.appendEvent({ projectId: context.projectId, agentId: context.agentId, invocationId: context.invocationId,
      requestId, type: "control.result.notification.prepared", payload: { notification } });
    return text;
  };
  const record = (input: ControlResultInput): string => {
    const e = input.envelope;
    if (e.projectId !== context.projectId || e.agent !== context.agentId || e.invocationId !== context.invocationId ||
      !input.requestedCallId || !e.callId) throw new OperationStoreViolationError("Control result differs from its original caller");
    const identity = { ...structuredClone(context), schemaVersion: 1 as const, callId: input.requestedCallId,
      acceptedCallId: e.callId, tool: e.action.tool, ...(input.result === undefined ? {} : { result: input.result }) };
    const id = digest(identity);
    const receipt: ControlResultReceipt = { ...identity, id, responseText: controlResultText(e, input.result, id) };
    const requestId = resultRequest(context.invocationId, input.requestedCallId);
    const prior = database.eventByRequestId(context.projectId, requestId);
    if (prior) {
      if (prior.type !== "control.result.recorded" || !isDeepStrictEqual(prior.payload.receipt, receipt)) {
        throw new OperationStoreViolationError("Control result changed its original immutable facts");
      }
      return id;
    }
    database.appendEvent({ projectId: context.projectId, agentId: context.agentId, invocationId: context.invocationId,
      requestId, type: "control.result.recorded", payload: { receipt } });
    return id;
  };
  const recordJournalResult = (request: RecordedAgentGitOperationRequest,
    result: ReturnType<typeof queryAgentGitOperation>): string | undefined => {
    if (request.projectId !== context.projectId || request.agentId !== context.agentId ||
      request.invocationId !== context.invocationId || !request.callId || !request.nativeBinding ||
      !sameDurableSession(request.nativeBinding.session, context.session) ||
      !isDeepStrictEqual(request.nativeBinding.executionContext, context.executionContext) ||
      result.operation.id !== request.operationId || !isDeepStrictEqual(result.request, request) ||
      !["completed", "remote_success_local_pending", "superseded"].includes(result.status)) {
      throw new OperationStoreViolationError("Journal result requires its validated original request and Session");
    }
    // A complete normal return already has its own transport receipt. Keep an
    // earlier partial/error return, but append later exact facts separately so
    // finalization and synchronization can reach the original native Session.
    const normal = database.eventByRequestId(context.projectId, resultRequest(request.invocationId, request.callId));
    const normalReceipt = normal?.payload.receipt as ControlResultReceipt | undefined;
    if (normal?.type === "control.result.recorded" && normalReceipt &&
      agentGitResultCoversOperation(normalReceipt.result, result)) return undefined;
    const origin = { kind: "journal-observation" as const, operationId: request.operationId,
      status: result.status, localStage: result.localStage };
    const requestId = `control-result-journal:${digest([request.invocationId, request.callId, origin])}`;
    const prior = database.eventByRequestId(context.projectId, requestId);
    if (prior) {
      const receipt = prior.payload.receipt as ControlResultReceipt | undefined;
      if (prior.type !== "control.result.recorded" || receipt?.invocationId !== request.invocationId ||
        receipt.callId !== request.callId || !isDeepStrictEqual(receipt.origin, origin) ||
        !sameDurableSession(receipt.session, context.session)) {
        throw new OperationStoreViolationError("Journal result changed its immutable original caller");
      }
      return receipt.id;
    }
    const identity = { ...structuredClone(context), schemaVersion: 1 as const, callId: request.callId,
      acceptedCallId: request.callId, tool: request.action.tool, origin, result: structuredClone(result) };
    const id = digest(identity);
    const receipt: ControlResultReceipt = { ...identity, id,
      responseText: `${controlResultMarker(id)}\nLater durable journal observation for the original request. ` +
        "This supplements its earlier return, if any; it does not replay the operation, restore permissions, or prove native reception. " +
        `Recorded request provenance: operationAlreadyExisted=${request.operationAlreadyExisted}. ` +
        `Original operation facts: ${JSON.stringify(result)}` };
    database.appendEvent({ projectId: context.projectId, agentId: context.agentId, invocationId: context.invocationId,
      requestId, type: "control.result.recorded", payload: { receipt } });
    return id;
  };
  const observeNative = (event: Record<string, unknown>): void => {
    if (event.invocationId !== context.invocationId || event.harnessId !== context.session.harnessId ||
      typeof event.eventId !== "string" || !event.eventId) return;
    if (event.kind === "user.message" && typeof event.message === "string") {
      const prepared = database.eventByRequestId(context.projectId, notificationRequest(context.invocationId));
      const notification = prepared?.payload.notification as ResultNotification | undefined;
      if (prepared?.type !== "control.result.notification.prepared" || !notification ||
        !isDeepStrictEqual(notification.context, context) || !event.message.includes(notification.text)) return;
      for (const source of notification.results) {
        const saved = database.eventByRequestId(context.projectId, source.requestId ?? resultRequest(source.invocationId, source.callId));
        const receipt = saved?.payload.receipt as ControlResultReceipt | undefined;
        const requestId = `control-result-received:${source.id}`;
        if (saved?.type !== "control.result.recorded" || receipt?.id !== source.id ||
          receipt.invocationId !== source.invocationId || receipt.callId !== source.callId ||
          receipt.projectId !== context.projectId || receipt.agentId !== context.agentId ||
          !sameDurableSession(receipt.session, context.session) || database.eventByRequestId(context.projectId, requestId)) continue;
        database.appendEvent({ projectId: context.projectId, agentId: context.agentId, invocationId: context.invocationId,
          requestId, type: "control.result.received", payload: { receiptId: source.id, inputId: notification.inputId,
            originalInvocationId: source.invocationId, eventId: event.eventId, sourceType: event.sourceType,
            ...(typeof event.itemId === "string" ? { nativeMessageId: event.itemId } : {}), session: context.session } });
      }
      return;
    }
    const tool = event.tool as { callId?: unknown; name?: unknown; server?: unknown; toolType?: unknown; input?: unknown; outputPreview?: unknown } | undefined;
    if (!tool || typeof tool.callId !== "string" || !tool.callId) return;
    const requestId = nativeRequest(context.invocationId, tool.callId);
    if (event.kind === "tool.started" || event.kind === "tool.updated") {
      if (typeof tool.name !== "string") return;
      const name = tool.server === "openfars-resident-control" && tool.toolType === "mcp"
        ? tool.name
        : tool.name.match(/^mcp__openfars-resident-control__([a-z_]+)$/)?.[1];
      if (!name) return;
      let args: Record<string, unknown>;
      try { args = typeof tool.input === "string" ? JSON.parse(tool.input) : tool.input as Record<string, unknown>; }
      catch { return; }
      if (!args || typeof args !== "object" || typeof args.callId !== "string" || !args.callId) return;
      const binding = { context, nativeCallId: tool.callId, callId: args.callId, tool: name };
      const prior = database.eventByRequestId(context.projectId, requestId);
      if (prior) {
        if (!isDeepStrictEqual(prior.payload.binding, binding)) throw new OperationStoreViolationError("Native control call changed its original binding");
        return;
      }
      database.appendEvent({ projectId: context.projectId, agentId: context.agentId, invocationId: context.invocationId,
        requestId, type: "control.result.native_call", payload: { binding, eventId: event.eventId } });
      return;
    }
    if (event.kind !== "tool.completed" || typeof tool.outputPreview !== "string") return;
    const source = database.eventByRequestId(context.projectId, requestId);
    const binding = source?.payload.binding as { context?: ControlResultContext; callId?: string; tool?: string } | undefined;
    if (source?.type !== "control.result.native_call" || !binding?.callId || !isDeepStrictEqual(binding.context, context)) return;
    const saved = database.eventByRequestId(context.projectId, resultRequest(context.invocationId, binding.callId));
    const receipt = saved?.payload.receipt as ControlResultReceipt | undefined;
    if (saved?.type !== "control.result.recorded" || !receipt || receipt.tool !== binding.tool ||
      receipt.projectId !== context.projectId || receipt.agentId !== context.agentId || receipt.invocationId !== context.invocationId ||
      !isDeepStrictEqual(receipt.session, context.session) || !isDeepStrictEqual(receipt.executionContext, context.executionContext) ||
      !tool.outputPreview.includes(controlResultMarker(receipt.id))) return;
    const receivedRequest = `control-result-received:${receipt.id}`;
    if (database.eventByRequestId(context.projectId, receivedRequest)) return;
    database.appendEvent({ projectId: context.projectId, agentId: context.agentId, invocationId: context.invocationId,
      requestId: receivedRequest, type: "control.result.received", payload: { receiptId: receipt.id,
        nativeCallId: tool.callId, eventId: event.eventId, sourceType: event.sourceType, session: context.session } });
  };
  return { record, recordJournalResult, observeNative, prepareNotification };
}
