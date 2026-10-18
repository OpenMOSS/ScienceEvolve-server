import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationStateDatabase } from "../src/collaboration-state/store.js";
import { cloneAgentOrchestrationTemplate } from "../src/agent-orchestration.js";
import { mergeAgentConfigs } from "../src/validation.js";
import type { SerialMainWorkflowAdjustmentInput, SerialWorkflowPublicationAuthority } from "../src/serial-workflow-adjustment-contracts.js";
import type { WorkflowSessionState } from "../src/workflow-session-compatibility.js";
import type { TimelineEvent } from "../src/types.js";

const roots: string[] = [], stores: CollaborationStateDatabase[] = [];
afterEach(async () => { stores.splice(0).forEach(store => store.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(allowMain = true, git = false, marked = true) {
  const root = await mkdtemp(join(tmpdir(), "openfars-serial-workflow-")); roots.push(root);
  const options = { databasePath: join(root, "state.sqlite"), serviceId: "serial-fixture", hostId: "test", instanceId: "writer",
    topology: "single-host" as const, now: () => 1_000_000 };
  const database = CollaborationStateDatabase.open(options); stores.push(database);
  const orchestration = cloneAgentOrchestrationTemplate(); orchestration.allowMainReconfiguration = allowMain;
  database.createProject({ projectId: "sdk", workflowRevision: 1, workflowSnapshot: orchestration, workerCapacity: 2,
    git: { enabled: git, status: git ? "ready" : "disabled" } });
  const agents = mergeAgentConfigs(undefined, orchestration);
  database.initializeScopedConfiguration("sdk", { agents, skillDefinitions: {}, mcpDefinitions: {} });
  if (!git && marked) database.initializeSerialWorkflowJournal("sdk");
  const session = { schemaVersion: 1 as const, harnessId: "codex", adapterVersion: "fixture", nativeId: "original-sdk-main", generation: 0, durable: true, createdAt: "2026-10-11T00:00:00.000Z" };
  const sessions: WorkflowSessionState = { agents, agentSessions: { main: session }, agentSessionIds: { main: session.nativeId } };
  const runtime = { waiting: undefined as string | undefined };
  const authority: SerialWorkflowPublicationAuthority = { sessions, waitingReason: () => runtime.waiting };
  // These are controlled serial bridge identities, not a real SDK process or
  // fabricated S node/group/native-stop receipts.
  const main = (): SerialMainWorkflowAdjustmentInput => {
    const current = database.workflowAdjustmentCurrent("sdk"), proposal = structuredClone(current.snapshot);
    proposal.agents.idea.instructions = "Exact accepted serial Main proposal";
    return { projectId: "sdk", agentExecutionId: "original-sdk-task", mainInvocationSeq: 7, base: current.version, proposal, session,
      envelope: { schemaVersion: 1, projectId: "sdk", agent: "main", invocationId: "original-sdk-invocation", callId: "actual-apply-call",
        stateVersion: 41, capabilityHash: "a".repeat(64), receivedAt: "2026-10-11T00:00:00.000Z",
        action: { tool: "apply_workflow", path: "workflow.json", rationale: "Actual public Main explanation" } } };
  };
  const user = (requestId = "serial-user") => {
    const current = database.workflowAdjustmentCurrent("sdk"), proposal = structuredClone(current.snapshot);
    proposal.agents.idea.instructions = "Exact user priority proposal";
    return { projectId: "sdk", requestId, base: current.version, proposal, explanation: "User's independent explanation" };
  };
  const publish = (requestId: string, store = database) => {
    const prepared = store.prepareSerialWorkflowAdjustmentPublication("sdk", requestId);
    return prepared.ready ? store.publishSerialWorkflowAdjustment("sdk", requestId, prepared.validationToken, authority) : prepared.publication;
  };
  return { root, options, database, sessions, runtime, authority, main, user, publish };
}

describe("non-Git serial workflow journal foundation", () => {
  it("requires explicit serial initialization and keeps initialization idempotent without changing authority", async () => {
    const f = await fixture(true, false, false), before = f.database.workflowAdjustmentCurrent("sdk");
    expect(() => f.database.stageSerialMainWorkflowAdjustment(f.main())).toThrow(/explicitly initialized/);
    f.database.initializeSerialWorkflowJournal("sdk"); const events = f.database.eventsAfter("sdk", 0, 1000);
    f.database.initializeSerialWorkflowJournal("sdk"); expect(f.database.eventsAfter("sdk", 0, 1000)).toEqual(events);
    expect(f.database.workflowAdjustmentCurrent("sdk")).toEqual(before);
    expect(f.database.stageSerialMainWorkflowAdjustment(f.main()).record.status).toBe("pending");
  });

  it("prevents the generic user publisher from bypassing actual serial scheduling authority", async () => {
    const f = await fixture(), input = f.user(); f.database.submitUserWorkflowAdjustment(input);
    const prepared = f.database.prepareUserWorkflowAdjustmentPublication("sdk", input.requestId); if (!prepared.ready) throw new Error("Expected ready proposal");
    expect(() => f.database.publishUserWorkflowAdjustment("sdk", input.requestId, prepared.validationToken, f.sessions)).toThrow(/actual scheduler authority/);
    expect(f.database.workflowAdjustmentCurrent("sdk").version.revision).toBe(1);
    expect(f.publish(input.requestId)).toMatchObject({ status: "applied", workflowRevision: 2 });
  });
  it("persists the real serial tool, task and complete proposal without S business identities", async () => {
    const f = await fixture(), input = f.main(), before = f.database.workflowAdjustmentCurrent("sdk");
    const accepted = f.database.stageSerialMainWorkflowAdjustment(input);
    expect(accepted.record).toMatchObject({ status: "pending", base: before.version, baseSnapshot: before.snapshot, proposal: input.proposal,
      explanation: input.envelope.action.rationale, source: { kind: "main", invocationId: input.envelope.invocationId, callId: input.envelope.callId,
        session: input.session, scope: { kind: "serial", agentExecutionId: input.agentExecutionId, mainInvocationSeq: 7 } } });
    expect(accepted.record.source).not.toHaveProperty("nodeRunId"); expect(accepted.record.source).not.toHaveProperty("routeEpoch");
    expect(f.database.eventByRequestId("sdk", accepted.record.requestId)).toMatchObject({ type: "serial.main.workflow.accepted", payload: { input } });
    const projection = f.database.projectState("sdk"); expect(projection.nodeRuns).toEqual([]); expect(projection.groupRuns).toEqual([]); expect(projection.executions).toEqual([]);
    expect(f.database.eventsAfter("sdk", 0, 1000).some(event => /main\.route|native_binding|native.*stopped|scoped\.leader/.test(event.type))).toBe(false);
    input.proposal.agents.idea.instructions = "Later unsubmitted file edit";
    expect(f.database.workflowAdjustment("sdk", accepted.record.requestId)!.proposal.agents.idea.instructions).toBe("Exact accepted serial Main proposal");
    expect(f.publish(accepted.record.requestId)).toMatchObject({ status: "applied", workflowRevision: 2 });
    expect(f.database.workflowAdjustmentCurrent("sdk").snapshot.agents.idea.instructions).toBe("Exact accepted serial Main proposal");
  });

  it("retains the exact accepted proposal and status across close/reopen and repeated acceptance", async () => {
    const f = await fixture(), input = f.main(), first = f.database.stageSerialMainWorkflowAdjustment(input), writerLease = f.database.writerLease();
    f.database.close(); const reopened = CollaborationStateDatabase.open({ ...f.options, writerLease }); stores.push(reopened);
    expect(reopened.stageSerialMainWorkflowAdjustment(input)).toMatchObject({ replay: true, record: first.record });
    expect(f.publish(first.record.requestId, reopened)).toMatchObject({ status: "applied", workflowRevision: 2 });
    const events = reopened.eventsAfter("sdk", 0, 1000);
    expect(reopened.stageSerialMainWorkflowAdjustment(input).record.status).toBe("applied");
    expect(f.publish(first.record.requestId, reopened)).toMatchObject({ status: "applied", workflowRevision: 2, replay: true });
    expect(reopened.eventsAfter("sdk", 0, 1000)).toEqual(events);
  });

  it.each(["proposal", "explanation", "task", "session", "base"] as const)("rejects changed %s under the original accepted tool identity", async changed => {
    const f = await fixture(), input = f.main(); f.database.stageSerialMainWorkflowAdjustment(input);
    const original = f.database.eventsAfter("sdk", 0, 1000);
    if (changed === "proposal") input.proposal.agents.idea.instructions += " Changed";
    if (changed === "explanation" && input.envelope.action.tool === "apply_workflow") input.envelope.action.rationale += " Changed";
    if (changed === "task") input.agentExecutionId += "-another";
    if (changed === "session") input.session = { ...input.session!, nativeId: "another-native" };
    if (changed === "base") input.base = { ...input.base, revision: 2 };
    expect(() => f.database.stageSerialMainWorkflowAdjustment(input)).toThrow(/changed on replay/);
    expect(f.database.eventsAfter("sdk", 0, 1000)).toEqual(original);
  });

  it("keeps user authority independent from Main's disabled editing flag", async () => {
    const f = await fixture(false);
    expect(() => f.database.stageSerialMainWorkflowAdjustment(f.main())).toThrow(/disabled/);
    const input = f.user(); f.database.submitUserWorkflowAdjustment(input);
    expect(f.publish(input.requestId)).toMatchObject({ status: "applied", workflowRevision: 2 });
    expect(f.database.workflowAdjustmentCurrent("sdk").snapshot.orchestration.allowMainReconfiguration).toBe(false);
  });

  it("does not allow Main to change its own editing authority", async () => {
    const f = await fixture(), input = f.main(); input.proposal.orchestration.allowMainReconfiguration = false;
    expect(() => f.database.stageSerialMainWorkflowAdjustment(input)).toThrow(/authority/);
    expect(f.database.workflowAdjustments("sdk")).toEqual([]);
  });

  it("rejects a stale complete base before acceptance without rewriting the original proposal", async () => {
    const f = await fixture(), main = f.main(), user = f.user();
    f.database.submitUserWorkflowAdjustment(user); f.publish(user.requestId);
    const proposal = structuredClone(main.proposal), events = f.database.eventsAfter("sdk", 0, 1000);
    expect(() => f.database.stageSerialMainWorkflowAdjustment(main)).toThrow(/配置已发生修改/);
    expect(main.proposal).toEqual(proposal); expect(f.database.eventsAfter("sdk", 0, 1000)).toEqual(events);
  });

  it("waits for the serial scheduler's original logical owner without changing the proposal or Session", async () => {
    const f = await fixture(), accepted = f.database.stageSerialMainWorkflowAdjustment(f.main()), sessions = structuredClone(f.sessions);
    f.runtime.waiting = "等待原 SDK 逻辑任务的结果落盘和原生停止确认：original-sdk-task";
    expect(f.publish(accepted.record.requestId)).toMatchObject({ status: "pending", workflowRevision: 1, reason: f.runtime.waiting });
    const events = f.database.eventsAfter("sdk", 0, 1000); expect(f.publish(accepted.record.requestId)).toMatchObject({ status: "pending", replay: true });
    expect(f.database.eventsAfter("sdk", 0, 1000)).toEqual(events); expect(f.sessions).toEqual(sessions);
    f.runtime.waiting = undefined;
    expect(f.publish(accepted.record.requestId)).toMatchObject({ status: "applied", workflowRevision: 2 });
    expect(f.sessions).toEqual(sessions);
  });

  it("gives the pending same-base user request priority and never rebases the original Main snapshot", async () => {
    const f = await fixture(), main = f.main(), accepted = f.database.stageSerialMainWorkflowAdjustment(main), user = f.user();
    f.database.submitUserWorkflowAdjustment(user);
    expect(f.publish(accepted.record.requestId)).toMatchObject({ status: "pending", reason: expect.stringContaining(user.requestId) });
    expect(f.publish(user.requestId)).toMatchObject({ status: "applied", workflowRevision: 2 });
    expect(f.publish(accepted.record.requestId)).toMatchObject({ status: "needs_resubmission", workflowRevision: 2 });
    expect(f.database.stageSerialMainWorkflowAdjustment(main).record).toMatchObject({ status: "needs_resubmission", proposal: main.proposal, base: main.base });
  });

  it("honors withdrawal after token preparation and does not call scheduler authority", async () => {
    const f = await fixture(), input = f.main(), accepted = f.database.stageSerialMainWorkflowAdjustment(input);
    const prepared = f.database.prepareSerialWorkflowAdjustmentPublication("sdk", accepted.record.requestId); if (!prepared.ready) throw new Error("Expected ready proposal");
    f.database.withdrawWorkflowAdjustment({ projectId: "sdk", requestId: accepted.record.requestId, operationId: "withdraw-original", note: "Keep the original plan" });
    const guard = vi.fn(() => undefined);
    expect(f.database.publishSerialWorkflowAdjustment("sdk", accepted.record.requestId, prepared.validationToken, { sessions: f.sessions, waitingReason: guard })).toMatchObject({ status: "withdrawn", workflowRevision: 1 });
    expect(guard).not.toHaveBeenCalled(); expect(f.database.stageSerialMainWorkflowAdjustment(input).record.status).toBe("withdrawn");
  });

  it.each(["missing", "async", "wrong-token", "blank", "too-long"] as const)("rejects %s publication authority without changing configuration", async invalid => {
    const f = await fixture(), accepted = f.database.stageSerialMainWorkflowAdjustment(f.main()), before = f.database.workflowAdjustmentCurrent("sdk");
    const prepared = f.database.prepareSerialWorkflowAdjustmentPublication("sdk", accepted.record.requestId); if (!prepared.ready) throw new Error("Expected ready proposal");
    const authority = invalid === "missing" ? undefined : invalid === "async" ? { sessions: f.sessions, waitingReason: async () => undefined }
      : invalid === "blank" || invalid === "too-long" ? { sessions: f.sessions, waitingReason: () => invalid === "blank" ? "" : "x".repeat(20_001) } : f.authority;
    expect(() => f.database.publishSerialWorkflowAdjustment("sdk", accepted.record.requestId, invalid === "wrong-token" ? "wrong" : prepared.validationToken, authority as any)).toThrow();
    expect(f.database.workflowAdjustmentCurrent("sdk")).toEqual(before); expect(f.database.workflowAdjustment("sdk", accepted.record.requestId)!.status).toBe("pending");
  });

  it("does not let a scheduler's mutable validation copy rewrite the immutable applied proposal", async () => {
    const f = await fixture(), input = f.main(), accepted = f.database.stageSerialMainWorkflowAdjustment(input);
    f.authority.waitingReason = record => { record.proposal.agents.idea.instructions = "Mutated guard copy"; return undefined; };
    expect(f.publish(accepted.record.requestId)).toMatchObject({ status: "applied", workflowRevision: 2 });
    expect(f.database.workflowAdjustmentCurrent("sdk").snapshot.agents.idea.instructions).toBe(input.proposal.agents.idea.instructions);
  });

  it("protects the original Main Harness at acceptance and a late Worker Session at publication", async () => {
    const f = await fixture(), main = f.main(); main.proposal.agents.main.harness = "claude-code";
    expect(() => f.database.stageSerialMainWorkflowAdjustment(main)).toThrow(/Session.*Harness/);
    const next = f.main(); next.proposal.agents.idea.harness = "claude-code";
    const accepted = f.database.stageSerialMainWorkflowAdjustment(next), original = { ...next.session!, nativeId: "original-worker" };
    f.sessions.agentSessions!.idea = original; f.sessions.agentSessionIds!.idea = original.nativeId;
    expect(f.publish(accepted.record.requestId)).toMatchObject({ status: "pending", workflowRevision: 1, reason: expect.stringContaining("Harness") });
    expect(f.sessions.agentSessions!.idea).toBe(original);
  });

  it("does not enter a Git project or replace S's existing business ownership", async () => {
    const git = await fixture(true, true); expect(() => git.database.stageSerialMainWorkflowAdjustment(git.main())).toThrow(/cannot replace/);
    const f = await fixture(); f.database.activateNode({ projectId: "sdk", nodeRunId: "real-existing-node", node: { kind: "agent", nodeId: "main", agentId: "main" },
      activationRequestId: "real-existing-activation", inputSnapshotRef: "original-input", activatedByAgentId: "main", workflowRevision: 1 });
    const events = f.database.eventsAfter("sdk", 0, 1000);
    expect(() => f.database.stageSerialMainWorkflowAdjustment(f.main())).toThrow(/cannot replace/);
    expect(f.database.eventsAfter("sdk", 0, 1000)).toEqual(events);
  });

  it("rolls back configuration, revision and applied receipt together if a final journal write fails", async () => {
    const f = await fixture(), accepted = f.database.stageSerialMainWorkflowAdjustment(f.main()), before = f.database.workflowAdjustmentCurrent("sdk");
    const raw = new DatabaseSync(f.options.databasePath);
    raw.exec("CREATE TRIGGER fail_serial_application BEFORE INSERT ON project_events WHEN NEW.event_type = 'workflow.adjustment.transitioned' AND json_extract(NEW.payload_json, '$.transition.status') = 'applied' BEGIN SELECT RAISE(ABORT, 'controlled serial application failure'); END");
    try { expect(() => f.publish(accepted.record.requestId)).toThrow(/controlled serial application failure/); }
    finally { raw.close(); }
    expect(f.database.workflowAdjustmentCurrent("sdk")).toEqual(before);
    expect(f.database.workflowAdjustment("sdk", accepted.record.requestId)!.status).toBe("pending");
    expect(f.database.verifyHealth().integrity).toBe("ok");
  });

  it.each(["serial-main-workflow:forged", "serial-main-workflow-boundary:forged", "serial-workflow-input:forged"])("reserves serial tool identity %s from user submissions", async requestId => {
    const f = await fixture(), user = f.user(requestId);
    expect(() => f.database.submitUserWorkflowAdjustment(user)).toThrow(/reserved/);
    expect(f.database.workflowAdjustments("sdk")).toEqual([]);
  });

  it("binds a result boundary only to the exact accepted original project, task, invocation and Main sequence", async () => {
    const f = await fixture(), input = f.main(), accepted = f.database.stageSerialMainWorkflowAdjustment(input).record;
    const completion: TimelineEvent = { id: "original-result-event", projectId: "sdk", seq: 42,
      ts: "2026-10-11T00:01:00.000Z", type: "invocation.completed", agent: "main", message: "Original result committed",
      data: { invocationId: input.envelope.invocationId, executionId: input.agentExecutionId, mainInvocationSeq: input.mainInvocationSeq } };
    for (const altered of [
      { ...completion, projectId: "another-project" },
      { ...completion, data: { ...completion.data, invocationId: "another-invocation" } },
      { ...completion, data: { ...completion.data, executionId: "another-task" } },
      { ...completion, data: { ...completion.data, mainInvocationSeq: input.mainInvocationSeq + 1 } }
    ]) {
      expect(() => f.database.recordSerialMainWorkflowBoundary("sdk", accepted.requestId, altered)).toThrow(/exact original/);
      expect(f.database.serialMainWorkflowBoundaryCommitted("sdk", accepted.requestId)).toBe(false);
    }
    f.database.recordSerialMainWorkflowBoundary("sdk", accepted.requestId, completion);
    f.database.recordSerialMainWorkflowBoundary("sdk", accepted.requestId, structuredClone(completion));
    expect(f.database.serialMainWorkflowBoundaryCommitted("sdk", accepted.requestId)).toBe(true);
    expect(() => f.database.recordSerialMainWorkflowBoundary("sdk", accepted.requestId, { ...completion, seq: 43 })).toThrow(/changed on replay/);
    expect(f.database.workflowAdjustment("sdk", accepted.requestId)!.status).toBe("pending");
    expect(f.database.workflowAdjustmentCurrent("sdk").version).toEqual(accepted.base);
  });
});
