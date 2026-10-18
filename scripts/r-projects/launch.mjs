import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha256 } from "./catalog.mjs";
import { verifyR16NativeController } from "./verify-r16-native.mjs";
import { verifyR16BrowserObserver } from "./probe-r16-browser.mjs";
const exec = promisify(execFile);
const ORIGINAL_PI_INVOCATION = "inv_b3e26f6b39ed805ab616e1704ee56183";
const FINAL_COMMANDS = ["npm run typecheck", "npm test", "npm run build", "git diff --check"];

async function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await durableCreate(temp,value);
  await fs.rename(temp,file);
  const directory = await fs.open(path.dirname(file),"r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function durableCreate(file, value) {
  const handle = await fs.open(file,"wx",0o600);
  try { await handle.writeFile(JSON.stringify(value,null,2)+"\n"); await handle.sync(); }
  finally { await handle.close(); }
  const directory = await fs.open(path.dirname(file),"r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function optionalJson(file) {
  try { return JSON.parse(await fs.readFile(file,"utf8")); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
export function selectCases(manifest, { batch, cases }) {
  assert.equal(manifest.schemaVersion,2,"Regenerate the obsolete R manifest");
  assert.ok(Boolean(batch) !== Boolean(cases),"Choose exactly one --batch or --cases");
  const codes = batch ? manifest.batches[batch] : cases.split(",");
  assert.ok(Array.isArray(codes) && codes.length,"Unknown or empty batch");
  assert.equal(new Set(codes).size,codes.length,"Duplicate case selection");
  return codes.map((code) => {
    const entry = manifest.cases.find((e) => e.code === code);
    assert.ok(entry,`Unknown case ${code}`);
    assert.equal(sha256(entry.payload),entry.payloadSha256,`${code} payload changed since validation`);
    return entry;
  });
}
export function verifyRuntimeBinding(manifest, catalog, github, now = Date.now()) {
  const b = manifest.binding;
  const harness = catalog.harnesses.find((h) => h.id === b.harness);
  assert.ok(harness?.available && harness.purposes.includes("workflow"),"Configured Harness is unavailable for workflow");
  const gateway = catalog.gateways.find((g) => g.id === b.gatewayId);
  assert.ok(gateway?.apiKeyConfigured && gateway.models.includes(b.model),"Configured gateway/model is unavailable");
  const tests = [...(gateway.tests ?? []), gateway.test].filter(Boolean);
  const matching = tests.filter((t) => t.status === "passed" && t.model === b.model && t.harness === b.harness && t.gatewayRevision === gateway.revision && t.routerCompatibilityVersion === catalog.routerCompatibilityVersion && Number.isFinite(Date.parse(t.testedAt)) && now-Date.parse(t.testedAt) >= 0 && now-Date.parse(t.testedAt) <= 24*60*60*1000);
  assert.ok(matching.some((t) => ["text_ordinary","text_stream","tool_ordinary","tool_stream"].every((stage) => t.stageResults?.some((s) => s.stage === stage && s.status === "passed"))),"Missing current successful exact-route protocol probe");
  assert.ok(matching.some((t) => t.adapterVersion === harness.adapterVersion && t.executableFingerprint === harness.executableFingerprint && t.stageResults?.some((s) => s.stage === "adapter_smoke" && s.status === "passed")),"Missing current successful exact-Harness smoke probe");
  assert.ok(github.accounts.some((a) => a.id === b.githubAccountId && a.status === "ready"),"Configured GitHub account is not ready");
}
/** Historical diagnosis and current functional acceptance are separate facts.
 * Missing old wire logs must not prevent new verified protocol regressions
 * from reaching deployment/acceptance; they must never be labelled recovered. */
export async function verifyS09Evidence({ s09, manifest, head, readArtifact, packageRoot }) {
  assert.equal(s09.status,"accepted","S09 functional acceptance remains incomplete");
  assert.ok(s09.conclusion?.trim(),"Missing S09 acceptance conclusion");
  if (s09.acceptanceBasis === "native-protocol-regression") {
    assert.equal(s09.commit,head,"S09 functional proof belongs to another source commit");
    assert.equal(s09.historicalInvestigation?.status,"evidence-incomplete","Missing explicit historical evidence limitation");
    assert.ok(s09.historicalInvestigation.invocationId && s09.historicalInvestigation.missing?.length,
      "Missing historical invocation/evidence limitations");
    const entry = manifest.cases.find((item) => item.code === "R16");
    assert.ok(entry,"Native protocol acceptance requires the manifest's R16 binding");
    const controller = await readArtifact(s09.nativeController);
    assert.equal(controller.case,"R16","S09 native proof belongs to another case");
    assert.equal(controller.runId,manifest.binding.runId,"S09 native proof belongs to another run");
    assert.equal(controller.variant,"pi-native-retry","S09 native proof has another protocol boundary");
    assert.equal(controller.status,"verified-isolated","S09 needs verified native protocol evidence");
    await readArtifact(controller.isolationTestLog,false);
    await verifyR16NativeController({ controller, manifest, entry, head, readArtifact,
      ...(packageRoot === undefined ? {} : { packageRoot }) });
  } else {
    assert.ok(s09.acceptanceBasis === undefined || s09.acceptanceBasis === "original-protocol",
      "Unknown S09 acceptance basis");
    assert.equal(s09.originalInvocationId,ORIGINAL_PI_INVOCATION,"S09 evidence is not the original N03 invocation");
    for (const key of ["originalProtocol","writerTimeline","stopProof"]) await readArtifact(s09[key],false);
  }
}
export async function verifyReadiness({ directory, manifest, selected, readiness, head, identity, health }) {
  assert.ok(readiness,"No readiness evidence; creation is gated by the implementation plan");
  assert.equal(readiness.manifestSha256,sha256(manifest),"Readiness belongs to another manifest");
  const readArtifact = async (ref, parse = true) => {
    assert.ok(ref?.path && /^[a-f0-9]{64}$/.test(ref.sha256 ?? ""),"Missing evidence path/hash");
    const bytes = await fs.readFile(path.resolve(directory,ref.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"),ref.sha256,`Evidence changed: ${ref.path}`);
    return parse ? JSON.parse(bytes.toString("utf8")) : bytes;
  };
  const checks = await readArtifact(readiness.finalChecks);
  assert.equal(checks.commit,head,"Final checks belong to another commit");
  for (const command of FINAL_COMMANDS) {
    const check = checks.commands?.find((c) => c.command === command);
    assert.equal(check?.exitCode,0,`Missing successful final check: ${command}`);
    await readArtifact(check.log,false);
  }
  const s09 = await readArtifact(readiness.s09);
  await verifyS09Evidence({ s09, manifest, head, readArtifact });
  const service = await readArtifact(readiness.service);
  assert.equal(service.commit,head,"Running service receipt belongs to another commit");
  assert.equal(service.base,manifest.serviceUrl,"Service receipt names another endpoint");
  const live = await identity(service.pid);
  assert.equal(String(live.startTicks),String(service.startTicks),"Service process identity changed");
  assert.equal(live.pid,service.pid,"Service PID changed");
  assert.equal(health.status,"ok","Service is not healthy");
  assert.equal(health.harnessVersion,service.harnessVersion,"Service health differs from startup observation");
  assert.ok(service.buildFiles?.length,"No recorded build files");
  for (const ref of service.buildFiles) await readArtifact(ref,false);
  await readArtifact(service.startupLog,false);
  for (const entry of selected) {
    const proof = readiness.cases?.[entry.code];
    assert.equal(proof?.payloadSha256,entry.payloadSha256,`${entry.code} has no matching case readiness`);
    for (const fault of entry.faults ?? []) {
      const controller = await readArtifact(proof.faults?.[fault]);
      assert.equal(controller.case,entry.code,"Fault controller belongs to another case");
      assert.equal(controller.runId,manifest.binding.runId,"Fault controller belongs to another run");
      assert.equal(controller.variant,fault,"Fault controller has a different trigger");
      assert.equal(controller.status,"verified-isolated","Fault controller has not been verified in isolation");
      assert.ok(controller.bindingRule && controller.command && controller.scope,"Missing executable fault boundary/binding");
      await readArtifact(controller.isolationTestLog,false);
      if (entry.code === "R16" && fault === "pi-native-retry") {
        await verifyR16NativeController({ controller, manifest, entry, head, readArtifact });
      }
    }
    if (entry.code === "R16") {
      const observer = await readArtifact(proof.uiObserver);
      assert.equal(observer.status,"available","No real browser observer");
      assert.equal(observer.runId,manifest.binding.runId);
      await verifyR16BrowserObserver({ observer, manifest, entry, head, readArtifact });
    }
  }
}

// A pending submission never retries POST. The receipt and original request
// survive timeouts/crashes; reconcile against original API/event evidence first.
async function launchSelectedUnlocked({ directory, manifest, selected, api, create = false, assertReady = async () => { throw Error("No readiness verifier"); } }) {
  await fs.mkdir(directory,{ recursive: true });
  if (create) await assertReady(); // Validate the ENTIRE selected batch before writes.
  const results = [];
  const persist = async () => {
    const registered = [];
    for (const entry of manifest.cases) {
      const receipt = await optionalJson(path.join(directory,`${entry.code}.submission.json`));
      if (receipt?.status === "accepted") {
        assert.equal(receipt.payloadSha256,entry.payloadSha256,"Registered payload provenance mismatch");
        assert.equal(receipt.base,manifest.serviceUrl,"Registered endpoint mismatch");
        registered.push({ code: entry.code, projectId: receipt.projectId, payloadSha256: receipt.payloadSha256, action: "registered" });
      }
    }
    await atomicJson(path.join(directory,"launch-result.json"),{ at: new Date().toISOString(), base: manifest.serviceUrl, manifestSha256: sha256(manifest), results: [...registered,...results.filter((r) => !r.projectId)] });
  };
  for (const entry of selected) {
    const receiptPath = path.join(directory,`${entry.code}.submission.json`);
    const receipt = await optionalJson(receiptPath);
    if (receipt) {
      assert.equal(receipt.payloadSha256,entry.payloadSha256,"Submission payload provenance mismatch");
      assert.equal(receipt.base,manifest.serviceUrl,"Submission endpoint mismatch");
      if (receipt.status !== "accepted") throw Error(`${entry.code} has an uncertain pending create. Preserve it and reconcile the original request; no POST was retried.`);
      const { project } = await api(`/projects/${receipt.projectId}?view=state`);
      assert.equal(project.id,receipt.projectId);
      assert.equal(project.title,entry.payload.title,"Registered project title changed");
      results.push({ code: entry.code, projectId: project.id, action: "registered", payloadSha256: entry.payloadSha256, status: project.status });
    } else {
      const existing = await api("/projects?includeArchived=true");
      assert.ok(!existing.projects.some((p) => p.title === entry.payload.title),`${entry.code} title exists without this run's creation receipt; do not adopt by title`);
      if (!create) { results.push({ code: entry.code, action: "planned", payloadSha256: entry.payloadSha256 }); continue; }
      // Exclusive durable claim prevents concurrent launchers posting the same case.
      await durableCreate(receiptPath,{ status: "pending", base: manifest.serviceUrl, code: entry.code, payloadSha256: entry.payloadSha256, requestedAt: new Date().toISOString(), payload: entry.payload });
      const { project } = await api("/projects",entry.payload);
      assert.match(project?.id ?? "",/^prj_[a-f0-9]{32}$/,"Creation response missing project ID; keep pending receipt");
      assert.equal(project.title,entry.payload.title,"Creation response title mismatch; keep pending receipt");
      await atomicJson(receiptPath,{ status: "accepted", base: manifest.serviceUrl, code: entry.code, payloadSha256: entry.payloadSha256, projectId: project.id, acceptedAt: new Date().toISOString() });
      await persist(); // A later failed case must not hide this accepted project.
      await atomicJson(path.join(directory,`${entry.code}.initial-state.json`),project);
      results.push({ code: entry.code, projectId: project.id, action: "created", payloadSha256: entry.payloadSha256, status: project.status });
    }
  }
  // Include prior accepted batches; dry plans never erase their registrations.
  await persist();
  return results;
}

export async function launchSelected(options) {
  await fs.mkdir(options.directory,{ recursive: true });
  const file = path.join(options.directory,"launch.lock");
  const lock = await fs.open(file,"wx",0o600).catch((error) => {
    if (error.code === "EEXIST") throw Error("Run directory has an active or interrupted launcher; reconcile its process and submission receipts before retrying");
    throw error;
  });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await launchSelectedUnlocked(options);
  } finally { await lock.close(); await fs.unlink(file); }
}

async function main() {
  const args = process.argv.slice(2), value = (flag) => args[args.indexOf(flag)+1];
  assert.ok(args.includes("--input"),"Usage: launch.mjs --input <stable-run-directory> (--batch NAME | --cases R01,R02) [--create --readiness path]");
  const directory = path.resolve(value("--input"));
  const manifest = JSON.parse(await fs.readFile(path.join(directory,"manifest.json"),"utf8"));
  const selected = selectCases(manifest,{ batch: args.includes("--batch") ? value("--batch") : undefined, cases: args.includes("--cases") ? value("--cases") : undefined });
  const { createProjectSchema } = await import("../../server/dist/src/validation.js");
  for (const entry of selected) createProjectSchema.parse(entry.payload);
  const api = async (route,payload) => {
    const response = await fetch(`${manifest.serviceUrl}/api${route}`, { method: payload === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(120_000) });
    const raw = await response.text();
    if (!response.ok) throw Error(`${payload === undefined ? "GET" : "POST"} ${route}: HTTP ${response.status}: ${raw}`);
    return JSON.parse(raw);
  };
  const create = args.includes("--create");
  const result = await launchSelected({ directory, manifest, selected, api, create, assertReady: async () => {
    assert.ok(args.includes("--readiness"),"Creation requires recorded readiness evidence");
    const readiness = JSON.parse(await fs.readFile(path.resolve(value("--readiness")),"utf8"));
    const repo = fileURLToPath(new URL("../../",import.meta.url));
    const head = (await exec("git",["rev-parse","HEAD"],{ cwd: repo })).stdout.trim();
    assert.equal((await exec("git",["status","--porcelain"],{ cwd: repo })).stdout.trim(),"","Commit required changes before creation");
    const [health,catalog,github] = await Promise.all([api("/health"),api("/runtime/catalog"),api("/github/accounts")]);
    verifyRuntimeBinding(manifest,catalog,github);
    const { readResidentProcessIdentity } = await import("../../server/dist/src/harness-runtime/resident-lease.js");
    await verifyReadiness({ directory, manifest, selected, readiness, head, identity: readResidentProcessIdentity, health });
    await atomicJson(path.join(directory,"preflight.json"),{ at: new Date().toISOString(), head, health, catalog, github });
  } });
  console.log(JSON.stringify({ selected: selected.map((e) => e.code), create, results: result }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
