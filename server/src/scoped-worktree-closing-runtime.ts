import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { AgentContextSources } from "./agent-context-index.js";
import type { CollaborationExecutionInputBuilder, CollaborationResidentHandle, CollaborationResidentLauncher } from "./collaboration-runtime.js";
import type { CollaborationStateDatabase } from "./collaboration-state/store.js";
import type { ScopedWorktreeClosingTurn } from "./collaboration-state/contracts.js";
import type { ProjectStorage } from "./storage.js";
import type { AgentRunRequest, AgentRunResult, ProjectState, TraceSink, WorktreeClosingScope } from "./types.js";
import type { CollaborationGitFacade } from "./collaboration-git/facade.js";
import { CollaborationGitError } from "./collaboration-git/errors.js";
import { scopedWorktreeClosingControlAuthorityFactory } from "./scoped-worktree-closing-control.js";
import { sameDurableSession } from "./control-result-receipts.js";
import { redactTrace } from "./utils.js";

type ClosingGit = Parameters<typeof scopedWorktreeClosingControlAuthorityFactory>[0]["git"];
interface Options {
  state: ProjectState; database: CollaborationStateDatabase; storage: ProjectStorage;
  launcher: CollaborationResidentLauncher; builder?: CollaborationExecutionInputBuilder; signal: AbortSignal;
  repository: Parameters<typeof scopedWorktreeClosingControlAuthorityFactory>[0]["repository"];
  /** Read-only observation uses ordinary retained authority; mutations use
   * the factory bound to the exact S-reserved supplement below. */
  observeGit: Pick<CollaborationGitFacade, "observeRestrictedWorktreeClosing" | "identifyRestrictedWorktreeClosing" | "observeRestrictedWorktreeClosingTarget">;
  gitForClosing(turn: ScopedWorktreeClosingTurn): ClosingGit;
  assertCurrent(): void;
  wait(): Promise<void>;
  publish(): Promise<void>;
  filesystem(): Promise<Parameters<CollaborationResidentLauncher["open"]>[0]["filesystemAuthorityInput"]>;
  decorate(request: AgentRunRequest): void;
  trace(agentId: string, invocationId: string): TraceSink;
  turnRequestFactory(request: AgentRunRequest): Parameters<CollaborationResidentLauncher["open"]>[0]["turnRequestFactory"];
  hasResident(key: string): boolean;
  register(key: string, handle: CollaborationResidentHandle): void;
  unregister(key: string): void;
  submit(handle: CollaborationResidentHandle, turn: { inputId: string; invocationId: string; prompt: string },
    retainNativeReturn: (result: AgentRunResult) => Promise<void>): Promise<AgentRunResult>;
}

/** Consumes only released direct-Leader grants. Original business completion,
 * report A, its budget and newer reservations stay in their existing lifecycle. */
export class ScopedWorktreeClosingRuntime {
  constructor(private readonly options: Options) {}

  private async stopped(turn: Pick<ScopedWorktreeClosingTurn, "agentId" | "nodeRunId" | "executionId" | "ownershipEpoch">, runtimePath: string) {
    const o = this.options;
    if (!o.launcher.stopScopedForRecovery) throw new Error("Original closing requires trusted exact-native Stop reconciliation");
    const proof = await o.launcher.stopScopedForRecovery({ state: structuredClone(o.state), agentId: turn.agentId, nodeRunId: turn.nodeRunId,
      scopeId: turn.executionId, role: "delivery", ownershipEpoch: turn.ownershipEpoch, executionRuntimePath: runtimePath });
    if (!proof.stopped || !Object.keys(proof.evidence).length) throw new Error("Original closing native Stop remains unproven");
    return proof.evidence;
  }

  private recordStopped(turn: ScopedWorktreeClosingTurn, evidence: Readonly<Record<string, unknown>>) {
    const db = this.options.database;
    if (db.scopedWorktreeClosingTurns(turn.projectId).find(saved => saved.invocationId === turn.invocationId)?.status === "stopped") return;
    db.stopScopedWorktreeClosingTurn({ ...turn, residentStopConfirmed: true, evidence,
      ...(turn.writerLeaseEpoch !== db.writerLease().epoch ? { priorWriterLeaseEpoch: turn.writerLeaseEpoch } : {}) });
  }

  async discover(): Promise<void> {
    const o = this.options, db = o.database;
    if (["completed", "cancelled"].includes(o.state.status) || o.state.archivedAt || o.state.orchestration.schemaVersion !== 3) return;
    for (const { execution, report, binding } of db.scopedWorktreeClosingDiscoveryOwners(o.state.id)) {
      await o.wait(); o.assertCurrent(); o.signal.throwIfAborted();
      const session = o.state.agentSessions?.[execution.agentId];
      if (!session || !sameDurableSession(session, binding.session)) throw new Error("Closing discovery cannot substitute the original durable Session");
      const evidence = await this.stopped({ agentId: execution.agentId, nodeRunId: binding.executionContext.nodeRunId,
        executionId: execution.id, ownershipEpoch: execution.ownershipEpoch }, binding.runtimePath);
      let observation;
      try {
        observation = await o.observeGit.identifyRestrictedWorktreeClosing({ ...execution, purpose: "delivery" }, execution.ownershipEpoch,
          { kind: execution.status === "completed" ? "completed-leftovers" : "bound-report-memory", reportHeadSha: report.headSha! }, o.signal);
      } catch (error) {
        if (!(error instanceof CollaborationGitError)) throw error;
        await o.wait(); o.assertCurrent(); o.signal.throwIfAborted();
        db.recordScopedWorktreeClosingDiscoveryFailure({ projectId: o.state.id, executionId: execution.id, agentId: execution.agentId,
          ownershipEpoch: execution.ownershipEpoch, executionBranch: execution.executionBranch, worktreePath: execution.worktreePath,
          reportHeadSha: report.headSha!, originalSession: session,
          originalStop: { invocationId: binding.invocationId, runtimePath: binding.runtimePath, residentStopConfirmed: true, evidence },
          reason: redactTrace(error.message).slice(0, 4000), errorCode: error.code, errorClass: error.name, trustedReadFailed: true });
        await o.publish(); continue;
      }
      await o.wait(); o.assertCurrent(); o.signal.throwIfAborted();
      if (!observation || db.scopedWorktreeClosingAlreadySettled(o.state.id, observation)) continue;
      db.recordScopedWorktreeClosingIssue({ projectId: o.state.id, executionId: execution.id, agentId: execution.agentId,
        ownershipEpoch: execution.ownershipEpoch, observation,
        originalStop: { invocationId: binding.invocationId, runtimePath: binding.runtimePath, residentStopConfirmed: true, evidence } });
      await o.publish();
    }
  }

  async reconcile(): Promise<void> {
    const o = this.options;
    if (o.state.status === "completed") return;
    for (const turn of o.database.scopedWorktreeClosingTurns(o.state.id)) {
      if (turn.completion) await o.storage.saveScopedWorktreeClosingCompletion(turn.completion);
      if (o.hasResident(`closing:${turn.invocationId}`)) continue;
      if (turn.status !== "stopped") {
        this.recordStopped(turn, await this.stopped(turn, turn.runtimePath));
        await o.publish();
      }
      await this.returnStopped(turn);
    }
  }

  private async returnStopped(turn: ScopedWorktreeClosingTurn): Promise<void> {
    const o = this.options, db = o.database;
    if (db.scopedWorktreeClosingReturn(o.state.id, turn.invocationId) || db.scopedWorktreeClosingSettlement(o.state.id, turn.invocationId) || o.signal.aborted ||
      ["completed", "cancelled"].includes(o.state.status) || o.state.archivedAt || db.projectState(o.state.id).frozen ||
      db.projectCancellationIntent(o.state.id) || !db.scopedWorktreeClosingCandidates(o.state.id).some(candidate =>
        candidate.executionId === turn.executionId && candidate.ownershipEpoch === turn.ownershipEpoch)) return;
    await o.wait(); o.assertCurrent(); o.signal.throwIfAborted();
    const session = o.state.agentSessions?.[turn.agentId];
    if (!session || !sameDurableSession(session, turn.originalSession)) {
      throw new Error("Closing return cannot substitute the original durable Session");
    }
    const execution = { id: turn.executionId, agentId: turn.agentId, purpose: "delivery" as const,
      ownershipEpoch: turn.ownershipEpoch, executionBranch: turn.executionBranch, worktreePath: turn.worktreePath };
    const observeDirectory = () => o.observeGit.observeRestrictedWorktreeClosing(execution, turn.ownershipEpoch,
      { kind: turn.kind, reportHeadSha: turn.reportHeadSha, paths: [...turn.paths] }, o.signal);
    let observation, observationFailure, targetObservationFailure;
    try {
      observation = await observeDirectory();
    } catch (error) {
      if (!(error instanceof CollaborationGitError)) throw error;
      observationFailure = { reason: redactTrace(error.message).slice(0, 4000), errorCode: error.code, errorClass: error.name };
    }
    const delivery = observation && db.scopedWorktreeClosingDelivery(o.state.id, turn.invocationId, observation).proof;
    if (delivery) {
      await o.wait(); o.assertCurrent(); o.signal.throwIfAborted();
      const evidence = await this.stopped(turn, turn.runtimePath);
      let target;
      try {
        target = await o.observeGit.observeRestrictedWorktreeClosingTarget(o.repository, execution, turn.ownershipEpoch,
          db.executionPullBase(o.state.id, turn.executionId), [...new Set([turn.reportHeadSha, delivery.business.pullRequest.mergeCommitSha!,
            ...(delivery.supplement ? [delivery.supplement.headSha, delivery.supplement.pullRequest.mergeCommitSha!] : [])])], o.signal);
      } catch (error) {
        if (!(error instanceof CollaborationGitError)) throw error;
        targetObservationFailure = { reason: redactTrace(error.message).slice(0, 4000), errorCode: error.code, errorClass: error.name };
      }
      // Fresh directory observation follows all awaited Stop/target reads.
      // No Pause wait or other asynchronous action separates it from S's gate.
      try { observation = await observeDirectory(); }
      catch (error) {
        if (!(error instanceof CollaborationGitError)) throw error;
        observation = undefined;
        observationFailure = { reason: redactTrace(error.message).slice(0, 4000), errorCode: error.code, errorClass: error.name };
      }
      o.assertCurrent(); o.signal.throwIfAborted();
      if (observation && target && db.settleScopedWorktreeClosing({ projectId: turn.projectId, executionId: turn.executionId,
        ownershipEpoch: turn.ownershipEpoch, agentId: turn.agentId, invocationId: turn.invocationId, observation, target,
        nativeStop: { invocationId: turn.invocationId, runtimePath: turn.runtimePath, residentStopConfirmed: true, evidence } })) {
        await o.publish(); return;
      }
    }
    o.assertCurrent(); o.signal.throwIfAborted();
    db.returnScopedWorktreeClosingToLeader({ projectId: turn.projectId, executionId: turn.executionId,
      ownershipEpoch: turn.ownershipEpoch, agentId: turn.agentId, invocationId: turn.invocationId,
      ...(observation ? { observation, ...(targetObservationFailure ? { targetObservationFailure } : {}) } : { observationFailure: observationFailure! }) });
    await o.publish();
  }

  async advance(): Promise<void> {
    const o = this.options, db = o.database;
    if (o.state.status === "completed" || o.state.orchestration.schemaVersion !== 3) return;
    await this.reconcile();
    for (const grant of db.scopedWorktreeClosingAuthorizations(o.state.id)) {
      if (!db.scopedWorktreeClosingCandidates(o.state.id).some(candidate => candidate.incidentId === grant.candidate.incidentId) ||
        db.scopedWorktreeClosingGrantFailure(o.state.id, grant.envelope.invocationId, grant.envelope.callId) ||
        db.scopedWorktreeClosingTurns(o.state.id).some(turn => turn.grantInvocationId === grant.envelope.invocationId && turn.grantCallId === grant.envelope.callId)) continue;
      await o.wait(); o.assertCurrent(); o.signal.throwIfAborted();
      const candidate = grant.candidate, session = o.state.agentSessions?.[candidate.agentId];
      if (!session || !sameDurableSession(session, candidate.originalSession)) throw new Error("Closing cannot substitute the original Agent's durable Session");
      const binding = db.latestAgentNativeSessionBinding(o.state.id, candidate.agentId);
      if (!binding || binding.invocationId !== (grant.continuation?.bindingInvocationId ?? candidate.originalInvocationId) ||
        binding.runtimePath !== (grant.continuation?.bindingRuntimePath ?? candidate.originalRuntimePath) ||
        binding.executionContext.role !== "delivery" || !sameDurableSession(binding.session, session)) throw new Error("Closing lost its original native binding");
      const stopped = await this.stopped({ ...candidate, nodeRunId: binding.executionContext.nodeRunId }, binding.runtimePath);
      const execution = { id: candidate.executionId, agentId: candidate.agentId, purpose: "delivery" as const, ownershipEpoch: candidate.ownershipEpoch,
        executionBranch: candidate.observation.branch, worktreePath: candidate.observation.worktreePath };
      let observation;
      try {
        observation = await o.observeGit.observeRestrictedWorktreeClosing(execution, candidate.ownershipEpoch,
          { kind: candidate.observation.kind, reportHeadSha: candidate.observation.reportHeadSha, paths: grant.paths }, o.signal);
      } catch (error) {
        if (!(error instanceof CollaborationGitError)) throw error;
        await o.wait(); o.assertCurrent(); o.signal.throwIfAborted();
        db.recordScopedWorktreeClosingGrantFailure({ projectId: o.state.id, executionId: candidate.executionId, agentId: candidate.agentId,
          ownershipEpoch: candidate.ownershipEpoch, grantInvocationId: grant.envelope.invocationId, grantCallId: grant.envelope.callId,
          originalStop: { invocationId: binding.invocationId, runtimePath: binding.runtimePath, residentStopConfirmed: true, evidence: stopped },
          reason: redactTrace(error.message).slice(0, 4000), errorCode: error.code, errorClass: error.name });
        await o.publish(); continue;
      }
      await o.wait(); o.assertCurrent(); o.signal.throwIfAborted();
      const invocationId = `inv_${randomUUID().replaceAll("-", "")}`, capability = randomUUID();
      const reserved = db.beginScopedWorktreeClosingTurn({ projectId: o.state.id, executionId: candidate.executionId, agentId: candidate.agentId,
        ownershipEpoch: candidate.ownershipEpoch, invocationId, runtimePath: path.join(path.dirname(binding.runtimePath), invocationId),
        capabilityHash: createHash("sha256").update(capability).digest("hex"), grantInvocationId: grant.envelope.invocationId, grantCallId: grant.envelope.callId,
        originalStop: { invocationId: binding.invocationId, runtimePath: binding.runtimePath, residentStopConfirmed: true, evidence: stopped }, observation });
      if (!reserved) continue; // Existing capacity/management/native owner keeps the exact grant pending.
      await o.publish();
      await this.run(reserved.turn, capability, grant.envelope.action.tool === "coordinate_group_task" ? grant.envelope.action.rationale : "");
      await this.returnStopped(reserved.turn);
    }
  }

  private async run(turn: ScopedWorktreeClosingTurn, capability: string, rationale: string): Promise<void> {
    const o = this.options, db = o.database, key = `closing:${turn.invocationId}`;
    let handle: CollaborationResidentHandle | undefined;
    try {
      const scope: WorktreeClosingScope = { kind: turn.kind, reportHeadSha: turn.reportHeadSha, paths: [...turn.paths], executionId: turn.executionId,
        ownershipEpoch: turn.ownershipEpoch, grantInvocationId: turn.grantInvocationId, grantCallId: turn.grantCallId };
      const sources = new AgentContextSources();
      const assignment = ["Continue only the explicitly authorized closing of your original task in its original durable Session, branch and fixed worktree.",
        `Exact original authority: ${JSON.stringify(scope)}.`, `Your original direct Leader's instructions: ${rationale}`,
        sources.list("worktree-closing-history", "Actual earlier closing facts (no earlier capability is restored)", db.scopedRecoveryCandidates(o.state.id, turn.groupRunId)
          .find(candidate => candidate.executionId === turn.executionId)?.closingAttempts ?? []),
        "Inspect the source and purpose of these exact files. Deliver your necessary original results/Memory through explicit Git tools; remove only files you judge disposable. If source or scope is uncertain, preserve the files and describe the unresolved issue for your direct Leader.",
        "Original business report A, completed/failed status, finish, PR, automatic repair budget and newer task reservations remain immutable. Do not add business work or use A's historical PR as B delivery.",
        "If head B differs from A, explicitly publish that exact clean B, create its own PR to the original direct group target, merge it and verify local synchronization. Read the actual tool responses in this same Session. No B is required when you restore the directory to A without a necessary new commit.",
        "Call finish_task with your own optional supplemental Memory/summary, then return your actual closing output and any unresolved issue. This separate finish does not prove Git delivery, native reception, physical Stop or permission to start another task."
      ].join("\n\n");
      const inboxPath = await o.storage.writeInbox(o.state, turn.agentId, turn.invocationId, assignment);
      const context: NonNullable<AgentRunRequest["executionContext"]> = { role: "delivery", nodeRunId: turn.nodeRunId, groupRunId: turn.groupRunId,
        executionId: turn.executionId, ownershipEpoch: turn.ownershipEpoch, executionWorktree: turn.worktreePath };
      const fallback: AgentRunRequest = { project: structuredClone(o.state), purpose: "workflow", kind: "worker", agent: turn.agentId,
        permission: "workspace", invocationId: turn.invocationId, inboxPath, projectPath: o.storage.projectDir(o.state.id), workspacePath: turn.worktreePath,
        schemaPath: "", skillPaths: [], autoSkillPaths: [], availableSkillPaths: [], runtimePath: turn.runtimePath,
        executionContext: context, worktreeClosing: scope, sessionContinuity: "strict", resumeThreadId: turn.originalSession.nativeId };
      const request = o.builder ? await o.builder.build({ state: o.state, agentId: turn.agentId, executionContext: context, assignment,
        invocationId: turn.invocationId, inboxPath, projectPath: fallback.projectPath, worktreePath: turn.worktreePath, runtimePath: turn.runtimePath, worktreeClosing: scope }) : fallback;
      o.decorate(request);
      request.contextSources = sources.sources;
      await o.wait(); o.assertCurrent(); o.signal.throwIfAborted();
      handle = await o.launcher.open({ request, executionRuntimePath: turn.runtimePath, filesystemAuthorityInput: await o.filesystem(), signal: o.signal,
        onTrace: o.trace(turn.agentId, turn.invocationId), onOpened: async () => { db.markScopedWorktreeClosingOpened({ ...turn, nativeProcessOpened: true }); await o.publish(); },
        sameEpochReopen: { previousRuntimePath: turn.previousRuntimePath, revalidate: async () => {
          o.assertCurrent(); o.signal.throwIfAborted();
          // Filesystem and native preparation may outlast the observation's
          // freshness window. Read exact Git facts at each authority boundary.
          const observation = await o.observeGit.observeRestrictedWorktreeClosing({ id: turn.executionId, agentId: turn.agentId,
            purpose: "delivery", ownershipEpoch: turn.ownershipEpoch, executionBranch: turn.executionBranch, worktreePath: turn.worktreePath }, turn.ownershipEpoch,
            { kind: turn.kind, reportHeadSha: turn.reportHeadSha, paths: [...turn.paths] }, o.signal);
          o.assertCurrent(); o.signal.throwIfAborted();
          db.assertScopedWorktreeClosingLaunch({ ...turn, observation });
        } },
        turnRequestFactory: o.turnRequestFactory(request), controlScope: { role: "execution-artifact", projectId: o.state.id, nodeRunId: turn.nodeRunId,
          executionId: turn.executionId, agentId: turn.agentId, ownershipEpoch: turn.ownershipEpoch, worktreeClosing: scope },
        controlAuthorityFactory: scopedWorktreeClosingControlAuthorityFactory({ state: o.state, database: db, storage: o.storage, closing: turn, capability,
          git: o.gitForClosing(turn), repository: o.repository, signal: o.signal, assertCurrent: o.assertCurrent }) });
      o.register(key, handle);
      const inputId = `worktree-closing:${turn.invocationId}`;
      await o.submit(handle, { inputId, invocationId: turn.invocationId, prompt: assignment }, async result => {
        if (typeof result.handoff !== "string" || !result.handoff.trim()) throw new Error("Original closing returned no actual Agent output");
        db.recordScopedWorktreeClosingResult({ ...turn, inputId, output: redactTrace(result.handoff), residentTurnCompleted: true });
        await o.publish();
      });
    } catch (error) {
      // Keep the actual technical failure and all accepted Agent facts. This
      // does not choose cleanup, regrant, restart or business recovery.
      db.appendEvent({ projectId: o.state.id, agentId: turn.agentId, invocationId: turn.invocationId,
        requestId: `scoped-worktree-closing:${turn.invocationId}:failure`, type: "agent.worktree_closing.failed",
        payload: { executionId: turn.executionId, ownershipEpoch: turn.ownershipEpoch,
          reason: redactTrace(error instanceof Error ? error.message : String(error)).slice(0, 2000) } });
    } finally {
      if (handle) { await handle.close(); this.recordStopped(turn, { residentClosed: true }); }
      else this.recordStopped(turn, await this.stopped(turn, turn.runtimePath));
      o.unregister(key); await o.publish();
    }
  }
}
