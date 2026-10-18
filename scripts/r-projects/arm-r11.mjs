import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./catalog.mjs";
import { persistArm, validateCaseRegistration } from "./arm-fault.mjs";

export async function armR11({ directory, manifest, submission, project, arrivalRequestId, variant }) {
  assert.ok(["gateway-error-once", "gateway-unavailable"].includes(variant), "Choose an explicit R11 variant");
  const entry = validateCaseRegistration({ code: "R11", manifest, submission, project });
  const arrival = project.scopedArrivals?.find((a) => a.requestId === arrivalRequestId);
  assert.ok(arrival?.status === "queued" && arrival.targetKind === "agent" && arrival.agentId === "implementer" &&
    Number.isSafeInteger(arrival.sequence) && arrival.sequence > 0, "Select an observed queued R11 implementer arrival");
  assert.ok(!project.scopedExecutions?.some((e) => e.agentId === "implementer"), "R11 implementer has already reserved an execution");
  assert.equal(project.scopedArrivals.filter((a) => a.agentId === "implementer").length, 1, "Select the first R11 implementer arrival");
  const group = project.scopedGroupRuns?.find((g) => g.id === arrival.groupRunId);
  assert.ok(group?.groupId === "G_child" && group.status === "running", "R11 arrival is outside the active child group");
  const repository = project.operations?.find((op) => op.kind === "repository.create" && op.status === "finalized")?.remoteFact;
  assert.ok(repository?.provider === "github" && repository.owner === project.git?.repository?.owner &&
    repository.name === project.git?.repository?.name && repository.name === entry.payload.git.repositoryName &&
    Number.isSafeInteger(repository.providerId), "R11 requires its initialized repository receipt");
  const config = project.agents?.implementer, gateway = config?.gatewaySnapshot, binding = manifest.binding;
  assert.ok(config?.harness === binding.harness && config.model === binding.model &&
    config.gatewayId === binding.gatewayId && gateway?.id === binding.gatewayId, "R11 selected route differs from the creation binding");
  for (const protocol of [gateway.protocol, gateway.nativeProtocol]) {
    assert.ok(["responses", "chat-completions", "anthropic-messages"].includes(protocol), "R11 requires a captured protocol route");
  }
  assert.ok(typeof gateway.url === "string" && /^https?:\/\//.test(gateway.url), "R11 requires its captured gateway endpoint");
  return persistArm(directory, { schemaVersion: 1, case: "R11", variant, runId: binding.runId,
    projectId: project.id, projectTitle: project.title, payloadSha256: entry.payloadSha256,
    submissionSha256: sha256(submission), observedStateSha256: sha256(project), armedAt: new Date().toISOString(),
    target: { selection: "queued-arrival", agentId: arrival.agentId, ownershipEpoch: 1, arrivalRequestId,
      arrivalSequence: arrival.sequence, targetNodeId: arrival.targetNodeId, groupRunId: group.id, base: group.groupBranch,
      repository: { owner: repository.owner, name: repository.name, providerId: repository.providerId },
      route: { gatewayId: gateway.id, model: config.model, harness: config.harness, protocol: gateway.protocol,
        nativeProtocol: gateway.nativeProtocol, gatewayUrlSha256: createHash("sha256").update(gateway.url).digest("hex"),
        deliveryMode: gateway.deliveryMode ?? "native-stream" } } });
}

async function main() {
  const args = process.argv.slice(2), value = (flag) => args[args.indexOf(flag) + 1];
  for (const flag of ["--input", "--directory", "--arrival", "--variant"]) assert.ok(args.includes(flag) && value(flag), `Missing ${flag}`);
  const input = path.resolve(value("--input"));
  const manifest = JSON.parse(await fs.readFile(path.join(input, "manifest.json"), "utf8"));
  const submission = JSON.parse(await fs.readFile(path.join(input, "R11.submission.json"), "utf8"));
  assert.match(submission.projectId ?? "", /^prj_[a-f0-9]{32}$/);
  const response = await fetch(`${manifest.serviceUrl}/api/projects/${submission.projectId}?view=state`, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `R11 state read failed: HTTP ${response.status}`);
  const { project } = await response.json();
  await fs.writeFile(path.join(input, `R11.arm-observation-${Date.now()}.json`), JSON.stringify(project, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(await armR11({ directory: path.resolve(value("--directory")), manifest, submission, project,
    arrivalRequestId: value("--arrival"), variant: value("--variant") })));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
