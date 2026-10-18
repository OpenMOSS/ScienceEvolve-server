import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationStateDatabase } from "../src/collaboration-state/store.js";
import { cloneAgentOrchestrationTemplate } from "../src/agent-orchestration.js";
import { mergeAgentConfigs } from "../src/validation.js";
import type { SerialWorkflowNotificationContext } from "../src/serial-workflow-notifications.js";
import type { SessionRef } from "../src/harness-runtime/contracts.js";

const roots: string[] = [], stores: CollaborationStateDatabase[] = [];
afterEach(async () => { stores.splice(0).forEach(store => store.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openfars-serial-notification-")); roots.push(root);
  let clock = Date.now();
  const options = { databasePath: join(root, "state.sqlite"), serviceId: "serial-notification", hostId: "test", topology: "single-host" as const, now: () => clock };
  const database = CollaborationStateDatabase.open(options); stores.push(database);
  const orchestration = cloneAgentOrchestrationTemplate(); orchestration.allowMainReconfiguration = false;
  const agents = mergeAgentConfigs(undefined, orchestration);
  database.createProject({ projectId: "original-project", workflowRevision: 1, workflowSnapshot: orchestration, workerCapacity: 1, git: { enabled: false, status: "disabled" } });
  database.initializeScopedConfiguration("original-project", { agents, skillDefinitions: {}, mcpDefinitions: {} }); database.initializeSerialWorkflowJournal("original-project");
  const context: SerialWorkflowNotificationContext = { projectId: "original-project", agentId: "main", invocationId: "original-invocation", agentExecutionId: "original-task", mainInvocationSeq: 1 };
  const session: SessionRef = { schemaVersion: 1, harnessId: "codex", nativeId: "original-observed-session", adapterVersion: "test", generation: 0, durable: true, createdAt: new Date().toISOString() };
  const accept = (id: string, agent = "idea") => {
    const current = database.workflowAdjustmentCurrent(context.projectId), proposal = structuredClone(current.snapshot);
    proposal.agents[agent].instructions = `Original immutable user proposal ${id}`;
    return database.submitUserWorkflowAdjustment({ projectId: context.projectId, requestId: id, base: current.version, proposal, explanation: `Original explanation ${id}` }).record;
  };
  const apply = (id: string) => {
    const prepared = database.prepareSerialWorkflowAdjustmentPublication(context.projectId, id);
    if (!prepared.ready) throw new Error("Controlled original proposal must be ready");
    return database.publishSerialWorkflowAdjustment(context.projectId, id, prepared.validationToken, { sessions: { agents }, waitingReason: () => undefined });
  };
  const received = () => database.eventsAfter(context.projectId, 0, 1000).filter(event => event.type === "workflow.adjustment.notification.received");
  const observe = (inputId: string, message: string, actual = session, changes = {}) => database.confirmSerialWorkflowAdjustmentInput(context, inputId, actual,
    { kind: "user.message", eventId: "original-native-user-input", invocationId: context.invocationId, harnessId: actual.harnessId, message, ...changes });
  return { root, options, database, context, session, accept, apply, received, observe, expireWriter: () => { clock += 100_000; } };
}

describe("Ordinary invocation workflow notification intent and actual receipt", () => {
  it("prepares before a new native Session exists and binds only the actual complete received input, atomically and once", async () => {
    const f = await fixture(); f.accept("original-change"); f.apply("original-change");
    const input = f.database.prepareSerialWorkflowAdjustmentInput(f.context, "original-input")!;
    expect(input.expectedSession).toBeUndefined(); expect(input.context).toEqual(f.context); expect(f.received()).toEqual([]);
    f.observe(input.inputId, input.text); f.observe(input.inputId, input.text);
    expect(f.received()).toHaveLength(1);
    expect(f.received()[0].payload).toMatchObject({ requestId: "original-change", status: "applied", context: { session: f.session }, serialScope: f.context });
    expect(f.database.projectState(f.context.projectId).nodeRuns).toEqual([]);
    expect(f.database.projectState(f.context.projectId).executions).toEqual([]);
    expect(() => f.observe(input.inputId, input.text, { ...f.session, nativeId: "different-session" })).toThrow(/actually observed/);
    expect(f.received()).toHaveLength(1);
  });

  it("retains an intended original Session, rejects a replacement and skips decoding already received proposal history", async () => {
    const f = await fixture(); f.accept("original-change"); f.apply("original-change");
    const input = f.database.prepareSerialWorkflowAdjustmentInput(f.context, "original-input", f.session)!;
    expect(() => f.observe(input.inputId, input.text, { ...f.session, nativeId: "replacement" })).toThrow(/different native Session/);
    expect(f.received()).toEqual([]); f.observe(input.inputId, input.text);
    const decode = vi.spyOn(f.database, "workflowAdjustment");
    expect(f.database.prepareSerialWorkflowAdjustmentInput(f.context, "next-input", { ...f.session, resumedAt: new Date().toISOString() })).toBeUndefined();
    expect(decode).not.toHaveBeenCalled();
  });

  it.each(["partial", "wrong-input", "wrong-invocation", "wrong-harness", "admission"])("does not count %s as actual reception", async mode => {
    const f = await fixture(); f.accept("original-change"); f.apply("original-change");
    const input = f.database.prepareSerialWorkflowAdjustmentInput(f.context, "original-input")!;
    f.observe(mode === "wrong-input" ? "another-input" : input.inputId, mode === "partial" ? input.text.slice(0, 50) : input.text, f.session,
      mode === "wrong-invocation" ? { invocationId: "another-invocation" } : mode === "wrong-harness" ? { harnessId: "pi" } : mode === "admission" ? { kind: "input.accepted" } : {});
    expect(f.received()).toEqual([]);
    expect(f.database.prepareSerialWorkflowAdjustmentInput(f.context, "retry-input", f.session)!.text).toContain("original-change");
  });

  it("keeps an already prepared input immutable while later facts wait for another legitimate input", async () => {
    const f = await fixture(); f.accept("original-change"); f.apply("original-change");
    const original = f.database.prepareSerialWorkflowAdjustmentInput(f.context, "original-input", f.session)!;
    f.accept("later-withdrawal"); f.database.withdrawWorkflowAdjustment({ projectId: f.context.projectId, requestId: "later-withdrawal", operationId: "actual-user-withdrawal", note: "Original public withdrawal explanation" });
    expect(f.database.prepareSerialWorkflowAdjustmentInput(f.context, original.inputId, f.session)).toEqual(original);
    const next = f.database.prepareSerialWorkflowAdjustmentInput(f.context, "next-input", f.session)!;
    expect(next.text).not.toContain("Original public withdrawal explanation");
    expect(JSON.stringify(next.facts)).toContain("Original public withdrawal explanation");
    f.observe(original.inputId, original.text); expect(f.received()).toHaveLength(1);
    f.observe(next.inputId, next.text); expect(f.received()).toHaveLength(2);
  });

  it("preserves prepared-but-unreceived facts across a real writer restart and observes a later original Session input", async () => {
    const f = await fixture(); f.accept("original-change"); f.apply("original-change");
    const input = f.database.prepareSerialWorkflowAdjustmentInput(f.context, "original-input", f.session)!;
    f.database.close(); f.expireWriter(); const reopened = CollaborationStateDatabase.open(f.options); stores.push(reopened);
    expect(reopened.prepareSerialWorkflowAdjustmentInput(f.context, input.inputId, f.session)).toEqual(input);
    const retry = reopened.prepareSerialWorkflowAdjustmentInput(f.context, "retry-after-restart", f.session)!;
    reopened.confirmSerialWorkflowAdjustmentInput(f.context, retry.inputId, f.session,
      { kind: "user.message", eventId: "actual-received-after-restart", invocationId: f.context.invocationId, harnessId: f.session.harnessId, message: retry.text });
    expect(reopened.eventsAfter(f.context.projectId, 0, 1000).filter(event => event.type === "workflow.adjustment.notification.received")).toHaveLength(1);
  });
});
