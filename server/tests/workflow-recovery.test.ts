import { describe, expect, it } from "vitest";
import { beginWorkflowRecovery, canAutomaticallyRecoverWorkflow, checkpointWorkflowRecovery, hasUserWorkflowPause } from "../src/workflow-recovery.js";
import type { ProjectState } from "../src/types.js";

function state(patch: Partial<ProjectState> = {}): ProjectState {
  return { status: "retrying", phase: "collaboration:recovering", lastError: "Local synchronization failed", ...patch } as ProjectState;
}

describe("durable workflow recovery", () => {
  it("joins repeated checkpoints and keeps retry time and round across restart", () => {
    const project = state();
    checkpointWorkflowRecovery(project, { now: 1_000 });
    const saved = structuredClone(project.workflowRecovery);
    checkpointWorkflowRecovery(project, { now: 1_500 });
    expect(project.workflowRecovery).toEqual(saved);
    expect(project.retryAt).toBe(new Date(2_000).toISOString());
    const restarted = JSON.parse(JSON.stringify(project)) as ProjectState;
    beginWorkflowRecovery(restarted);
    checkpointWorkflowRecovery(restarted, { now: 3_000 });
    expect(restarted.workflowRecovery).toMatchObject({ attempt: 2, pending: true });
    expect(restarted.retryAt).toBe(new Date(5_000).toISOString());
    for (let round = 0; round < 12; round++) {
      beginWorkflowRecovery(restarted);
      checkpointWorkflowRecovery(restarted, { now: 100_000 * (round + 1) });
    }
    expect(Date.parse(restarted.retryAt!) - 1_200_000).toBe(60_000);
    expect(restarted.status).toBe("retrying");
  });

  it.each(["collaboration:paused", "main-recovery-required", "harness-recovery-required", "user-intervention-required"])(
    "recovers a legacy technical wait without treating it as user Pause (%s)", phase => {
      const project = state({ status: "paused", phase });
      expect(hasUserWorkflowPause(project)).toBe(false);
      expect(canAutomaticallyRecoverWorkflow(project)).toBe(true);
    });

  it.each([
    { status: "paused", phase: "paused" },
    { status: "pausing", phase: "pausing:after:main" },
    { status: "paused", phase: "collaboration:user-paused" },
    { status: "paused", phase: "collaboration:user-cancelled" },
    { status: "retrying", pauseRequest: { requestedAt: "2026-10-15T00:00:00.000Z" } },
    { status: "cancelled" }, { status: "cancelling" }, { status: "completed" }, { archivedAt: "2026-10-15" }
  ] as Partial<ProjectState>[])("never resumes user intent or terminal history: %j", patch => {
    const project = state(patch);
    expect(canAutomaticallyRecoverWorkflow(project)).toBe(false);
    expect(checkpointWorkflowRecovery(project)).toBe(false);
    expect(project.workflowRecovery).toBeUndefined();
  });

  it("explicit Resume opens another repair round without discarding the previous audit", () => {
    const project = state();
    beginWorkflowRecovery(project, { renew: true });
    expect(project.workflowRecovery).toMatchObject({ attempt: 1, pending: false });
    checkpointWorkflowRecovery(project, { now: 10_000 });
    expect(project.workflowRecovery).toMatchObject({ attempt: 2, pending: true });
    beginWorkflowRecovery(project, { renew: true });
    expect(project.workflowRecovery).toMatchObject({ attempt: 2, pending: false });
  });
});
