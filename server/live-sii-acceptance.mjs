// Explicit live test: one temporary CPU Notebook, no GPU allocation.
// Run from the repository root with --run. Credentials are read from the
// existing gateway store and never included in this script or its report.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SiiExperimentService, assertSiiControlAction } from "./dist/src/sii-experiments.js";
import { HarnessRuntimeFacade } from "./dist/src/harness-runtime/runtime.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { redactTrace } from "./dist/src/utils.js";

if (!process.argv.includes("--run")) {
  console.log("Use --run for a live SII test: one 1-CPU/4-GiB Notebook, success and intentional failure, same-session resume, then stop the test resource.");
  process.exit(0);
}
process.umask(0o077);
process.loadEnvFile(".env");
const repository = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const root = path.join(repository, "temp", `sii-live-${stamp}`);
const projectId = `prj_${randomUUID().replaceAll("-", "")}`;
const projectPath = path.join(root, "projects", projectId);
const workspacePath = path.join(projectPath, "workspaces");
const runtimePath = path.join(projectPath, "runtime", "sii-live-execution");
await fs.mkdir(workspacePath, { recursive: true });
await fs.mkdir(runtimePath, { recursive: true });
const resourceName = `sii-mcp-${Date.now().toString(36)}`;
const billingProject = "具有能动性的科学大模型";
const workspace = "CPU资源空间";
const report = { startedAt: new Date().toISOString(), projectId, resourceName, root,
  sessions: [], waits: [], tools: [], usageRequests: 0, assertions: {}, cleanup: {} };
const reportPath = path.join(root, "report.json");
const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const service = new SiiExperimentService({ projectsRoot: path.join(root, "projects"),
  inspireBin: process.env.SCIENCEEVOLVE_INSPIRE_BIN, workspaceRoot: process.env.SCIENCEEVOLVE_INSPIRE_WORKSPACE_ROOT,
  noProxy: [".sii.edu.cn"], knowledgeRoot: path.join(repository, ".agents", "skills", "inspire"), refreshMs: 30000 });
const signal = AbortSignal.timeout(12 * 60_000);
const preflightClient = new Client({ name: "sii-live-preflight", version: "1" });
let preflightBinding;
let failure;
let logicalSettled = false;
let observed = 0;
const requestBase = { project: { id: projectId, orchestration: { schemaVersion: 1 }, agents: { execution: { harness: "codex" } } },
  agent: "execution", kind: "worker", permission: "compute", invocationId: "sii-live-preflight", taskSessionId: "sii-live-preflight",
  projectPath, workspacePath, runtimePath };
async function tool(client, name, args) {
  // This helper is only used for read-only preflight. Never retry create here.
  const readOnly = name === "sii_read_knowledge" || (name === "sii_command" &&
    ["config check", "notebook quota", "notebook status"].includes(args.args?.slice(0, 2).join(" ")));
  for (let attempt = 0; ; attempt++) {
    const response = await client.callTool({ name, arguments: args });
    if (!response.isError) return response.structuredContent ?? JSON.parse(response.content.find(c => c.type === "text").text);
    const message = redactTrace(response.content.find(c => c.type === "text")?.text ?? "unknown").split("Call log:")[0];
    if (!readOnly || attempt >= 3 || !/429|Too Many Requests/.test(message)) throw new Error(`MCP ${name} rejected: ${message}`);
    console.log(JSON.stringify({ phase: "preflight_rate_limited", retryAfterSeconds: 30 }));
    await new Promise(resolve => setTimeout(resolve, 30_000));
  }
}
const program = path.join(workspacePath, "probe.py");
await fs.writeFile(program, `import json,os,sys,time\nrun_id,code,marker=sys.argv[1],int(sys.argv[2]),sys.argv[3]\ntime.sleep(90)\nresult={"run_id":run_id,"exit_code":code,"sum_squares":sum(x*x for x in range(10))}\nwith open(marker+".tmp","w") as f: json.dump(result,f);f.flush();os.fsync(f.fileno())\nos.replace(marker+".tmp",marker)\nsys.exit(code)\n`);
await fs.writeFile(path.join(workspacePath, "Memory.md"), "Live SII MCP test. All work stays in this test directory.\n");
const inboxPath = path.join(projectPath, "messages", "0001_sii-live-execution_to_execution.md");
await fs.mkdir(path.dirname(inboxPath), { recursive: true });
try {
  await service.start(); await service.refreshNow();
  assert.equal(await service.accountReader(), "ky26306");
  preflightBinding = await service.bind(requestBase, signal);
  preflightBinding.session = { schemaVersion: 1, harnessId: "codex", adapterVersion: "1", generation: 0,
    nativeId: "live-preflight-read-only", durable: true, createdAt: new Date().toISOString() };
  preflightBinding.activate();
  await preflightClient.connect(new StreamableHTTPClientTransport(new URL(preflightBinding.url)));
  const knowledge = await tool(preflightClient, "sii_read_knowledge", {});
  assert(knowledge.documents.includes("SKILL.md"));
  const checked = (await tool(preflightClient, "sii_command", { args: ["config", "check"] })).result;
  assert.equal(checked.data.auth_ok, true); assert.equal(checked.data.username, "ky26306");
  const quota = (await tool(preflightClient, "sii_command", { args: ["notebook", "quota", "--workspace", workspace] })).result;
  const row = quota.data.quotas.find(q => q.quota === "0,1,4" && q.compute_group_name === "CPU资源");
  assert(row, "The tiny CPU quota must be available");
  const source = (await tool(preflightClient, "sii_command", { args: ["notebook", "status", "openfars", "--workspace", workspace] })).result;
  assert.equal(source.data.project.name, billingProject);
  const image = source.data.mirror_url;
  assert(image, "Use an image actually running in this account and workspace");
  report.preflight = { account: "ky26306", quota: row.quota, group: row.compute_group_name, image, knowledge: true };
  await preflightClient.close(); preflightBinding.close();

  const publicKey = process.env.SCIENCEEVOLVE_SII_TEST_PUBLIC_KEY ?? path.resolve(repository, "../../.tools/inspire/ssh/id_ed25519.pub");
  assert((await fs.stat(publicKey)).isFile(), "Provide SCIENCEEVOLVE_SII_TEST_PUBLIC_KEY for Notebook connection setup");
  const connect = ["notebook", "connection", "refresh", resourceName, "--workspace", workspace, "--pubkey", publicKey, "--timeout", "90"];
  const successId = `${resourceName}-success`, failedId = `${resourceName}-failure`;
  const successMarker = path.join(workspacePath, "success.json"), failedMarker = path.join(workspacePath, "failure.json");
  const create = ["notebook", "create", "--name", resourceName, "--workspace", workspace, "--project", billingProject,
    "--group", row.compute_group_name, "--quota", row.quota, "--image", image, "--shm-size", "1", "--priority", "4"];
  const launch = (id, code, marker) => ["notebook", "exec", resourceName, "--account", "ky26306", "--cwd", workspacePath,
    `(nohup python3 '${program}' '${id}' ${code} '${marker}' > '${marker}.log' 2>&1 < /dev/null & echo LAUNCHED)`];
  const instructions = `You are testing the actual SII MCP. The user authorized one tiny temporary CPU Notebook and its cleanup.
Use only scienceevolve-sii MCP operations and the provided test files. Never run a CLI directly, allocate GPUs, submit another resource, modify other projects, or keep polling.
Follow these phases across natural turns, keeping your original session:
1. Call sii_submit_experiment with ${JSON.stringify({ args: create, request_id: `${resourceName}-resource`, required_for_task: false })}.
Persist the receipt id in memory. Call sii_defer_task on that id with your continuation context, then immediately END THIS TURN with a pending handoff. Do not wait or continue tool calls in that turn.
2. When the system resumes you with resource_ready, first call sii_command with ${JSON.stringify(connect)} to prepare this new Notebook connection (public key only; do not touch any other resource). Then register TWO runs on that Notebook, required_for_task=true, using sii_register_experiment:
${JSON.stringify({ kind: "notebook", name: resourceName, workspace, request_id: successId, completion_file: successMarker, required_for_task: true })}
${JSON.stringify({ kind: "notebook", name: resourceName, workspace, request_id: failedId, completion_file: failedMarker, required_for_task: true })}
Start them with sii_command args ${JSON.stringify(launch(successId, 0, successMarker))} and ${JSON.stringify(launch(failedId, 7, failedMarker))}.
Call sii_defer_task on BOTH new experiment ids, then END THIS TURN. Their marker records are exact-run facts, the failure exit code 7 is intentional.
This must be an actual sii_defer_task tool call, with both returned ids and a short continuation context; check its receipt before returning a pending handoff. An assistant message saying you will defer is not a tool call. Do not end phase 2 until the receipt exists.
3. On system notification, examine only the returned facts or call sii_get_experiment once per notified experiment. If one required result is pending, defer the remaining id and END THIS TURN. Do not poll.
4. After receiving BOTH succeeded and failed results, call sii_command with ${JSON.stringify(["notebook", "stop", resourceName, "--workspace", workspace])} to release this test resource.
Return one final handoff containing LIVE_SII_TEST_PASSED and the success=0/failure=7 observations. A platform failure during setup is NOT a test pass; report it honestly. No finish_task/control tool is installed in this isolated test.`;
  await fs.writeFile(inboxPath, instructions);
  const gateways = JSON.parse(await fs.readFile(path.resolve(repository, "../../openfars/data/gateways.json"), "utf8"));
  const gateway = gateways.gateways.find(g => g.name === "AIGW");
  assert(gateway?.apiKey && gateway.models.includes("kimi-k3"), "Existing configured Kimi gateway required");
  const configuration = { harness: "codex", model: "kimi-k3", gatewayId: gateway.id,
    gatewaySnapshot: { ...gateway, nativeProtocol: "responses", routeMode: "proxy" },
    skills: [], autoSkills: [], mcpServers: [], instructions, reasoningEffort: "low", permission: "compute",
    webSearch: false, sessionPersistence: true, decisionBy: "main" };
  const project = { id: projectId, title: "SII live MCP acceptance", requirement: instructions, phase: "execution:running", status: "running",
    orchestration: { schemaVersion: 1 }, agents: { execution: configuration }, agentSessionIds: {}, agentSessions: {}, agentSessionMeta: {} };
  const request = { ...requestBase, project, invocationId: "sii-live-execution", taskSessionId: "sii-live-execution", inboxPath,
    schemaPath: path.join(projectPath, "schema.json"), skillPaths: [], autoSkillPaths: [], availableSkillPaths: [],
    onDurableSessionStarted: async (session, legacyId) => {
      project.agentSessions.execution = session; project.agentSessionIds.execution = legacyId;
      report.sessions.push({ nativeId: session.nativeId, generation: session.generation, harnessId: session.harnessId, time: new Date().toISOString() });
      await save();
    },
    onTokenUsage: async () => { report.usageRequests++; await save(); },
    onOfficialHarnessEvent: async event => {
      const name = event.tool?.name ?? event.item?.tool ?? event.item?.name;
      if (name) report.tools.push({ name, phase: event.phase, durationMs: event.tool?.durationMs, at: new Date().toISOString() });
    },
    onExperimentWait: async waiting => {
      assert.equal(logicalSettled, false, "Unfinished model turn must not settle the logical task");
      report.waits.push({ waiting, at: new Date().toISOString(), usageRequests: report.usageRequests });
      if (waiting) {
        const doc = await service.document(projectPath);
        if (doc.experiments.some(e => e.required && !["succeeded", "failed", "cancelled"].includes(e.status))) {
          await assert.rejects(assertSiiControlAction(projectId, "execution", request.invocationId, { tool: "finish_task" }), /still needs experiment results/);
          report.assertions.prematureFinishBlocked = true;
        }
        observed = report.usageRequests;
      } else {
        assert.equal(report.usageRequests, observed, "No provider requests during system-only waiting");
        report.assertions.noModelPolling = true;
      }
      console.log(JSON.stringify({ phase: waiting ? "system_monitoring" : "same_session_resume", experiments: (await service.document(projectPath)).experiments.map(e => ({ kind: e.kind, status: e.status, required: e.required })) }));
      await save();
    }
  };
  const facade = new HarnessRuntimeFacade({ siiExperiments: service, inspireBin: process.env.SCIENCEEVOLVE_INSPIRE_BIN,
    inspireNoProxy: [".sii.edu.cn"], inspireWorkspaceRoot: process.env.SCIENCEEVOLVE_INSPIRE_WORKSPACE_ROOT,
    harnessExecutables: { codex: path.join(repository, "harness/codex/node_modules/.bin/codex") } });
  console.log(JSON.stringify({ phase: "native_model_started", resourceName, reportPath }));
  const trace = async (kind, message) => {
    if (["error", "warning"].includes(kind)) console.log(JSON.stringify({ trace: kind, message: redactTrace(message).split("Call log:")[0].slice(0, 500) }));
  };
  let result = await facade.run(request, trace, signal);
  // A model may end with a description of its next cleanup step. Finish this
  // isolated acceptance task with one explicit follow-up in the SAME session;
  // this is test orchestration after results arrive, never experiment polling.
  if (!/LIVE_SII_TEST_PASSED/.test(result.handoff)) {
    report.initialHandoff = result.handoff;
    report.followupUsed = true;
    const facts = (await service.document(projectPath)).experiments.filter(e => e.required);
    assert(facts.length === 2 && facts.every(e => ["succeeded", "failed"].includes(e.status) && e.acknowledged));
    const finalInstructions = `两项实验结果已接收，这是同一个任务的收尾。不得重新创建或启动资源。实际调用 sii_get_experiment 读取 ${facts.map(e => e.id).join("、")}，再用 sii_command 查询 ["notebook","status","${resourceName}","--workspace","${workspace}"]。如果资源尚未停止，实际调用 sii_command ["notebook","stop","${resourceName}","--workspace","${workspace}"]。完成工具调用后回复结果：退出码 0、故意失败退出码 7、资源状态。不要以准备执行的描述结束。`;
    const finalInbox = path.join(projectPath, "messages", "0002_sii-live-finalize_to_execution.md");
    const finalRuntime = path.join(projectPath, "runtime", "sii-live-finalize");
    await fs.mkdir(finalRuntime, { recursive: true });
    await fs.writeFile(finalInbox, finalInstructions);
    project.agents.execution.instructions = finalInstructions;
    project.requirement = finalInstructions;
    result = await facade.run({ ...request, invocationId: "sii-live-finalize", inboxPath: finalInbox, runtimePath: finalRuntime }, trace, signal);
  }
  logicalSettled = true;
  report.finalHandoff = result.handoff;
  const doc = await service.document(projectPath);
  report.experiments = doc.experiments.map(e => ({ id: e.id, name: e.name, status: e.status,
    runId: e.runId, required: e.required, nativeId: e.session.nativeId, generation: e.session.generation }));
  const successful = doc.experiments.find(e => e.runId === successId), failed = doc.experiments.find(e => e.runId === failedId);
  assert.equal(successful?.status, "succeeded"); assert.equal(failed?.status, "failed");
  assert.equal(JSON.parse(await fs.readFile(successMarker, "utf8")).sum_squares, 285);
  assert.equal(JSON.parse(await fs.readFile(failedMarker, "utf8")).exit_code, 7);
  assert(report.waits.filter(w => w.waiting).length >= 2);
  assert.equal(report.assertions.prematureFinishBlocked, true, "Observe the finish gate while an actual required program is pending");
  assert.equal(new Set(report.sessions.map(s => s.nativeId)).size, 1);
  assert.equal(new Set(report.sessions.map(s => s.generation)).size, 1);
  assert.equal(result.threadId, report.sessions[0].nativeId);
  assert.equal(doc.waits.length, 0);
  report.assertions = { ...report.assertions, liveSubmission: true, actualSuccess: true, actualFailure: true,
    sameNativeSession: true, sameGeneration: true, logicalTaskHeld: true, finalWaitCleared: true };
} catch (error) {
  failure = error;
  report.error = redactTrace(String(error)).split("Call log:")[0].slice(0, 2000);
  if (error.cause) report.cause = redactTrace(String(error.cause)).split("Call log:")[0].slice(0, 500);
} finally {
  await preflightClient.close(); preflightBinding?.close();
  // Only the uniquely named resource created by this test may be stopped.
  const doc = await service.document(projectPath);
  if (doc.experiments.some(e => e.name === resourceName && e.registration === "created")) {
    try {
      let state = await service.runJson(["notebook", "status", resourceName, "--workspace", workspace], workspacePath);
      if (!["STOPPED", "STOPPING"].includes(state.data.status)) {
        await service.runJson(["notebook", "stop", resourceName, "--workspace", workspace], workspacePath);
      }
      const deadline = Date.now() + 180_000;
      while (state.data.status !== "STOPPED" && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10_000));
        state = await service.runJson(["notebook", "status", resourceName, "--workspace", workspace], workspacePath);
      }
      report.cleanup = { resourceName, platformStatus: state.data.status, originalResourceUntouched: true };
      assert.equal(state.data.status, "STOPPED", "Test resource cleanup must be confirmed by the platform");
    } catch (error) {
      report.cleanup.error = redactTrace(String(error)).split("Call log:")[0].slice(0, 500);
      failure ??= error;
    }
  }
  report.finishedAt = new Date().toISOString();
  report.passed = !failure;
  await service.stop(); await save();
  console.log(JSON.stringify({ passed: report.passed, assertions: report.assertions, cleanup: report.cleanup, error: report.error, reportPath }));
}
if (failure) process.exitCode = 1;
