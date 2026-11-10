#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const directory = new URL("./examples/", import.meta.url);
const names = ["legacy-serial.json", "git-agent-task.json", "collaboration-run.json"];
const examples = Object.fromEntries(names.map((name) => [name, JSON.parse(readFileSync(new URL(name, directory)))]));
const checks = [];

function check(name, value) {
  assert.ok(value, name);
  checks.push(name);
}

const legacy = examples["legacy-serial.json"];
check("legacy remains Git-off", legacy.normalizedExpectations.git.enabled === false);
check("legacy has no collaborations", legacy.normalizedExpectations.collaborations.length === 0);
check("legacy outer order is preserved", legacy.normalizedExpectations.outerNodeIds.join(",") === "main,researcher,writer");
const normalizedLegacy = {
  schemaVersion: 2,
  ...clone(legacy.serializedInput),
  collaborations: []
};
check("legacy Agent definitions are byte-for-byte preserved", JSON.stringify(normalizedLegacy.agents) === JSON.stringify(legacy.serializedInput.agents));
check("legacy input is byte-for-byte preserved", JSON.stringify(normalizedLegacy.input) === JSON.stringify(legacy.serializedInput.input));
check("legacy routes are byte-for-byte preserved", JSON.stringify(normalizedLegacy.routes) === JSON.stringify(legacy.serializedInput.routes));
check("legacy decision plans are byte-for-byte preserved", JSON.stringify(normalizedLegacy.decisionPlans) === JSON.stringify(legacy.serializedInput.decisionPlans));
check("legacy intervention policy is preserved", normalizedLegacy.allowUserIntervention === legacy.serializedInput.allowUserIntervention);
check("legacy termination is byte-for-byte preserved", JSON.stringify(normalizedLegacy.termination) === JSON.stringify(legacy.serializedInput.termination));

const ordinary = examples["git-agent-task.json"];
check("ordinary task links node run", ordinary.task.nodeRunId === ordinary.nodeRun.id);
check("ordinary execution links task and node run", ordinary.execution.taskId === ordinary.task.id && ordinary.execution.nodeRunId === ordinary.nodeRun.id);
check("ordinary PR belongs to execution and targets main", ordinary.pullRequest.ownerExecutionId === ordinary.execution.id && ordinary.pullRequest.base === "main");

const collaboration = examples["collaboration-run.json"];
check("collaboration example has ready Git", collaboration.git.enabled === true && collaboration.git.status === "ready" && collaboration.git.repository.private === true);
const members = new Set(collaboration.orchestration.collaborations.flatMap((group) => group.memberAgentIds));
const outer = collaboration.orchestration.agents.map((agent) => agent.name).filter((id) => !members.has(id));
outer.splice(2, 0, collaboration.orchestration.collaborations[0].id);
check("group run and node run identities are separate", collaboration.groupRun.id !== collaboration.nodeRun.id && collaboration.groupRun.nodeRunId === collaboration.nodeRun.id);
check("member agents are absent from outer nodes", [...members].every((id) => !collaboration.expectedOuterNodeIds.includes(id)));
check("outer node expectation is complete", new Set(outer).size === new Set(collaboration.expectedOuterNodeIds).size && collaboration.expectedOuterNodeIds.every((id) => outer.includes(id)));
check("every task links both runs", collaboration.tasks.every((task) => task.nodeRunId === collaboration.nodeRun.id && task.groupRunId === collaboration.groupRun.id));
check("every execution links an existing task and both runs", collaboration.executions.every((execution) =>
  collaboration.tasks.some((task) => task.id === execution.taskId) &&
  execution.nodeRunId === collaboration.nodeRun.id && execution.groupRunId === collaboration.groupRun.id));
check("every PR links an existing execution", collaboration.pullRequests.every((pull) =>
  collaboration.executions.some((execution) => execution.id === pull.ownerExecutionId && execution.pullRequestId === pull.id)));
const integration = collaboration.executions.find((execution) => execution.id === collaboration.finalIntegration.executionId);
const finalPull = collaboration.pullRequests.find((pull) => pull.id === collaboration.finalIntegration.pullRequestId);
check("final integration is fully serialized", integration?.purpose === "final-integration" && finalPull?.ownerExecutionId === integration.id);
check("final integration is member owned, never leader owned", members.has(integration.agentId) && integration.agentId !== collaboration.groupRun.leaderAgentId);
check("final PR is group to main", finalPull.head === collaboration.groupRun.groupBranch && finalPull.base === "main");
check("group links final execution and PR", collaboration.groupRun.integrationOwnerExecutionId === integration.id && collaboration.groupRun.finalPullRequestId === finalPull.id);
check("delivery tasks precede integration", collaboration.tasks.find((task) => task.id === integration.taskId).dependencyTaskIds.length === 2);

const result = {
  contractVersion: "openfars-collaboration-v2.0",
  baseline: "da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2",
  files: Object.fromEntries(names.map((name) => [name, createHash("sha256").update(readFileSync(new URL(name, directory))).digest("hex")])),
  passed: checks.length,
  checks
};
writeFileSync("/tmp/openfars-r0-contract-evidence.json", `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
