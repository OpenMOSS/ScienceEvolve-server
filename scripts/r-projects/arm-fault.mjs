import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { assertBinding, sha256 } from "./catalog.mjs";

// Arms a single observed native invocation. Creation provenance and a current
// read-only snapshot are mandatory; no title adoption or project DB writes.
const variants = { R03: "missing-finish-once", R04: "owned-pending-file", R12: "merge-response-lost", R14: "partial-report-linkage" };
export function validateCaseRegistration({ code, manifest, submission, project }) {
  assert.equal(manifest.schemaVersion, 2);
  assertBinding(manifest.binding);
  const entry = manifest.cases.find((entry) => entry.code === code);
  assert.ok(entry && entry.payloadSha256 === sha256(entry.payload), `${code} payload provenance mismatch`);
  assert.equal(submission.status, "accepted", `${code} has no accepted creation receipt`);
  assert.equal(submission.code, code);
  assert.equal(submission.base, manifest.serviceUrl);
  assert.equal(submission.payloadSha256, entry.payloadSha256);
  assert.match(submission.projectId, /^prj_[a-f0-9]{32}$/);
  assert.equal(project.id, submission.projectId);
  assert.equal(project.title, entry.payload.title);
  assert.ok(project.title.startsWith(`OpenFARS ${code} ${manifest.binding.runId}: `), "Case/run title differs from binding");
  assert.equal(project.status, "running", `${code} must have a current running invocation`);
  return entry;
}

async function observeInitialScopedInput({ code, project, execution, invocationId, activity, nativeEvidencePaths }) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const files = nativeEvidencePaths ?? { databasePath: path.join(root, "data/collaboration-state.sqlite"),
    projectDirectory: path.join(root, "data/projects", project.id) };
  const database = new DatabaseSync(files.databasePath, { readOnly: true });
  const checkInitial = () => {
    database.exec("BEGIN");
    try {
      const turn = database.prepare(`SELECT turn.*, execution.agent_id, execution.arrival_request_id,
        execution.status AS execution_status, execution.ownership_epoch AS current_ownership_epoch
        FROM scoped_agent_turns turn JOIN scoped_executions execution ON execution.execution_id = turn.execution_id
        WHERE turn.project_id = ? AND turn.execution_id = ? AND turn.ownership_epoch = 1`)
        .get(project.id, execution.id);
      const writer = database.prepare("SELECT epoch FROM writer_service_lease WHERE singleton = 1").get();
      assert.ok(turn?.status === "opened" && turn.opened_at && turn.invocation_id === invocationId &&
        turn.agent_id === execution.agentId && turn.arrival_request_id === execution.arrivalRequestId &&
        turn.execution_status === "running" && turn.current_ownership_epoch === 1 &&
        turn.writer_lease_epoch === writer?.epoch && turn.writer_lease_epoch === activity.writerLeaseEpoch,
      `No exact live ${code} initial native owner`);
      const later = database.prepare(`SELECT 1 FROM project_events WHERE project_id = ?
        AND json_extract(payload_json, '$.executionId') = ? AND event_type IN (
          'scoped.agent.native_output.recorded', 'scoped.agent.mechanism_repair.requested',
          'scoped.agent.coordinated_repair.requested', 'scoped.agent.missing_report_repair.requested') LIMIT 1`)
        .get(project.id, execution.id);
      assert.ok(!later, `${code} initial native turn already returned or entered repair`);
      if (code === "R03") assert.ok(!database.prepare(`SELECT 1 FROM scoped_agent_task_completions
        WHERE project_id = ? AND execution_id = ? AND ownership_epoch = 1`).get(project.id, execution.id),
      "R03 task completion already exists");
      return { openedAt: turn.opened_at, writerLeaseEpoch: turn.writer_lease_epoch };
    } finally { database.exec("COMMIT"); }
  };
  try {
    const observed = checkInitial();
    const bytes = await fs.readFile(path.join(files.projectDirectory, "events.jsonl"));
    // Read only complete committed lines, selecting public user inputs only.
    const prefix = bytes.subarray(0, bytes.lastIndexOf(10) + 1);
    const inputs = prefix.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
      .filter(row => row.agent === execution.agentId && row.data?.event?.kind === "user.message" &&
        row.data.event.invocationId === invocationId).map(row => row.data.event);
    assert.ok(inputs.length === 1 && typeof inputs[0].message === "string" && inputs[0].message.length &&
      Date.parse(inputs[0].timestamp) >= Date.parse(observed.openedAt),
    `${code} original native input was not received exactly once`);
    checkInitial();
    return { source: "current-scoped-native-and-public-user-input", ...observed,
      inputId: `scoped:${execution.arrivalRequestId}:epoch:1`, nativeEventId: inputs[0].eventId,
      receivedAt: inputs[0].timestamp, eventsBytes: prefix.length,
      eventsPrefixSha256: createHash("sha256").update(prefix).digest("hex") };
  } finally { database.close(); }
}

export async function armFault({ code, directory, manifest, submission, project, executionId, invocationId, nativeEvidencePaths }) {
  assert.ok(Object.hasOwn(variants, code), "Only R03/R04/R12/R14 have supported invocation controllers");
  const entry = validateCaseRegistration({ code, manifest, submission, project });
  const executions = project.scopedExecutions?.filter((e) => e.agentId === "implementer") ?? [];
  assert.equal(executions.length, 1, `Select the first ${code} implementer before later arrivals exist`);
  const execution = executions[0];
  assert.equal(execution.id, executionId);
  assert.equal(execution.projectId, project.id);
  assert.equal(execution.ownershipEpoch, 1, `${code} must be armed on its first ownership epoch`);
  assert.equal(execution.status, "running");
  assert.ok(!project.scopedAgentReports?.some((r) => r.executionId === executionId), `${code} report already exists`);
  if (code === "R03") {
    assert.ok(!project.taskCompletions?.[executionId], "R03 task completion already exists");
    assert.ok(!project.scopedAgentTaskCompletions?.some(receipt => receipt.executionId === executionId && receipt.ownershipEpoch === 1),
      "R03 task completion already exists");
    assert.equal(project.agents?.implementer?.sessionPersistence, false, "R03 requires ordinary nonpersistent configuration");
  }
  if (["R04", "R12"].includes(code)) assert.ok(!project.scopedPullRequests?.some((r) => r.ownerExecutionId === executionId && r.status === "merged"), `${code} selected PR has already merged`);
  const activities = project.runtime?.activities?.filter((a) => a.scopeKind === "scoped-agent" &&
    a.projectId === project.id && a.agentId === "implementer" && a.executionId === executionId &&
    a.invocationId === invocationId && a.ownershipEpoch === 1 && a.leaseState === "current") ?? [];
  const legacyTurn = activities.find(a => a.kind === "turn" &&
    (!["R03", "R04"].includes(code) || a.inputId === `scoped:${execution.arrivalRequestId}:epoch:1`));
  let nativeInputProof;
  if (!legacyTurn) {
    const resident = activities.find(a => a.kind === "resident" && a.phase === "resident:running");
    assert.ok(resident, `No exact live ${code} native turn`);
    nativeInputProof = await observeInitialScopedInput({ code, project, execution, invocationId, activity: resident, nativeEvidencePaths });
  }
  const group = project.scopedGroupRuns?.find((g) => g.id === execution.groupRunId);
  assert.equal(group?.groupId, "G_child");
  const repo = project.operations?.find((op) => op.kind === "repository.create" && op.status === "finalized")?.remoteFact;
  assert.ok(repo?.provider === "github" && repo.owner === project.git?.repository?.owner &&
    repo.name === project.git?.repository?.name && repo.name === entry.payload.git.repositoryName &&
    Number.isSafeInteger(repo.providerId), `${code} repository is not initialized or differs from its payload`);
  const arm = { schemaVersion: 1, case: code, variant: variants[code], runId: manifest.binding.runId,
    projectId: project.id, projectTitle: project.title, payloadSha256: entry.payloadSha256,
    submissionSha256: sha256(submission), observedStateSha256: sha256(project), armedAt: new Date().toISOString(),
    ...(nativeInputProof ? { nativeInputProof } : {}),
    target: { agentId: "implementer", executionId, ownershipEpoch: 1, invocationId, groupRunId: group.id,
      arrivalRequestId: execution.arrivalRequestId, branch: execution.executionBranch, base: group.groupBranch,
      repository: { owner: repo.owner, name: repo.name, providerId: repo.providerId } } };
  return persistArm(directory, arm);
}

export async function persistArm(directory, arm) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${arm.projectId}.arm.json`);
  // Publish a complete arm atomically without replacing an existing one. The
  // runtime may read this directory while the operator command is still active.
  const pending = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(pending, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(arm, null, 2) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.link(pending, file); }
  finally { await fs.unlink(pending); }
  const parent = await fs.open(directory, "r");
  try { await parent.sync(); } finally { await parent.close(); }
  return { file, arm };
}

export async function runArmCli(fixedCode) {
  const args = process.argv.slice(2), value = (flag) => args[args.indexOf(flag) + 1];
  for (const flag of ["--input", "--directory", "--execution", "--invocation"]) assert.ok(args.includes(flag) && value(flag), `Missing ${flag}`);
  const code = fixedCode ?? value("--case");
  assert.ok(Object.hasOwn(variants, code), "Choose --case R03, R04, R12 or R14");
  const input = path.resolve(value("--input"));
  const manifest = JSON.parse(await fs.readFile(path.join(input, "manifest.json"), "utf8"));
  const submission = JSON.parse(await fs.readFile(path.join(input, `${code}.submission.json`), "utf8"));
  assert.match(submission.projectId ?? "", /^prj_[a-f0-9]{32}$/);
  const response = await fetch(`${manifest.serviceUrl}/api/projects/${submission.projectId}?view=state`, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `${code} state read failed: HTTP ${response.status}`);
  const { project } = await response.json();
  const observed = path.join(input, `${code}.arm-observation-${Date.now()}.json`);
  await fs.writeFile(observed, JSON.stringify(project, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(await armFault({ code, directory: path.resolve(value("--directory")), manifest, submission, project,
    executionId: value("--execution"), invocationId: value("--invocation") })));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runArmCli();
