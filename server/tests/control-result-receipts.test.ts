import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollaborationStateDatabase } from "../src/collaboration-state/store.js";
import { controlResultReceipts, controlResultMarker, controlResultDisplayText, type ControlResultContext } from "../src/control-result-receipts.js";
import { OfficialEventBridge } from "../src/harness-runtime/official-event-bridge.js";
import { BUILTIN_HARNESS_DESCRIPTORS } from "../src/harness-runtime/registry.js";
import { mapCodexOfficialEvent } from "../src/harness-runtime/adapters/codex-event-mapper.js";
import { mapPiOfficialEvent } from "../src/harness-runtime/adapters/pi-event-mapper.js";
import { mapClaudeCodeOfficialEvent } from "../src/harness-runtime/adapters/claude-code-event-mapper.js";
import { dshOfficialEventMapper } from "../src/harness-runtime/adapters/dsh-event-mapper.js";
import type { ControlActionEnvelope } from "../src/types.js";
import type { RecordedAgentGitOperationRequest } from "../src/agent-git-operation-journal.js";
import type { queryAgentGitOperation } from "../src/agent-git-operation-query.js";
import { agentGitResultCoversOperation } from "../src/agent-git-result-proof.js";

const roots: string[] = [];
const databases: CollaborationStateDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(harnessId = "codex") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-control-receipt-")); roots.push(root);
  let writer = 0;
  let now = Date.parse("2026-10-09T00:00:00.000Z");
  const open = () => {
    now += 2_000;
    const database = CollaborationStateDatabase.open({ databasePath: path.join(root, "state.sqlite"),
      serviceId: "receipt-fixture", instanceId: `writer-${++writer}`, hostId: "fixture", topology: "single-host",
      leaseDurationMs: 1_000, now: () => now });
    databases.push(database); return database;
  };
  const database = open();
  database.createProject({ projectId: "project", workflowRevision: 1, workflowSnapshot: { schemaVersion: 3 },
    git: { enabled: false, status: "disabled" }, workerCapacity: 1 });
  const context: ControlResultContext = { projectId: "project", agentId: "worker", invocationId: "original-turn",
    session: { schemaVersion: 1, harnessId, adapterVersion: "1", generation: 0, nativeId: "original-session",
      durable: true, createdAt: "2026-10-09T00:00:00.000Z" },
    executionContext: { role: "delivery", nodeRunId: "node", executionId: "execution", ownershipEpoch: 3 } };
  const envelope: ControlActionEnvelope = { projectId: "project", agent: "worker", invocationId: context.invocationId,
    callId: "original-call", stateVersion: 3, receivedAt: context.session.createdAt,
    action: { tool: "github_merge_pr", providerNumber: 71 } };
  const input = { envelope, requestedCallId: envelope.callId, result: { providerNumber: 71, merged: true,
    mergeCommitSha: "a".repeat(40), base: "groups/direct" } };
  return { database, open, context, input, receipts: controlResultReceipts(database, context) };
}
function native(f: Awaited<ReturnType<typeof fixture>>, kind: string, overrides: Record<string, unknown> = {}) {
  return { invocationId: f.context.invocationId, harnessId: f.context.session.harnessId, eventId: `native-${kind}`,
    sourceType: "item.completed", kind, tool: { callId: "native-call", name: "github_merge_pr", server: "openfars-resident-control",
      toolType: "mcp", input: JSON.stringify({ callId: f.input.requestedCallId }), ...overrides } };
}

function mergedQuery(f: Awaited<ReturnType<typeof fixture>>) {
  const request: RecordedAgentGitOperationRequest = { schemaVersion: 1, operationAlreadyExisted: false,
    operationId: "original-merge", projectId: "project", executionId: "execution", ownershipEpoch: 3,
    agentId: "worker", invocationId: f.context.invocationId, callId: f.input.requestedCallId,
    requestedAt: f.context.session.createdAt, executionBranch: "executions/original", integrationTarget: "groups/direct",
    repository: { owner: "team", name: "original" }, expectedHead: "b".repeat(40),
    action: { tool: "github_merge_pr", providerNumber: 71 }, nativeBinding: { ...f.context,
      executionContext: f.context.executionContext!, runtimePath: "/original-runtime", worktreePath: "/original-worktree" } };
  const pull = { id: "pull-71", providerNumber: 71, owner: "team", repository: "original", ownerExecutionId: "execution",
    head: request.executionBranch, headSha: request.expectedHead!, base: request.integrationTarget,
    status: "merged", mergeCommitSha: "c".repeat(40) };
  const query: ReturnType<typeof queryAgentGitOperation> = { request, status: "completed", localStage: "synchronized",
    operation: { id: request.operationId, kind: "pull.merge", payloadHash: "d".repeat(64), status: "finalized",
      ownerExecutionId: request.executionId, ownershipEpoch: 3, expectedHead: request.expectedHead,
      expectedBase: request.integrationTarget, remoteFact: pull },
    localSynchronization: { projectId: "project", operationId: "exact-merged-sync", targetBranch: "groups/direct",
      temporaryRef: "refs/openfars/sync", expectedSourceHead: request.expectedHead!, mergeCommitSha: pull.mergeCommitSha,
      remoteHead: pull.mergeCommitSha, localHeadBefore: "a".repeat(40), localHeadAfter: pull.mergeCommitSha,
      status: "synchronized", observedAt: f.context.session.createdAt } };
  return { request, query, complete: { ...pull, localSynchronization: query.localSynchronization } };
}

describe("control result versus actual native Session reception", () => {
  it("clarifies displayed Git outcomes without changing saved receipts or duplicate replay", async () => {
    const f = await fixture();
    const input = { ...f.input, envelope: { ...f.input.envelope, action: { tool: "git_push" as const } },
      result: { status: "not_committed", checkpoint: { changed: false } } };
    const id = f.receipts.record(input);
    const saved = f.database.eventsAfter("project").filter(event => event.type === "control.result.recorded");
    const originalText = `${controlResultMarker(id)}\nAction git_push staged for atomic invocation commit. Provider result: ${JSON.stringify(input.result)} Continue the native Harness turn normally; additional non-conflicting tools remain available.`;
    expect(saved[0]?.payload.receipt).toMatchObject({ id, result: input.result, responseText: originalText });
    const display = controlResultDisplayText(input.envelope, input.result, id);
    expect(display.startsWith("Git result: not_committed.")).toBe(true);
    expect(display).toContain(originalText + "\n");
    expect(display).toContain("not Git staging, automatic Git commits, or successful business operations");
    f.database.close();
    const database = f.open();
    expect(controlResultReceipts(database, f.context).record(input)).toBe(id);
    expect(database.eventsAfter("project").filter(event => event.type === "control.result.recorded")).toEqual(saved);
    expect(() => controlResultReceipts(database, f.context).record({ ...input, result: { status: "pushed", checkpoint: { changed: false } } }))
      .toThrow("immutable facts");
    expect(database.eventsAfter("project").filter(event => event.type === "control.result.received")).toHaveLength(0);
  });

  it.each(["acknowledgement", "unknown", "sync-pending", "journal-pending"])(
    "delivers finalized synchronization after an actually received earlier %s without rewriting it", async stage => {
      const f = await fixture(), q = mergedQuery(f);
      const initial = stage === "acknowledgement" ? undefined : stage === "unknown" ? { status: "outcome_unknown" }
        : stage === "sync-pending" ? { ...q.complete, localSynchronization: undefined }
        : { ...q.query, operation: { ...q.query.operation, status: "observed" }, status: "remote_success_local_pending",
          localStage: "journal_finalization_pending" };
      const originalId = f.receipts.record({ ...f.input, result: initial });
      f.receipts.observeNative(native(f, "tool.started"));
      f.receipts.observeNative(native(f, "tool.completed", { outputPreview: controlResultMarker(originalId) }));
      const before = f.database.eventsAfter("project").filter(event => event.type === "control.result.recorded");
      const laterId = f.receipts.recordJournalResult(q.request, q.query)!;
      expect(laterId).toMatch(/^[a-f0-9]{64}$/); expect(laterId).not.toBe(originalId);
      expect(f.receipts.recordJournalResult(q.request, q.query)).toBe(laterId);
      expect(f.database.eventsAfter("project").filter(event => event.type === "control.result.recorded").slice(0, 1)).toEqual(before);
      expect(f.database.pendingControlResultEvents("project", "worker")).toHaveLength(1);
      f.database.close(); const database = f.open();
      const context = { ...f.context, invocationId: "next-authorized-original-session-turn" };
      const later = controlResultReceipts(database, context), notification = later.prepareNotification("next-input");
      expect(notification).toContain(controlResultMarker(laterId)); expect(notification).toContain("synchronized");
      expect(database.eventByRequestId("project", `control-result-received:${laterId}`)).toBeUndefined();
      later.observeNative({ ...context, harnessId: context.session.harnessId, kind: "user.message", eventId: "actual-next-input", message: notification });
      expect(database.pendingControlResultEvents("project", "worker")).toHaveLength(0);
      expect(database.eventByRequestId("project", `control-result-received:${laterId}`)?.payload.receiptId).toBe(laterId);
    });

  it("reuses a complete normal return but rejects borrowed or partial synchronization as final result proof", async () => {
    const f = await fixture(), q = mergedQuery(f);
    f.receipts.record({ ...f.input, result: q.complete });
    expect(f.receipts.recordJournalResult(q.request, q.query)).toBeUndefined();
    expect(agentGitResultCoversOperation(q.complete, q.query)).toBe(true);
    for (const wrong of [ { ...q.complete, headSha: "a".repeat(40) }, { ...q.complete, providerNumber: 72 },
      { ...q.complete, ownerExecutionId: "other" }, { ...q.complete, base: "groups/other" },
      { ...q.complete, mergeCommitSha: "a".repeat(40) },
      { ...q.complete, localSynchronization: { ...q.query.localSynchronization, expectedSourceHead: "a".repeat(40) } },
      { ...q.complete, localSynchronization: { ...q.query.localSynchronization, localHeadAfter: "a".repeat(40) } } ]) {
      expect(agentGitResultCoversOperation(wrong, q.query)).toBe(false);
    }
  });

  it("redelivers a saved result before the next same-Session decision and requires its actual native input", async () => {
    const f = await fixture(); const id = f.receipts.record(f.input);
    f.database.close(); const database = f.open();
    const context = { ...f.context, invocationId: "later-role-turn", session: { ...f.context.session, resumedAt: "2026-10-09T01:00:00.000Z" },
      executionContext: { role: "leader" as const, nodeRunId: "parent-node", groupRunId: "parent", coordinatorEpoch: 4 } };
    const later = controlResultReceipts(database, context);
    const text = later.prepareNotification("later-input");
    expect(text).toContain(controlResultMarker(id));
    expect(text).toContain('"merged":true');
    expect(text).toContain(f.context.invocationId);
    expect(text).toContain("does not restore previous permissions");
    expect(later.prepareNotification("later-input")).toBe(text);
    expect(database.eventsAfter("project").filter(event => event.type === "control.result.notification.prepared")).toHaveLength(1);
    expect(database.eventsAfter("project").filter(event => event.type === "control.result.received")).toHaveLength(0);
    const event = { invocationId: context.invocationId, harnessId: context.session.harnessId, eventId: "normal-user-input",
      sourceType: "item.completed", kind: "user.message", itemId: "native-user", message: text };
    later.observeNative({ ...event, kind: "lifecycle" });
    later.observeNative({ ...event, message: controlResultMarker(id) });
    later.observeNative({ ...event, invocationId: "foreign-turn" });
    expect(database.eventsAfter("project").filter(event => event.type === "control.result.received")).toHaveLength(0);
    later.observeNative(event); later.observeNative(event);
    expect(database.eventsAfter("project").filter(event => event.type === "control.result.received")).toEqual([
      expect.objectContaining({ invocationId: context.invocationId, payload: expect.objectContaining({ receiptId: id,
        inputId: "later-input", session: context.session, originalInvocationId: f.context.invocationId }) })
    ]);
    const next = controlResultReceipts(database, { ...context, invocationId: "next-turn" });
    expect(next.prepareNotification("next-input")).toBe("");
  });

  it("retains a prepared notification across writer handoff without accepting a different Session or caller", async () => {
    const f = await fixture(); f.receipts.record(f.input);
    const context = { ...f.context, invocationId: "notification-turn" };
    const prepared = controlResultReceipts(f.database, context);
    const text = prepared.prepareNotification("native-input");
    f.database.close(); const database = f.open();
    expect(controlResultReceipts(database, context).prepareNotification("native-input")).toBe(text);
    expect(() => controlResultReceipts(database, context).prepareNotification("changed-input")).toThrow("immutable");
    for (const different of [
      { ...context, agentId: "other-agent" },
      { ...context, session: { ...context.session, nativeId: "another-session" } },
      { ...context, session: { ...context.session, generation: 1 } }
    ]) {
      const other = controlResultReceipts(database, { ...different, invocationId: "other-turn" });
      expect(other.prepareNotification("other-input")).toBe("");
      other.observeNative({ kind: "user.message", invocationId: "other-turn", harnessId: different.session.harnessId,
        eventId: "foreign-input", message: text });
    }
    expect(database.eventsAfter("project").filter(event => event.type === "control.result.received")).toHaveLength(0);
  });

  it.each(["codex", "pi", "claude-code", "dsh"])("closes a pending result only from normal %s input on the original Session", async harness => {
    const f = await fixture(harness); const id = f.receipts.record(f.input);
    const context = { ...f.context, invocationId: "next-physical-turn" };
    const receipts = controlResultReceipts(f.database, context);
    const text = receipts.prepareNotification("original-followup-input");
    const frame = harness === "codex"
      ? { type: "item.completed", item: { type: "userMessage", id: "native-user", clientId: "original-followup-input", content: [{ type: "text", text }] } }
      : harness === "pi"
        ? { type: "message_end", message: { role: "user", content: [{ type: "text", text }] } }
        : harness === "claude-code"
          ? { type: "user", session_id: context.session.nativeId, message: { role: "user", content: [{ type: "text", text }] } }
          : { method: "session.event", params: { sessionId: context.session.nativeId, event: { type: "user/message", seq: 7,
            surfaceOp: "append", data: { id: "native-user", role: "user", source: { kind: "user" }, content: [{ type: "text", text }] } } } };
    const bridge = new OfficialEventBridge({ descriptor: BUILTIN_HARNESS_DESCRIPTORS.find(row => row.id === harness)!,
      invocationId: context.invocationId, mapEvent: harness === "codex" ? mapCodexOfficialEvent : harness === "pi" ? mapPiOfficialEvent
        : harness === "claude-code" ? mapClaudeCodeOfficialEvent : dshOfficialEventMapper(context.session.nativeId),
      onEvent: event => receipts.observeNative(event as unknown as Record<string, unknown>) });
    expect(f.database.pendingControlResultEvents("project", "worker")).toHaveLength(1);
    await bridge.accept(frame);
    expect(f.database.pendingControlResultEvents("project", "worker")).toHaveLength(0);
    expect(f.database.eventsAfter("project").filter(event => event.type === "control.result.received")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ receiptId: id, inputId: "original-followup-input" }) })
    ]);
  });

  it("bounds a native input with whole result facts and keeps the next result durable", async () => {
    const f = await fixture();
    const first = f.receipts.record({ ...f.input, result: { evidence: "A".repeat(20_000) } });
    const secondInput = { ...f.input, requestedCallId: "second-call", envelope: { ...f.input.envelope, callId: "second-call" },
      result: { evidence: "B".repeat(20_000) } };
    const second = f.receipts.record(secondInput);
    const later = controlResultReceipts(f.database, { ...f.context, invocationId: "later" });
    const text = later.prepareNotification("later-input");
    expect(text.length).toBeLessThanOrEqual(32_000);
    expect(text).toContain(controlResultMarker(first)); expect(text).not.toContain(controlResultMarker(second));
    later.observeNative({ kind: "user.message", invocationId: "later", harnessId: f.context.session.harnessId,
      eventId: "actual-input", message: text });
    const next = controlResultReceipts(f.database, { ...f.context, invocationId: "next" });
    expect(next.prepareNotification("next-input")).toContain(controlResultMarker(second));
    expect(f.database.pendingControlResultEvents("project", "worker")).toHaveLength(1);
  });

  it("does not confuse an earlier prepared input with the current native notification", async () => {
    const f = await fixture(); f.receipts.record(f.input);
    const old = controlResultReceipts(f.database, { ...f.context, invocationId: "interrupted-notice" }).prepareNotification("old-input");
    const current = controlResultReceipts(f.database, { ...f.context, invocationId: "current-notice" });
    const text = current.prepareNotification("current-input");
    expect(text).not.toBe(old);
    current.observeNative({ kind: "user.message", invocationId: "current-notice", harnessId: f.context.session.harnessId,
      eventId: "old-input-replayed", message: old });
    expect(f.database.pendingControlResultEvents("project", "worker")).toHaveLength(1);
  });

  it("retains a result through writer restart without claiming reception; only its original native return closes it", async () => {
    const f = await fixture(); const id = f.receipts.record(f.input);
    expect(f.database.eventsAfter("project").map(event => event.type)).not.toContain("control.result.received");
    f.database.close(); const reopened = f.open(); const receipts = controlResultReceipts(reopened, f.context);
    expect(receipts.record(f.input)).toBe(id);
    receipts.observeNative(native(f, "tool.started"));
    const saved = reopened.eventsAfter("project").find(event => event.type === "control.result.recorded")!.payload.receipt as { responseText: string };
    const result = native(f, "tool.completed", { outputPreview: JSON.stringify({ content: [{ type: "text", text: saved.responseText }] }) });
    receipts.observeNative(result); receipts.observeNative(result);
    expect(reopened.eventsAfter("project").filter(event => event.type === "control.result.recorded")).toHaveLength(1);
    expect(reopened.eventsAfter("project").filter(event => event.type === "control.result.received")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ receiptId: id, nativeCallId: "native-call", session: f.context.session }) })
    ]);
  });

  it.each(["codex", "pi", "claude-code", "dsh"])("uses the normal %s official tool result, without an Agent confirmation tool", async harness => {
    const f = await fixture(harness); const id = f.receipts.record(f.input);
    const text = controlResultMarker(id) + "\nActual provider result";
    const frames = harness === "codex" ? [
      { type: "item.started", item: { type: "mcpToolCall", id: "native-1", server: "openfars-resident-control",
        tool: "github_merge_pr", arguments: { callId: f.input.requestedCallId } } },
      { type: "item.completed", item: { type: "mcpToolCall", id: "native-1", server: "openfars-resident-control",
        tool: "github_merge_pr", status: "completed", result: { content: [{ type: "text", text }] } } }
    ] : harness === "pi" ? [
      { type: "tool_execution_start", toolCallId: "native-1", toolName: "mcp__openfars-resident-control__github_merge_pr", args: { callId: f.input.requestedCallId } },
      { type: "tool_execution_end", toolCallId: "native-1", toolName: "mcp__openfars-resident-control__github_merge_pr", result: { content: [{ type: "text", text }] } }
    ] : harness === "claude-code" ? [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "native-1", name: "mcp__openfars-resident-control__github_merge_pr", input: { callId: f.input.requestedCallId } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "native-1", content: text }] } }
    ] : [
      { method: "session.event", params: { sessionId: f.context.session.nativeId, event: { type: "tool/call", seq: 1,
        data: { callId: "native-1", name: "mcp__openfars-resident-control__github_merge_pr", arguments: JSON.stringify({ callId: f.input.requestedCallId }) } } } },
      { method: "session.event", params: { sessionId: f.context.session.nativeId, event: { type: "tool/result", seq: 2,
        data: { message: { role: "user", source: { kind: "tool", callId: "native-1" }, content: [
          { type: "tool-result", toolCallId: "native-1", content: [{ type: "text", text }] }
        ] } } } } }
    ];
    const bridge = new OfficialEventBridge({ descriptor: BUILTIN_HARNESS_DESCRIPTORS.find(d => d.id === harness)!,
      invocationId: f.context.invocationId, mapEvent: harness === "codex" ? mapCodexOfficialEvent
        : harness === "pi" ? mapPiOfficialEvent : harness === "claude-code" ? mapClaudeCodeOfficialEvent
          : dshOfficialEventMapper(f.context.session.nativeId),
      onEvent: event => f.receipts.observeNative(event as unknown as Record<string, unknown>) });
    for (const frame of frames) await bridge.accept(frame);
    expect(f.database.eventsAfter("project").filter(event => event.type === "control.result.received")).toHaveLength(1);
  });

  it.each(["original", "different-tool", "already-completed"])(
    "retains original Claude streamed arguments without borrowing %s call facts", async variant => {
      const f = await fixture("claude-code");
      const id = f.receipts.record(f.input);
      const saved = f.database.eventsAfter("project").find(event => event.type === "control.result.recorded")!;
      const text = (saved.payload.receipt as { responseText: string }).responseText;
      const name = "mcp__openfars-resident-control__github_merge_pr";
      const events: Array<{ kind: string; tool?: { callId: string; input?: unknown } }> = [];
      const bridge = new OfficialEventBridge({
        descriptor: BUILTIN_HARNESS_DESCRIPTORS.find(d => d.id === "claude-code")!,
        invocationId: f.context.invocationId, mapEvent: mapClaudeCodeOfficialEvent,
        onEvent: event => {
          events.push(event);
          f.receipts.observeNative(event as unknown as Record<string, unknown>);
        }
      });
      const result = { type: "user", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "native-stream-call", content: text }
      ] } };
      await bridge.accept({ type: "stream_event", event: { type: "content_block_start", index: 0,
        content_block: { type: "tool_use", id: "native-stream-call",
          name: variant === "different-tool" ? "mcp__business__lookup" : name, input: {} } } });
      expect(f.database.eventsAfter("project").some(event => event.type === "control.result.native_call")).toBe(false);
      if (variant === "already-completed") await bridge.accept(result);
      const completeUse = { type: "assistant", message: { role: "assistant", content: [
        { type: "tool_use", id: "native-stream-call", name, input: { callId: f.input.requestedCallId, providerNumber: 71 } }
      ] } };
      await bridge.accept(completeUse);
      await bridge.accept(completeUse);
      expect(f.database.eventsAfter("project").some(event => event.type === "control.result.received")).toBe(false);
      await bridge.accept(result);
      await bridge.finish();
      expect(events.filter(event => event.kind === "tool.started")).toHaveLength(1);
      expect(events.filter(event => event.kind === "tool.completed")).toHaveLength(1);
      const bindings = f.database.eventsAfter("project").filter(event => event.type === "control.result.native_call");
      const received = f.database.eventsAfter("project").filter(event => event.type === "control.result.received");
      if (variant === "original") {
        expect(events.filter(event => event.kind === "tool.updated")).toMatchObject([
          { tool: { callId: "native-stream-call", input: JSON.stringify({ callId: f.input.requestedCallId, providerNumber: 71 }) } }
        ]);
        expect(bindings).toHaveLength(1);
        expect(received).toEqual([expect.objectContaining({ payload: expect.objectContaining({
          receiptId: id, nativeCallId: "native-stream-call", session: f.context.session
        }) })]);
      } else {
        expect(bindings).toHaveLength(0);
        expect(received).toHaveLength(0);
      }
    });

  it.each(["wrong-server", "bare-name", "wrong-call", "wrong-result", "failed", "different-invocation", "different-harness", "different-session", "foreign-session-start", "no-start"])(
    "does not invent reception from %s evidence", async variant => {
      const f = await fixture(); const id = f.receipts.record(f.input);
      const started = native(f, "tool.started");
      const completed = native(f, "tool.completed", { outputPreview: controlResultMarker(id) });
      if (variant === "wrong-server") (started.tool as any).server = "business-plugin";
      if (variant === "bare-name") { delete (started.tool as any).server; delete (started.tool as any).toolType; }
      if (variant === "wrong-call") (started.tool as any).input = { callId: "other-call" };
      if (variant === "wrong-result") (completed.tool as any).outputPreview = controlResultMarker("f".repeat(64));
      if (variant === "failed") completed.kind = "tool.failed";
      if (variant === "different-invocation") completed.invocationId = "another-turn";
      if (variant === "different-harness") completed.harnessId = "pi";
      if (!["no-start", "foreign-session-start"].includes(variant)) f.receipts.observeNative(started);
      const observer = ["different-session", "foreign-session-start"].includes(variant) ? controlResultReceipts(f.database,
        { ...f.context, session: { ...f.context.session, nativeId: "another-session" } }) : f.receipts;
      if (variant === "foreign-session-start") observer.observeNative(started);
      observer.observeNative(completed);
      expect(f.database.eventsAfter("project").filter(event => event.type === "control.result.received")).toHaveLength(0);
    });

  it("preserves the original accepted action while correlating an equivalent new request call separately", async () => {
    const f = await fixture(); const first = f.receipts.record(f.input);
    const second = f.receipts.record({ ...f.input, requestedCallId: "equivalent-replay-call" });
    expect(first).not.toBe(second);
    expect(f.database.eventsAfter("project").filter(event => event.type === "control.result.recorded").map(event => event.payload.receipt))
      .toEqual([expect.objectContaining({ callId: "original-call", acceptedCallId: "original-call" }),
        expect.objectContaining({ callId: "equivalent-replay-call", acceptedCallId: "original-call" })]);
    expect(() => f.receipts.record({ ...f.input, result: { merged: false } })).toThrow("immutable facts");
    expect(() => f.receipts.record({ ...f.input, envelope: { ...f.input.envelope, agent: "other" } })).toThrow("original caller");
  });

  it("requires a valid durable Session and rejects a changed native call binding", async () => {
    const f = await fixture();
    expect(() => controlResultReceipts(f.database, { ...f.context, session: { ...f.context.session, durable: false } })).toThrow("durable native Session");
    expect(() => controlResultReceipts(f.database, { ...f.context, session: { ...f.context.session, generation: -1 } })).toThrow("durable native Session");
    f.receipts.observeNative(native(f, "tool.started"));
    expect(() => f.receipts.observeNative(native(f, "tool.updated", { input: { callId: "changed" } }))).toThrow("original binding");
  });
});
