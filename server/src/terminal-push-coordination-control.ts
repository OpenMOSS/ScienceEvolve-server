import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import type { CollaborationControlAuthorityFactory } from "./collaboration-runtime.js";
import type { CollaborationStateDatabase } from "./collaboration-state/store.js";
import type { TerminalPushCoordinatorTurn } from "./collaboration-state/contracts.js";
import type { ProjectStorage } from "./storage.js";
import type { ControlMcpRequest, ProjectState, TerminalPushCoordinationScope } from "./types.js";
import { terminalPushCoordinationActionAllowed } from "./internal/terminal-push-coordination.js";

/** Internal mechanism only: the original manager interprets the evidence,
 * submits its own finish/memory and chooses a bounded coordination action.
 * The system never wakes an arbitrary Agent or makes its business decision. */
export function terminalPushCoordinationControlAuthorityFactory(options: {
  state: ProjectState; database: CollaborationStateDatabase; storage: ProjectStorage;
  coordination: TerminalPushCoordinatorTurn; capability: string; signal?: AbortSignal;
  assertCurrent(): Promise<void> | void;
}): CollaborationControlAuthorityFactory {
  if (options.state.status === "completed") throw new Error("Completed projects are outside running-workflow coordination");
  const turn = options.coordination;
  const capabilityHash = createHash("sha256").update(options.capability).digest("hex");
  const incident = options.database.terminalPushCoordinationIncidents(turn.projectId).find(entry => entry.id === turn.incidentId);
  const manager = incident?.coordinators[turn.level];
  if (!manager || manager.agentId !== turn.agentId || capabilityHash !== turn.capabilityHash)
    throw new Error("Historical coordination control lost its original manager and reserved capability");
  const scope: TerminalPushCoordinationScope = { incidentId: turn.incidentId, coordinatorEpoch: turn.coordinatorEpoch,
    level: turn.level, role: manager.role, canRequestUser: turn.allowUserIntervention };
  const assertCurrent = async () => {
    options.signal?.throwIfAborted();
    await options.assertCurrent();
    options.signal?.throwIfAborted();
    if (options.state.status === "completed") throw new Error("Completed projects are outside running-workflow coordination");
    options.database.assertTerminalPushCoordinatorControl({ ...turn, capabilityHash });
  };
  return async ({ request, turn: modelTurn }) => {
    const context = request.executionContext;
    if (options.state.id !== turn.projectId || request.project.id !== turn.projectId || request.agent !== turn.agentId ||
      request.kind !== (turn.agentId === "main" ? "main" : "worker") || request.invocationId !== turn.invocationId ||
      modelTurn.invocationId !== turn.invocationId || context?.role !== "leader" || context.coordinatorEpoch !== turn.coordinatorEpoch ||
      request.workspacePath !== turn.worktreePath || request.runtimePath !== turn.runtimePath || request.sessionContinuity !== "strict" ||
      !isDeepStrictEqual(request.terminalPushCoordination, scope))
      throw new Error("Historical coordination control request does not match its exact original retained manager turn");
    await assertCurrent();
    const control: ControlMcpRequest = { stagingPath: path.join(request.runtimePath, "terminal-push-coordination", "control-actions.json"),
      capability: options.capability, capabilityHash, stateVersion: turn.coordinatorEpoch, candidates: [], decisionBy: "agent",
      allowUserIntervention: scope.canRequestUser, canComplete: false, terminalPushCoordination: scope,
      workspacePath: turn.worktreePath, requireBridge: true };
    return { control, revalidate: async envelope => {
      if (envelope.action.tool === "request_user" && options.state.orchestration.allowUserIntervention === false) {
        throw new Error("User intervention is disabled by this Workflow");
      }
      if (envelope.projectId !== turn.projectId || envelope.agent !== turn.agentId || envelope.invocationId !== turn.invocationId ||
        envelope.stateVersion !== turn.coordinatorEpoch || envelope.capabilityHash !== capabilityHash || envelope.expiresAt !== undefined ||
        !terminalPushCoordinationActionAllowed(scope, envelope.action))
        throw new Error("Historical coordination action lost its exact live manager authority");
      await assertCurrent();
      options.database.stageTerminalPushCoordinatorAction({ ...turn, envelope });
      if (envelope.action.tool === "finish_task") {
        const current = options.database.terminalPushCoordinatorTurns(turn.projectId).find(entry => entry.invocationId === turn.invocationId)!;
        await options.storage.saveTerminalPushCoordinatorCompletion(current);
        await assertCurrent();
      }
    } };
  };
}
