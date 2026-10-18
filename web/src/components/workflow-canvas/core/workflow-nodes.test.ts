import { describe, expect, it } from "vitest";
import type { AgentOrchestrationTemplate, Project } from "../../../types";
import {
  lockedCollaborationIds,
  workflowOuterNodeIds
} from "./workflow-nodes";

const orchestration: AgentOrchestrationTemplate = {
  schemaVersion: 2,
  agents: [
    { name: "main", template: "main" },
    { name: "a", template: "idea" },
    { name: "b", template: "execution" },
    { name: "c", template: "general" },
    { name: "d", template: "review" },
    { name: "e", template: "general" },
    { name: "f", template: "writing" },
    { name: "g", template: "general" },
    { name: "h", template: "review" }
  ],
  collaborations: [{
    id: "research_group",
    displayName: "Research group",
    memberAgentIds: ["a", "b"],
    renamePolicy: "editable"
  }],
  input: { source: "input", target: "c" },
  routes: {
    main: ["research_group", "c", "d", "e", "f", "g", "h"].map((target) => ({ target, kind: "weak" as const })),
    c: [{ target: "research_group", kind: "strong" }],
    research_group: [{ target: "d", kind: "strong" }],
    d: [{ target: "e", kind: "strong" }],
    e: [{ target: "f", kind: "strong" }],
    f: [{ target: "g", kind: "strong" }],
    g: [{ target: "h", kind: "strong" }],
    h: [{ target: "finish", kind: "weak" }]
  },
  decisionPlans: {},
  allowUserIntervention: true,
  termination: { agent: "h", condition: "done", decisionBy: "main", automatic: false }
};

function projectWithFinalPull(
  groupStatus: "running" | "completed",
  pullStatus: "open" | "merged"
): Project {
  return {
    orchestration,
    nodeRuns: [{
      id: "node-run-1",
      node: { kind: "collaboration", nodeId: "research_group", groupId: "research_group" },
      workflowRevision: 1,
      activationRequestId: "activation-1",
      inputSnapshotRef: "messages/input.json",
      activatedByAgentId: "main",
      status: groupStatus
    }],
    groupRuns: [{
      id: "group-run-1",
      nodeRunId: "node-run-1",
      memberSnapshot: ["a", "b"],
      leaderAgentId: "main",
      coordinatorEpoch: 1,
      baseCommit: "1".repeat(40),
      groupBranch: "groups/group-run-1",
      integrationTarget: "main",
      finalPullRequestId: "pull-final",
      taskIds: [],
      status: groupStatus
    }],
    pullRequests: [{
      id: "pull-final",
      providerNumber: 7,
      htmlUrl: "https://github.example.test/pull/7",
      head: "groups/group-run-1",
      base: "main",
      ownerExecutionId: "execution-final",
      status: pullStatus,
      observedAt: "2026-09-22T00:00:00.000Z"
    }]
  } as unknown as Project;
}

describe("workflow outer-node projection", () => {
  it("replaces two of eight ordinary Agents with one outer collaboration node", () => {
    expect(workflowOuterNodeIds(orchestration)).toEqual([
      "main",
      "research_group",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h"
    ]);
  });

  it("locks an active group and a completed group with a pending final PR, then unlocks the merged terminal run", () => {
    expect(lockedCollaborationIds(projectWithFinalPull("running", "open")))
      .toEqual(new Set(["research_group"]));
    expect(lockedCollaborationIds(projectWithFinalPull("completed", "open")))
      .toEqual(new Set(["research_group"]));
    expect(lockedCollaborationIds(projectWithFinalPull("completed", "merged")))
      .toEqual(new Set());
  });

  it("fails closed when a completed group is missing its final PR fact", () => {
    const missingRecord = projectWithFinalPull("completed", "merged");
    missingRecord.pullRequests = [];
    expect(lockedCollaborationIds(missingRecord)).toEqual(new Set(["research_group"]));

    const missingReference = projectWithFinalPull("completed", "merged");
    delete missingReference.groupRuns![0]!.finalPullRequestId;
    expect(lockedCollaborationIds(missingReference)).toEqual(new Set(["research_group"]));
  });
});
