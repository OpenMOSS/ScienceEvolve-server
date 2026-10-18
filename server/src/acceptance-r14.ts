import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { consumeAcceptanceFault, readBoundAcceptanceArm, type AcceptanceBoundary } from "./acceptance-controller.js";
import type { AgentGitFacts } from "./agent-git-tools.js";
import type { ScopedAgentTurnRecord } from "./collaboration-state/contracts.js";

/** Omit one association at the normal report-persistence boundary. The actual
 * immutable business output and delivery journal remain intact; the ordinary
 * original-session repair must obtain the missing fact from the Agent. */
export async function withholdR14ReportHead(input: AcceptanceBoundary & {
  invocationId: string; nativeTurn?: ScopedAgentTurnRecord; output: string; selectedWeakTarget?: string;
  facts?: AgentGitFacts; repair: boolean; directory?: string;
}): Promise<boolean> {
  if (input.repair || !input.facts?.pushedHeadSha || !input.facts.merged) return false;
  const turn = input.nativeTurn;
  if (!turn || turn.invocationId !== input.invocationId || turn.projectId !== input.execution.projectId ||
    turn.executionId !== input.execution.id || turn.ownershipEpoch !== input.execution.ownershipEpoch ||
    turn.status !== "stopped" || !turn.openedAt || !turn.stoppedAt) return false;
  const bound = await readBoundAcceptanceArm({ ...input, case: "R14", variant: "partial-report-linkage",
    boundaryAt: turn.stoppedAt, directory: input.directory ?? process.env.OPENFARS_R14_FAULT_DIRECTORY });
  if (!bound) return false;
  const { merged, pushedHeadSha } = input.facts, sync = merged.localSynchronization;
  assert.ok(merged.status === "merged" && merged.headSha === pushedHeadSha && merged.ownerExecutionId === input.execution.id &&
    merged.owner === input.repository.owner && merged.repository === input.repository.name &&
    merged.head === input.execution.executionBranch && merged.base === input.base &&
    /^[a-f0-9]{40}$/.test(pushedHeadSha) && /^[a-f0-9]{40}$/.test(merged.mergeCommitSha ?? "") &&
    sync && sync.projectId === input.execution.projectId && sync.targetBranch === input.base &&
    sync.expectedSourceHead === pushedHeadSha && sync.mergeCommitSha === merged.mergeCommitSha &&
    sync.localHeadAfter === sync.remoteHead && ["synchronized", "already_synchronized"].includes(sync.status),
  "R14 report head requires the actual merged and synchronized delivery");
  return consumeAcceptanceFault(bound, { status: "report-head-withheld", nativeTurn: turn,
    omittedHeadSha: pushedHeadSha, delivery: merged,
    report: { output: input.output, outputSha256: createHash("sha256").update(input.output).digest("hex"),
      ...(input.selectedWeakTarget ? { selectedWeakTarget: input.selectedWeakTarget } : {}) },
    observationLimit: "The stored report and same-session repair must separately prove immutable output and restored linkage." });
}
