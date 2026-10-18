import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertBinding, sha256 } from "./catalog.mjs";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const piRoot = path.join(repo, "harness/pi/node_modules/@mariozechner/pi-coding-agent");
export const nativeFiles = ["package.json", "dist/cli.js", "dist/core/agent-session.js", "dist/modes/rpc/rpc-mode.js"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** These are local fixture facts, never evidence of the original N03 call or
 * an R16 project's execution. Keep that distinction in launch readiness. */
export function validateNativeEvidence(evidence, mode) {
  assert.equal(evidence.schemaVersion, 2, "R16 needs the full native observation format");
  assert.equal(evidence.mode, mode);
  assert.equal(evidence.firstTurnRequests, 2);
  assert.ok(evidence.piVersion && evidence.packageRoot && evidence.sessionPath && /^[a-f0-9]{64}$/.test(evidence.sessionSha256), "Missing native session/package identity");
  for (const name of nativeFiles) assert.match(evidence.hashes?.[name] ?? "", /^[a-f0-9]{64}$/);
  const wire = evidence.wire;
  assert.ok(Array.isArray(wire) && wire.length, "Missing raw Pi RPC frames");
  assert.ok(wire.every((item, index) => Number.isFinite(item.at) && (!index || item.at >= wire[index - 1].at)), "RPC timestamps are not ordered");
  const retryIndex = wire.findIndex((item) => item.frame.type === "auto_retry_start");
  const retry = wire[retryIndex], end = wire.find((item) => item.frame.type === "auto_retry_end");
  assert.ok(retryIndex > 0 && wire[retryIndex - 1].frame.type === "agent_end" && end, "Missing original completion/retry sequence");
  assert.equal(retry.frame.attempt, 1); assert.equal(retry.frame.maxAttempts, 1); assert.equal(retry.frame.delayMs, 2000);
  assert.ok(end.at - retry.at >= 1900, "Native retry backoff not observed");
  const held = evidence.backoff;
  assert.ok(held?.at > retry.at && held.at < end.at, "No observation during native backoff");
  assert.equal(held.activity?.invocationId, "inv-1");
  assert.equal(held.process?.alive, true); assert.deepEqual(held.releases, []);
  assert.equal(held.concurrentTurnRejected, true); assert.equal(held.pauseRejected, true);
  assert.ok(held.process.identity?.pid && held.process.identity.startTicks, "Missing native process identity");
  assert.equal(evidence.stopped, true); assert.equal(evidence.stopProof?.process?.alive, false);
  assert.deepEqual(evidence.stopProof.process.identity, held.process.identity, "Stop proof names a different process");
  assert.ok(evidence.stopProof.at >= end.at);
  const release = evidence.releases?.[0];
  assert.ok(release && release.at >= end.at, "Authority released before retry settled");
  if (mode === "recover") {
    assert.equal(end.frame.success, true);
    assert.equal(evidence.requests, 3);
    assert.equal(evidence.outcome?.value?.handoff, "native-retry-final");
    assert.equal(evidence.outcome.error, undefined);
    assert.equal(release.outcome, "completed");
    assert.equal(evidence.adjacentTurn?.handoff, "native-next-turn");
    assert.equal(evidence.releases.length, 2);
    assert.equal(evidence.releases[1].outcome, "completed");
    assert.ok(evidence.releases[1].at >= release.at);
  } else {
    assert.equal(end.frame.success, false); assert.equal(evidence.requests, 2);
    assert.match(evidence.outcome?.error ?? "", /Pi automatic retry failed/);
    assert.equal(release.outcome, "failed"); assert.equal(release.alive, false);
    assert.equal(evidence.releases.length, 1); assert.equal(evidence.adjacentTurn, undefined);
  }
}

export async function verifyR16NativeController({ controller, manifest, entry, head, readArtifact, packageRoot = piRoot }) {
  assert.equal(controller.commit, head, "R16 native proof belongs to another source commit");
  assert.equal(controller.manifestSha256, sha256(manifest), "R16 native proof belongs to another manifest");
  assert.equal(controller.payloadSha256, entry.payloadSha256, "R16 native proof names another payload");
  assert.equal(controller.nativeHarness?.id, "pi", "R16 proof lacks actual native Pi identity");
  assert.equal(controller.nativeHarness.packageRoot, await fs.realpath(packageRoot), "R16 native package path changed");
  for (const name of nativeFiles) assert.equal(digest(await fs.readFile(path.join(packageRoot, name))), controller.nativeHarness.hashes?.[name], `R16 native package changed: ${name}`);
  for (const mode of ["recover", "exhaust"]) {
    const evidence = await readArtifact(controller.nativeEvidence?.[mode]);
    validateNativeEvidence(evidence, mode);
    assert.equal(evidence.piVersion, controller.nativeHarness.version);
    assert.equal(evidence.packageRoot, controller.nativeHarness.packageRoot);
    assert.deepEqual(evidence.hashes, controller.nativeHarness.hashes);
  }
}

async function main() {
  const args = process.argv.slice(2), value = (flag) => args[args.indexOf(flag) + 1];
  for (const flag of ["--input", "--output"]) assert.ok(args.includes(flag) && value(flag), `Missing ${flag}`);
  const directory = path.resolve(value("--input")), output = path.resolve(value("--output"));
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
  assertBinding(manifest.binding);
  const entry = manifest.cases.find((e) => e.code === "R16");
  assert.ok(entry && entry.payloadSha256 === sha256(entry.payload), "R16 creation payload differs from its manifest");
  const git = async (...gitArgs) => (await exec("git", gitArgs, { cwd: repo })).stdout.trim();
  const head = await git("rev-parse", "HEAD");
  assert.equal(await git("status", "--porcelain"), "", "Commit R16 source before creating readiness evidence");
  await fs.mkdir(output, { mode: 0o700 }); // New directory only; preserve all prior evidence.
  const evidenceDirectory = path.join(output, "native");
  const logFile = path.join(output, "isolation.log"), log = await fs.open(logFile, "wx", 0o600);
  const command = ["npm", "run", "test", "-w", "server", "--", "tests/pi-rpc-native.test.ts"];
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      const child = spawn(command[0], command.slice(1), { cwd: repo, env: { ...process.env,
        OPENFARS_NATIVE_PI_TESTS: "1", OPENFARS_PI_EVIDENCE_DIR: evidenceDirectory }, stdio: ["ignore", log.fd, log.fd] });
      child.once("error", reject); child.once("exit", (code) => resolve(code));
    });
    await log.sync();
  } finally { await log.close(); }
  assert.equal(exitCode, 0, `R16 native test failed; preserve ${logFile}`);
  assert.equal(await git("rev-parse", "HEAD"), head, "Source commit changed during native test");
  assert.equal(await git("status", "--porcelain"), "", "Source changed during native test");
  const ref = async (file) => ({ path: path.relative(directory, file), sha256: digest(await fs.readFile(file)) });
  const recover = JSON.parse(await fs.readFile(path.join(evidenceDirectory, "recover.json"), "utf8"));
  const controller = { schemaVersion: 1, case: "R16", runId: manifest.binding.runId, variant: "pi-native-retry",
    status: "verified-isolated", at: new Date().toISOString(), commit: head, manifestSha256: sha256(manifest), payloadSha256: entry.payloadSha256,
    command: { argv: command, cwd: repo, env: { OPENFARS_NATIVE_PI_TESTS: "1", OPENFARS_PI_EVIDENCE_DIR: evidenceDirectory } },
    bindingRule: "Fresh local Pi processes, private session/config and localhost-only provider; bind current source commit, manifest/payload and actual native package bytes.",
    scope: "Local installed-Pi fixture readiness only; neither original N03 protocol acceptance nor live R16/UI acceptance.",
    isolationTestLog: await ref(logFile), nativeHarness: { id: "pi", packageRoot: recover.packageRoot, version: recover.piVersion, hashes: recover.hashes },
    nativeEvidence: { recover: await ref(path.join(evidenceDirectory, "recover.json")), exhaust: await ref(path.join(evidenceDirectory, "exhaust.json")) } };
  await verifyR16NativeController({ controller, manifest, entry, head, readArtifact: async (reference) => {
    const bytes = await fs.readFile(path.resolve(directory, reference.path));
    assert.equal(digest(bytes), reference.sha256); return JSON.parse(bytes.toString("utf8"));
  } });
  await fs.writeFile(path.join(output, "controller.json"), JSON.stringify(controller, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const acceptance = {
    schemaVersion: 1, status: "accepted", acceptanceBasis: "native-protocol-regression", commit: head,
    conclusion: "Current installed Pi recover/exhaust regressions verified with ordered raw RPC, retained turn authority, adjacent-turn isolation and process-stop evidence. This accepts the functional repair, not the exact historical N03 diagnosis or live-project completion.",
    nativeController: await ref(path.join(output, "controller.json")),
    historicalInvestigation: {
      status: "evidence-incomplete", projectId: "prj_efb0c025b3e8434f88d2e303161d2f2b",
      invocationId: "inv_b3e26f6b39ed805ab616e1704ee56183",
      missing: ["Original full RPC stream and auto_retry frame contents", "Complete original writer timeline"],
      note: "Retain the original scene and indexed evidence. The local regression does not reconstruct missing historical logs."
    }
  };
  const acceptanceFile = path.join(output, "functional-acceptance.json");
  await fs.writeFile(acceptanceFile, JSON.stringify(acceptance, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: controller.status, controller: path.join(output, "controller.json"),
    functionalAcceptance: acceptanceFile, scope: controller.scope }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
