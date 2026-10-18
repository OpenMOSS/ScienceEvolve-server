import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { armR11 } from "../../scripts/r-projects/arm-r11.mjs";
import { buildManifest } from "../../scripts/r-projects/catalog.mjs";
import { createR11GatewayFetch } from "../src/acceptance-r11.js";
import { openInvocationGatewayRoute, type InvocationGatewayRoute } from "../src/harness-runtime/gateway-route.js";
import type { AgentConfig, AgentRunRequest, TraceSink } from "../src/types.js";
import type { HarnessDescriptor } from "../src/harness-runtime/contracts.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(variant = "gateway-error-once", deliveryMode = "native-stream") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "r11-route-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const requests: Array<{ url: string; body?: any }> = [];
  let fallback = false;
  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined; requests.push({ url: req.url!, body });
    res.setHeader("content-type", "application/json");
    if (fallback && body?.tool_choice === "required") {
      res.statusCode = 400; res.end(JSON.stringify({ error: { message: "tool_choice required is not supported" } })); return;
    }
    res.end(JSON.stringify(req.method === "GET" ? { data: [] } : {
      id: "chat-fixture", model: "model", choices: [{ index: 0, message: { role: "assistant", content: "verified 5" }, finish_reason: "stop" }]
    }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => provider.close((e) => e ? reject(e) : resolve())));
  const url = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
  const directory = path.join(root, "controller"), projectRoot = path.join(root, "project"); await fs.mkdir(projectRoot);
  const projectId = `prj_${"a".repeat(32)}`;
  const manifest = buildManifest({ runId: "fixture-r11", gatewayId: `gwy_${"a".repeat(32)}`, model: "model", harness: "pi",
    githubAccountId: `gha_${"b".repeat(32)}`, observedAt: new Date().toISOString(), evidencePath: "fixture-only.json" });
  const entry = manifest.cases.find((e) => e.code === "R11")!;
  const config: AgentConfig = { ...entry.payload.agents.implementer, gatewaySnapshot: { id: manifest.binding.gatewayId,
    name: "fixture", url, apiKey: "private-fixture-key", models: ["model"], defaultModel: "model",
    protocol: "chat-completions", nativeProtocol: "chat-completions", deliveryMode } };
  const repository = { provider: "github" as const, providerId: 42, owner: "test", name: entry.payload.git.repositoryName,
    private: true, defaultBranch: "main", htmlUrl: "https://github.com/test/repo", cloneUrl: "https://github.com/test/repo.git", observedAt: new Date().toISOString() };
  const arrival = { requestId: "arrival-first", sequence: 1, groupRunId: "run-child", targetNodeId: "child-worker",
    status: "queued", targetKind: "agent", agentId: "implementer" };
  const execution = { projectId, id: "scoped-exec-first", agentId: "implementer", ownershipEpoch: 1,
    executionBranch: "executions/scoped-exec-first", worktreePath: projectRoot, purpose: "delivery" as const };
  const base = "groups/run-child";
  const project = { id: projectId, title: entry.payload.title, status: "running", agents: { implementer: config }, scopedExecutions: [],
    scopedArrivals: [arrival], scopedGroupRuns: [{ id: arrival.groupRunId, groupId: "G_child", groupBranch: base, status: "running" }],
    git: { repository }, operations: [{ kind: "repository.create", status: "finalized", remoteFact: repository }] };
  const submission = { status: "accepted", code: "R11", base: manifest.serviceUrl, projectId, payloadSha256: entry.payloadSha256 };
  const armOptions = { directory, manifest, submission, project, arrivalRequestId: arrival.requestId, variant };
  const traces: Array<{ message: string; data: any }> = [];
  const onTrace: TraceSink = (_kind, message, data) => { traces.push({ message, data }); };
  const input = { directory, projectTitle: project.title, projectRoot, execution, arrivalRequestId: arrival.requestId,
    arrivalSequence: arrival.sequence, targetNodeId: arrival.targetNodeId, groupRunId: arrival.groupRunId,
    base, repository, config, invocationId: "inv-first", inputId: `scoped:${arrival.requestId}:epoch:1`, onTrace };
  const consumed = path.join(directory, `${projectId}.consumed.json`);
  const open = async (overrides = {}) => {
    const gatewayModelFetch = await createR11GatewayFetch({ ...input, ...overrides });
    const request = { project, agent: "implementer", invocationId: input.invocationId, gatewayModelFetch } as unknown as AgentRunRequest;
    const route = await openInvocationGatewayRoute({ id: "pi", label: "Pi", nativeProtocol: "chat-completions" } as HarnessDescriptor,
      request, onTrace, new AbortController().signal, { validateGatewayTarget: async () => undefined, bufferedResponseCache: new Map() });
    cleanup.push(() => route.close());
    return route;
  };
  const post = async (route: InvocationGatewayRoute, overrides = {}) => {
    const response = await fetch(`${route.baseUrl}/chat/completions`, { method: "POST",
      headers: { authorization: `Bearer ${route.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "model", messages: [{ role: "user", content: "private-fixture-prompt" }], stream: deliveryMode === "buffered-json", ...overrides }) });
    return { status: response.status, text: await response.text() };
  };
  return { input, armOptions, consumed, requests, traces, open, post, useFallback: () => { fallback = true; } };
}

it.each(["native-stream", "buffered-json"])("one 503 recovers through existing proxy retries on %s and cannot replay", async (mode) => {
  const f = await fixture("gateway-error-once", mode); await armR11(f.armOptions);
  const route = await f.open();
  const output = await f.post(route);
  expect(output.status).toBe(200); expect(output.text).toContain("verified 5");
  expect(f.requests).toHaveLength(1); expect(f.requests[0].body.model).toBe("model");
  const faultTraces = () => f.traces.filter((t) => t.message === "R11 controlled model transport response");
  expect(faultTraces()).toHaveLength(1);
  const receipt = await fs.readFile(f.consumed, "utf8");
  expect(JSON.parse(receipt)).toMatchObject({ stage: "before-upstream-dispatch", binding: {
    executionId: f.input.execution.id, invocationId: f.input.invocationId, inputId: f.input.inputId, route: { model: "model" } } });
  for (const secret of ["private-fixture-key", "private-fixture-prompt", f.input.config.gatewaySnapshot!.url]) expect(receipt).not.toContain(secret);
  await f.post(await f.open());
  expect(f.requests).toHaveLength(2); expect(faultTraces()).toHaveLength(1);
});

it.each(["native-stream", "buffered-json"])("persistent failure exhausts the two existing attempts on %s and isolates later turns", async (mode) => {
  const f = await fixture("gateway-unavailable", mode); await armR11(f.armOptions);
  const output = await f.post(await f.open());
  expect(output.text).toContain("R11 controlled gateway-unavailable");
  expect(f.requests).toHaveLength(0);
  expect(f.traces.filter((t) => t.message === "R11 controlled model transport response")).toHaveLength(2);
  await f.post(await f.open());
  expect(f.requests).toHaveLength(0);
  expect(f.traces.filter((t) => t.message === "R11 controlled model transport response")).toHaveLength(4);
  for (const override of [{ invocationId: "inv-other" }, { inputId: f.input.inputId + ":mechanism-repair:1" },
    { execution: { ...f.input.execution, ownershipEpoch: 2 } }]) {
    expect((await f.post(await f.open(override))).text).toContain("verified 5");
  }
  expect(f.requests).toHaveLength(3);
  await fs.writeFile(f.consumed, '{"interrupted":');
  const transport = await createR11GatewayFetch(f.input);
  await expect(transport!(f.input.config.gatewaySnapshot!.url + "/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "model" }) })).rejects.toThrow();
});

it("passes model discovery and unrelated model requests without consuming the arm, and preserves required-tool fallback", async () => {
  const f = await fixture(); await armR11(f.armOptions);
  const route = await f.open();
  const discovery = await fetch(`${route.baseUrl}/models`, { headers: { authorization: `Bearer ${route.token}` } }); await discovery.text();
  await f.post(route, { model: "unrelated-model" });
  await expect(fs.stat(f.consumed)).rejects.toThrow(/ENOENT/);
  f.useFallback();
  expect((await f.post(route, { tools: [{ type: "function", function: { name: "finish", parameters: { type: "object" } } }],
    tool_choice: { type: "function", function: { name: "finish" } } })).text).toContain("verified 5");
  expect(f.traces.filter((t) => t.message === "R11 controlled model transport response")).toHaveLength(1);
  expect(f.requests.slice(-2).map((r) => r.body.tool_choice)).toEqual(["required", { type: "function", function: { name: "finish" } }]);
});

it("rejects mismatched/late arm boundaries and binds no predicted native identity", async () => {
  const f = await fixture();
  expect(await createR11GatewayFetch(f.input)).toBeUndefined();
  await armR11(f.armOptions);
  for (const override of [{ arrivalSequence: 2 }, { targetNodeId: "other" }, { arrivalRequestId: "other" },
    { projectTitle: "N03 old project" }, { config: { ...f.input.config, model: "other" } },
    { config: { ...f.input.config, gatewaySnapshot: { ...f.input.config.gatewaySnapshot!, url: "https://other.invalid/v1" } } },
    { repository: { ...f.input.repository, providerId: 43 } }]) expect(await createR11GatewayFetch({ ...f.input, ...override })).toBeUndefined();
  const armPath = path.join(f.input.directory, `${f.input.execution.projectId}.arm.json`);
  const arm = JSON.parse(await fs.readFile(armPath, "utf8"));
  expect(arm.target.executionId).toBeUndefined(); expect(arm.target.invocationId).toBeUndefined();
  arm.armedAt = "2999-01-01T00:00:00Z"; await fs.writeFile(armPath, JSON.stringify(arm));
  expect(await createR11GatewayFetch(f.input)).toBeUndefined();
  await expect(fs.stat(f.consumed)).rejects.toThrow(/ENOENT/);
});

it("arming requires accepted creation, the first queued implementer and the locked route", async () => {
  const f = await fixture(); const options = f.armOptions;
  for (const override of [{ submission: { ...options.submission, status: "pending" } },
    { project: { ...options.project, scopedExecutions: [f.input.execution] } },
    { project: { ...options.project, scopedArrivals: [{ ...options.project.scopedArrivals[0], status: "running" }] } },
    { project: { ...options.project, agents: { implementer: { ...f.input.config, model: "other" } } } },
    { variant: "unspecified" }]) await expect(armR11({ ...options, ...override })).rejects.toThrow();
  await expect(fs.stat(f.input.directory)).rejects.toThrow(/ENOENT/);
});

it("does not arm an already opened route and cancels before consuming a newly bound route", async () => {
  const f = await fixture(); const route = await f.open(); await armR11(f.armOptions);
  expect((await f.post(route)).text).toContain("verified 5");
  await expect(fs.stat(f.consumed)).rejects.toThrow(/ENOENT/);
  const transport = await createR11GatewayFetch(f.input);
  await expect(transport!(f.input.config.gatewaySnapshot!.url + "/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "model" }), signal: AbortSignal.abort() })).rejects.toThrow();
  await expect(fs.stat(f.consumed)).rejects.toThrow(/ENOENT/);
});

it.each(["gateway-error-once", "gateway-unavailable"])("concurrent eligible requests preserve the %s latch", async (variant) => {
  const f = await fixture(variant); await armR11(f.armOptions);
  const transport = await createR11GatewayFetch(f.input);
  const responses = await Promise.all([1, 2, 3].map(() => transport!(f.input.config.gatewaySnapshot!.url + "/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "model" }) })));
  await Promise.all(responses.map((r) => r.text()));
  expect(responses.filter((r) => r.status === 503)).toHaveLength(variant === "gateway-error-once" ? 1 : 3);
  expect(f.requests).toHaveLength(variant === "gateway-error-once" ? 2 : 0);
  expect(f.traces.filter((t) => t.data?.first === true)).toHaveLength(1);
});
