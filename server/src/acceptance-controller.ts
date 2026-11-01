import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { syncDirectory } from "./harness-runtime/directory-sync.js";
import type { GitExecutionAuthority, GitHubRepositoryFact } from "./collaboration-git/contracts.js";

export interface AcceptanceFaultArm {
  schemaVersion: 1;
  case: "R03" | "R04" | "R11" | "R12" | "R14";
  variant: "missing-finish-once" | "owned-pending-file" | "registered-unopened-preparation" | "gateway-error-once" | "gateway-unavailable" | "merge-response-lost" | "partial-report-linkage";
  runId: string;
  projectId: string;
  projectTitle: string;
  payloadSha256: string;
  submissionSha256: string;
  observedStateSha256: string;
  armedAt: string;
  target: {
    agentId: string; executionId?: string; ownershipEpoch: number; invocationId?: string;
    groupRunId: string; arrivalRequestId: string; branch?: string; base: string;
    selection?: "queued-arrival"; arrivalSequence?: number; targetNodeId?: string;
    route?: { gatewayId: string; model: string; harness: string; protocol: string; nativeProtocol: string;
      gatewayUrlSha256: string; deliveryMode: string };
    repository: { owner: string; name: string; providerId: number };
  };
}
export interface AcceptanceBoundary {
  projectTitle: string; projectRoot: string; execution: GitExecutionAuthority & { projectId: string };
  arrivalRequestId: string; groupRunId: string; base: string; repository: GitHubRepositoryFact;
}
interface BoundArm { arm: AcceptanceFaultArm; armSha256: string; directory: string }

/** Operator files are outside Agent workspaces. These helpers only bind and
 * journal a fault; they do not perform recovery, Git work or project DB writes. */
export async function readAcceptanceArmFile(input: AcceptanceBoundary & {
  case: AcceptanceFaultArm["case"]; variant: AcceptanceFaultArm["variant"] | readonly AcceptanceFaultArm["variant"][];
  directory?: string;
}): Promise<BoundArm | undefined> {
  const { execution } = input;
  if (!input.directory || !/^prj_[a-f0-9]{32}$/.test(execution.projectId) ||
    !input.projectTitle.startsWith(`OpenFARS ${input.case} `)) return;
  const directory = await fs.realpath(input.directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined; throw error;
  });
  if (!directory) return;
  const project = await fs.realpath(input.projectRoot);
  assert.ok(directory !== project && !directory.startsWith(project + path.sep), `${input.case} controller must live outside Agent project files`);
  const handle = await fs.open(path.join(directory, `${execution.projectId}.arm.json`), constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!handle) return;
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    assert.ok(stat.isFile() && stat.size <= 64 * 1024, "Invalid acceptance arm file");
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  const arm: AcceptanceFaultArm = JSON.parse(bytes.toString("utf8"));
  const variants = typeof input.variant === "string" ? [input.variant] : input.variant;
  assert.ok(arm.schemaVersion === 1 && arm.case === input.case && variants.includes(arm.variant) &&
    /^[a-z0-9][a-z0-9-]{2,39}$/.test(arm.runId) && arm.projectTitle.startsWith(`OpenFARS ${arm.case} ${arm.runId}: `) &&
    [arm.payloadSha256, arm.submissionSha256, arm.observedStateSha256].every((s) => /^[a-f0-9]{64}$/.test(s)) &&
    Number.isFinite(Date.parse(arm.armedAt)), "Invalid acceptance arm provenance");
  assert.equal(arm.projectId, execution.projectId, "Acceptance arm names a different project");
  assert.equal(arm.projectTitle, input.projectTitle, "Acceptance arm names a different run/title");
  return { arm, armSha256: createHash("sha256").update(bytes).digest("hex"), directory };
}

export async function readBoundAcceptanceArm(input: AcceptanceBoundary & {
  case: AcceptanceFaultArm["case"]; variant: AcceptanceFaultArm["variant"];
  invocationId: string; boundaryAt: string; directory?: string;
}): Promise<BoundArm | undefined> {
  const bound = await readAcceptanceArmFile(input);
  if (!bound) return;
  const { arm } = bound, { execution } = input;
  const target = arm.target;
  if (target.agentId !== execution.agentId || target.executionId !== execution.id ||
    target.ownershipEpoch !== execution.ownershipEpoch || target.invocationId !== input.invocationId ||
    target.groupRunId !== input.groupRunId || target.arrivalRequestId !== input.arrivalRequestId ||
    target.branch !== execution.executionBranch || target.base !== input.base ||
    target.repository.owner !== input.repository.owner || target.repository.name !== input.repository.name ||
    target.repository.providerId !== input.repository.providerId ||
    !(Date.parse(input.boundaryAt) >= Date.parse(arm.armedAt))) return;
  return bound;
}

export async function consumeAcceptanceFault(bound: BoundArm, evidence: Record<string, unknown>): Promise<boolean> {
  return writeAcceptanceEvidence(bound, "consumed", evidence);
}

export async function writeAcceptanceEvidence(bound: BoundArm, kind: "consumed" | "observed", evidence: Record<string, unknown>): Promise<boolean> {
  const { arm, directory, armSha256 } = bound;
  // Exclusive and durable across processes/restarts. Never erase or re-arm an
  // interrupted file; external traces must resolve what actually happened.
  const handle = await fs.open(path.join(directory, `${arm.projectId}.${kind}.json`), "wx", 0o600)
    .catch((error: NodeJS.ErrnoException) => { if (error.code === "EEXIST") return undefined; throw error; });
  if (!handle) return false;
  try {
    await handle.writeFile(JSON.stringify({ ...evidence, schemaVersion: 1, case: arm.case, variant: arm.variant,
      runId: arm.runId, projectId: arm.projectId, at: new Date().toISOString(), armSha256, target: arm.target }, null, 2) + "\n");
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(directory);
  return true;
}

export async function readConsumedAcceptanceFault(bound: BoundArm): Promise<Record<string, unknown>> {
  const handle = await fs.open(path.join(bound.directory, `${bound.arm.projectId}.consumed.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    assert.ok(stat.isFile() && stat.size <= 2 * 1024 * 1024, "Invalid consumed acceptance receipt");
    const receipt = JSON.parse(await handle.readFile("utf8"));
    assert.equal(receipt.armSha256, bound.armSha256, "Consumed acceptance receipt belongs to another arm");
    return receipt;
  } finally { await handle.close(); }
}
