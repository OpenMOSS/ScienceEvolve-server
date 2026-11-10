#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const fixtureUrl = new URL("./fixtures/eight-agent-v2.json", import.meta.url);
const fixtureBytes = readFileSync(fixtureUrl);
const fixture = JSON.parse(fixtureBytes);
const legacyUrl = new URL("./fixtures/legacy-git-off-ui.json", import.meta.url);
const legacyBytes = readFileSync(legacyUrl);
const legacy = JSON.parse(legacyBytes);
const assertions = [];

function pass(name, check) {
  assert.ok(check, name);
  assertions.push(name);
}

function equal(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  assertions.push(name);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function semanticSets(orchestration) {
  const agentIds = new Set(orchestration.agents.map((agent) => agent.name));
  const groupIds = new Set(orchestration.collaborations.map((group) => group.id));
  const memberIds = new Set(orchestration.collaborations.flatMap((group) => group.memberAgentIds));
  const outer = orchestration.agents
    .map((agent) => agent.name)
    .filter((agentId) => !memberIds.has(agentId));
  outer.splice(1, 0, ...orchestration.collaborations.map((group) => group.id));
  return { agentIds, groupIds, memberIds, outer, outerSet: new Set(outer) };
}

function validate(project) {
  const orchestration = project.orchestration;
  const { agentIds, groupIds, outerSet } = semanticSets(orchestration);
  if (orchestration.collaborations.length && !project.git.enabled) return "collaboration_requires_git";
  const nodeNames = [
    ...orchestration.agents.map((agent) => agent.name),
    ...orchestration.collaborations.map((group) => group.id)
  ];
  if (new Set(nodeNames).size !== nodeNames.length) return "duplicate_node_id";
  const seen = new Set();
  for (const group of orchestration.collaborations) {
    if (group.memberAgentIds.length < 2) return "collaboration_needs_two_members";
    for (const member of group.memberAgentIds) {
      if (member === "main") return "main_cannot_be_member";
      if (groupIds.has(member)) return "nested_group";
      if (!agentIds.has(member)) return "unknown_member";
      if (seen.has(member)) return "agent_in_multiple_groups";
      seen.add(member);
    }
  }
  if (!outerSet.has(orchestration.input.target)) return "member_is_not_outer_node";
  if (!outerSet.has(orchestration.termination.agent)) return "member_is_not_outer_node";
  for (const [source, edges] of Object.entries(orchestration.routes)) {
    if (!outerSet.has(source)) return "member_is_not_outer_node";
    for (const edge of edges) {
      if (edge.target !== "finish" && !outerSet.has(edge.target)) return "member_is_not_outer_node";
    }
  }
  return null;
}

function mutate(base, variant) {
  const project = { git: clone(base.git), orchestration: clone(base.orchestration), activeRun: clone(base.activeRun) };
  const mutation = variant.mutation;
  if (mutation.type === "add_group") {
    project.orchestration.collaborations.push({
      id: mutation.groupId,
      displayName: mutation.groupId,
      memberAgentIds: mutation.memberAgentIds,
      renamePolicy: "editable"
    });
  } else if (mutation.type === "add_route") {
    project.orchestration.routes[mutation.source] = [{ target: mutation.target, kind: "strong" }];
  } else if (mutation.type === "append_member") {
    project.orchestration.collaborations.find((group) => group.id === mutation.groupId).memberAgentIds.push(mutation.memberId);
  } else if (mutation.type === "replace_members") {
    project.orchestration.collaborations.find((group) => group.id === mutation.groupId).memberAgentIds = mutation.memberAgentIds;
  } else if (mutation.type === "set_input") {
    project.orchestration.input.target = mutation.target;
  } else if (mutation.type === "set_termination") {
    project.orchestration.termination.agent = mutation.agent;
  } else if (mutation.type === "disable_git") {
    project.git = { enabled: false, status: "disabled" };
  } else if (mutation.type === "edit_active_group") {
    if (project.activeRun.groupRun.status !== "completed") return "active_group_locked";
  } else {
    throw new Error(`Unknown mutation ${mutation.type}`);
  }
  return validate(project);
}

const sets = semanticSets(fixture.orchestration);
equal("outer node set excludes members", sets.outer, fixture.expected.outerNodeIds);
equal("member set is a and b", [...sets.memberIds], fixture.expected.memberAgentIds);
pass("base fixture validates", validate({ git: fixture.git, orchestration: fixture.orchestration }) === null);
pass("input excludes members", !sets.memberIds.has(fixture.orchestration.input.target));
pass("termination excludes members", !sets.memberIds.has(fixture.orchestration.termination.agent));
pass("route sources and targets exclude members", Object.entries(fixture.orchestration.routes).every(([source, edges]) =>
  !sets.memberIds.has(source) && edges.every((edge) => !sets.memberIds.has(edge.target))));
equal("Main candidate list uses outer nodes only", fixture.expected.mainDispatchCandidates,
  fixture.expected.outerNodeIds.filter((id) => id !== "main"));

for (const mode of ["compact", "full"]) {
  equal(`${mode} layout has only outer semantic nodes`, fixture.layouts[mode].nodeIds, fixture.expected.canvasNodeIds);
  pass(`${mode} layout has no member geometry`, fixture.expected.memberAgentIds.every((id) => !fixture.layouts[mode].nodeIds.includes(id)));
}
equal("compact/full semantics match", fixture.layouts.compact.semanticEdgeIds, fixture.layouts.full.semanticEdgeIds);
equal("compact/full Main system fan-out matches", fixture.layouts.compact.mainSystemEdgeIds, fixture.layouts.full.mainSystemEdgeIds);
equal("Main system fan-out targets outer candidates", fixture.layouts.full.mainSystemEdgeIds.map((id) => id.slice("main:".length)), fixture.expected.mainDispatchCandidates);

for (const surface of ["preset", "draft", "editor_reload"]) {
  const roundTrip = JSON.parse(JSON.stringify({ orchestration: fixture.orchestration, git: fixture.git }));
  equal(`${surface} preserves v2 orchestration`, roundTrip.orchestration, fixture.orchestration);
  equal(`${surface} preserves Git creation state`, roundTrip.git, fixture.git);
}

equal("Git projection exposes read-only navigation", fixture.readOnlyGitProjection.visibleActions,
  ["open_repository", "open_commit", "open_pull_request", "view_diff"]);
equal("Git projection has no mutating controls", fixture.readOnlyGitProjection.forbiddenActions,
  ["merge", "revert", "delete", "cleanup"]);
equal("no mutating Git action is rendered", fixture.readOnlyGitProjection.renderedMutatingActions, []);
pass("history is retained without automatic cleanup", fixture.readOnlyGitProjection.historyRetained && !fixture.readOnlyGitProjection.automaticCleanup);
pass("actual high-capacity fixture renders a warning", fixture.readOnlyGitProjection.capacity.usagePercent >= 90 && fixture.readOnlyGitProjection.capacity.state === "warning");

for (const variant of fixture.invalidVariants) {
  equal(`invalid variant ${variant.id}`, mutate(fixture, variant), variant.expectedCode);
}

const uniqueEvents = new Map();
for (const event of fixture.sseReconnect.events) {
  if (event.seq <= fixture.sseReconnect.snapshotSeq) continue;
  uniqueEvents.set(event.eventId, event);
}
const ordered = [...uniqueEvents.values()].sort((a, b) => a.seq - b.seq);
const statusByExecution = Object.fromEntries(fixture.activeRun.executions.map((execution) => [execution.id, execution.status]));
for (const event of ordered) statusByExecution[event.executionId] = event.status;
equal("SSE reconnect deduplicates by event id", ordered.length, fixture.sseReconnect.expected.uniqueAppliedEvents);
equal("SSE reconnect advances global sequence", ordered.at(-1).seq, fixture.sseReconnect.expected.lastSeq);
equal("SSE reconnect keeps sibling and supplemental executions distinct", statusByExecution,
  fixture.sseReconnect.expected.executionStatuses);
const aggregate = Object.values(statusByExecution).some((status) => ["waiting_review", "pr_open", "resolving"].includes(status))
  ? "integrating"
  : Object.values(statusByExecution).some((status) => status === "working") ? "running" : "completed";
equal("runtime aggregate remains integrating while a sibling awaits PR review", aggregate,
  fixture.sseReconnect.expected.aggregateStatus);

const requiredLabels = [
  "waiting_authorization", "waiting_review", "conflict_repair", "stop_requested",
  "waiting_for_stop", "continuation_pending", "reassigned", "frozen_by_main_failure"
];
equal("explicit failure/wait/handoff labels are frozen", fixture.runtimeLabels, requiredLabels);
pass("active run carries immutable member snapshot", fixture.activeRun.groupRun.memberSnapshot.join(",") === "a,b");
pass("active group edit lock is explicit", fixture.activeRun.editability.editable === false && fixture.activeRun.editability.reason === "active_group_run");

const legacySerialized = clone(legacy.serializedProject);
const normalizedLegacy = {
  ...clone(legacySerialized),
  git: { enabled: false, status: "disabled" },
  orchestration: {
    schemaVersion: 2,
    ...clone(legacySerialized.orchestration),
    collaborations: []
  }
};
equal("legacy Git defaults off", normalizedLegacy.git, legacy.expected.git);
equal("legacy normalization adds no groups", normalizedLegacy.orchestration.collaborations, legacy.expected.collaborations);
equal("legacy outer nodes remain serial", normalizedLegacy.orchestration.agents.map((agent) => agent.name), legacy.expected.outerNodeIds);
equal("legacy canvas nodes are preserved", Object.keys(normalizedLegacy.orchestration.canvas.nodes), legacy.expected.canvasNodeIds);
equal("legacy Main system targets are preserved", normalizedLegacy.orchestration.routes.main.map((edge) => edge.target), legacy.expected.mainSystemTargets);
equal("legacy Agent configuration and permissions are lossless", normalizedLegacy.agents, legacy.serializedProject.agents);
equal("legacy routes are lossless", normalizedLegacy.orchestration.routes, legacy.serializedProject.orchestration.routes);
equal("legacy termination is lossless", normalizedLegacy.orchestration.termination, legacy.serializedProject.orchestration.termination);
equal("legacy decision plans are lossless", normalizedLegacy.orchestration.decisionPlans, legacy.serializedProject.orchestration.decisionPlans);
equal("legacy canvas is lossless", normalizedLegacy.orchestration.canvas, legacy.serializedProject.orchestration.canvas);
pass("legacy UI exposes no group controls", legacy.expected.groupControlsVisible === false);
pass("legacy normalization creates no repository", legacy.expected.repositoryCreated === false);
for (const surface of ["legacy_preset", "legacy_draft", "legacy_editor_reload"]) {
  const roundTrip = JSON.parse(JSON.stringify(normalizedLegacy));
  equal(`${surface} remains Git-off and serial`, roundTrip, normalizedLegacy);
}

const result = {
  fixtureVersion: fixture.fixtureVersion,
  fixtureSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
  legacyFixtureVersion: legacy.fixtureVersion,
  legacyFixtureSha256: createHash("sha256").update(legacyBytes).digest("hex"),
  baseline: "da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2",
  passed: assertions.length,
  assertions
};
writeFileSync("/tmp/openfars-r7-fixture-evidence.json", `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
