import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fitContextInjection, injectionBudget } from "../src/context-injection-budget.js";
import { EXPLAINER_READ_CONTEXT_TOOL } from "../src/explainer-assistant-mcp.js";
import { EventHub } from "../src/event-hub.js";
import { ExecutionSummaryService } from "../src/execution-summary.js";
import { validateStagedInvocationInputs } from "../src/harness-runtime/invocation-inputs.js";
import { emptyProjectComputeUsage } from "../src/inspire-compute-usage.js";
import {
  ProjectExplainerBusyError,
  ProjectExplainerConfigurationError,
  ProjectExplainerService,
  type ProjectExplainerEvent,
  type ProjectExplainerRuntime
} from "../src/project-explainer.js";
import { ProjectStorage } from "../src/storage.js";
import { cloneAgentOrchestrationTemplate } from "../src/agent-orchestration.js";
import type { ProjectState } from "../src/types.js";
import { defaultAgentConfigs } from "../src/validation.js";
import {
  GatewayStore,
  type AdapterSmokeProbeRunner
} from "../src/agent-runtime.js";
import { PROTOCOL_ROUTER_COMPATIBILITY_VERSION } from "../src/protocol-router.js";
import type {
  ExplainerInvocationRequest,
  HarnessAdapter,
  HarnessDescriptor,
  HarnessEvent,
  SessionRef
} from "../src/harness-runtime/contracts.js";
import { HarnessRegistry } from "../src/harness-runtime/registry.js";

const temporaryRoots: string[] = [];
const summaryServices: ExecutionSummaryService[] = [];

/** Simulate selecting the two evidence records required by these probes. */
async function selectedRecommendationEvidence(input: ExplainerInvocationRequest): Promise<Record<string, any>> {
  const notice = await fs.readFile(input.inboxPath, "utf8");
  const indexPath = notice.match(/Context index: (.+)/)?.[1];
  if (!indexPath) return {};
  const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  const directory = index.baseDirectory;
  const evidence: Record<string, any> = {};
  for (const key of ["metadata", "inputAvailability"]) {
    const source = index.entries.find((entry: any) => entry.key === `recommendation.${key}`);
    if (!source) continue;
    const list = JSON.parse(await fs.readFile(path.join(directory, source.list.path), "utf8"));
    const selected = JSON.parse(await fs.readFile(path.join(directory, list.entries[0].detail.path), "utf8"));
    if (key === "metadata") Object.assign(evidence, selected);
    else evidence[key] = selected;
  }
  return evidence;
}

const capabilities = {
  structuredEvents: true,
  toolResults: true,
  durableSession: true,
  permissionPrompts: ["workspace", "compute", "yolo"],
  workspaceInputs: true,
  autoSkills: true,
  officialEvents: true,
  toolEvents: true,
  usageEvents: true,
  readOnlyExplainer: true,
  webSearch: false,
  skills: false,
  mcp: false
} as const;

const descriptors: HarnessDescriptor[] = [
  {
    schemaVersion: 1,
    id: "fixture-a",
    label: "Fixture A",
    adapterVersion: "1",
    nativeProtocol: "responses",
    purposes: ["workflow", "explainer", "probe"],
    executableEnv: "FIXTURE_A_BIN",
    defaultCommand: "fixture-a",
    default: true,
    notes: "test adapter",
    explainerIsolation: "adapter-read-only-tools",
    capabilities
  },
  {
    schemaVersion: 1,
    id: "fixture-b",
    label: "Fixture B",
    adapterVersion: "2",
    nativeProtocol: "chat-completions",
    purposes: ["workflow", "explainer", "probe"],
    executableEnv: "FIXTURE_B_BIN",
    defaultCommand: "fixture-b",
    notes: "test adapter",
    explainerIsolation: "adapter-read-only-tools",
    capabilities
  },
  {
    schemaVersion: 1,
    id: "fixture-legacy",
    label: "Fixture Legacy",
    adapterVersion: "1",
    nativeProtocol: "anthropic-messages",
    purposes: ["workflow", "explainer", "probe"],
    selectable: false,
    executableEnv: "FIXTURE_LEGACY_BIN",
    defaultCommand: "fixture-legacy",
    notes: "legacy test adapter",
    explainerIsolation: "adapter-read-only-tools",
    capabilities
  }
];

function adapter(descriptor: HarnessDescriptor): HarnessAdapter {
  return {
    descriptor,
    resolveExecutable: async () => "/bin/true",
    fingerprint: async () => `fingerprint-${descriptor.id}`,
    run: async () => ({ handoff: "unused" }),
    createSession: (_request, _inputs, generation, durable) => ({
      schemaVersion: 1,
      harnessId: descriptor.id,
      adapterVersion: descriptor.adapterVersion,
      generation,
      nativeId: `${descriptor.id}-native-${generation}`,
      durable,
      createdAt: "2026-09-16T00:00:00.000Z"
    }),
    validateNativeSession: (nativeId) => nativeId.startsWith(`${descriptor.id}-native-`)
  };
}

function smokeRunner(catalog: HarnessDescriptor[] = descriptors): AdapterSmokeProbeRunner {
  const identity = (harness: string) => ({
    cacheKey: `cache-${harness}`,
    adapterVersion: catalog.find((descriptor) => descriptor.id === harness)!.adapterVersion,
    executableFingerprint: `fingerprint-${harness}`,
    routerCompatibilityVersion: PROTOCOL_ROUTER_COMPATIBILITY_VERSION
  });
  return {
    harnessIds: () => catalog.map((descriptor) => descriptor.id),
    nativeProtocol: (harness) => catalog.find((descriptor) => descriptor.id === harness)?.nativeProtocol,
    cacheKey: async ({ harness }) => identity(harness),
    runSmoke: async ({ harness }) => identity(harness)
  };
}

async function successfulResponsesProbe(
  _input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  const toolProbe = body.tool_choice !== undefined;
  if (body.stream === true) {
    return new Response((toolProbe ? [
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"probe-item","type":"function_call","call_id":"probe-call","name":"openfars_probe","arguments":""}}',
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      ""
    ] : [
      'data: {"type":"response.output_text.delta","delta":"ok"}',
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      ""
    ]).join("\n\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  }
  return Response.json(toolProbe
    ? { output: [{ type: "function_call", call_id: "probe-call", name: "openfars_probe", arguments: '{"value":"ok"}' }] }
    : { output_text: "ok", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] });
}

function minimalState(id: string): ProjectState {
  const zero = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    invocations: 0
  };
  const now = new Date().toISOString();
  return {
    id,
    title: "Project explainer test",
    requirement: "Explain this project's evidence without modifying it.",
    status: "running",
    phase: "main:running",
    createdAt: now,
    updatedAt: now,
    currentAgent: "main",
    activeInvocationId: "inv_explainer_test",
    turn: 1,
    cycle: 1,
    eventSeq: 0,
    consecutiveFailures: 0,
    completionGeneration: 0,
    controlProtocol: "natural-language-tools-v1",
    configurationLocked: true,
    runCounts: { idea: 0, main: 1, execution: 0, writing: 0, review: 0 },
    mainInvocationSeq: 1,
    agents: structuredClone(defaultAgentConfigs),
    orchestration: cloneAgentOrchestrationTemplate(),
    userInputs: [],
    tokenUsage: {
      ...zero,
      byAgent: {
        idea: { ...zero },
        main: { ...zero },
        execution: { ...zero },
        writing: { ...zero },
        review: { ...zero }
      }
    },
    computeUsage: emptyProjectComputeUsage()
  };
}

async function setup(
  runExplainer?: ProjectExplainerRuntime["runExplainer"],
  catalogDescriptors: HarnessDescriptor[] = descriptors
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-explainer-"));
  temporaryRoots.push(root);
  const storage = new ProjectStorage(path.join(root, "data"), new EventHub());
  await storage.initialize();
  const projectId = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await storage.createProject(minimalState(projectId));
  await fs.writeFile(
    path.join(storage.projectDir(projectId), "workspaces", "evidence.md"),
    "fixture evidence\n",
    "utf8"
  );
  const gatewayStore = new GatewayStore(path.join(root, "data"), {
    fetch: successfulResponsesProbe,
    resolveHostname: async () => ["93.184.216.34"],
    testTimeoutMs: 1_000,
    adapterSmokeProbe: smokeRunner([...descriptors, ...catalogDescriptors])
  });
  const gateway = await gatewayStore.create({
    name: "Explainer gateway",
    url: "https://gateway.example.test/v1",
    apiKey: "server-only",
    models: ["fixture-model"],
    defaultModel: "fixture-model",
    protocol: "responses"
  });
  await gatewayStore.testHarness(gateway.id, "fixture-a", "fixture-model");
  await gatewayStore.testHarness(gateway.id, "fixture-b", "fixture-model");
  const registry = new HarnessRegistry(catalogDescriptors, catalogDescriptors.map(adapter));
  const calls: ExplainerInvocationRequest[] = [];
  const defaultRun = vi.fn(async (input: ExplainerInvocationRequest) => {
    calls.push(input);
    const session: SessionRef = input.session ?? {
      schemaVersion: 1,
      harnessId: input.harnessId,
      adapterVersion: registry.descriptor(input.harnessId).adapterVersion,
      generation: 0,
      nativeId: `${input.harnessId}-native-0`,
      durable: true,
      createdAt: "2026-09-16T00:00:00.000Z"
    };
    const events: HarnessEvent[] = [
      {
        schemaVersion: 1,
        eventId: `${input.invocationId}:tool-start`,
        seq: 0,
        timestamp: "2026-09-16T00:00:00.000Z",
        invocationId: input.invocationId,
        harnessId: input.harnessId,
        kind: "tool.started",
        phase: "started",
        tool: { callId: "read-1", name: "Read", status: "started", input: { path: "evidence.md" } }
      },
      {
        schemaVersion: 1,
        eventId: `${input.invocationId}:tool-end`,
        seq: 1,
        timestamp: "2026-09-16T00:00:01.000Z",
        invocationId: input.invocationId,
        harnessId: input.harnessId,
        kind: "tool.completed",
        phase: "completed",
        tool: { callId: "read-1", name: "Read", status: "completed", outputPreview: "fixture evidence" }
      },
      {
        schemaVersion: 1,
        eventId: `${input.invocationId}:answer`,
        seq: 2,
        timestamp: "2026-09-16T00:00:02.000Z",
        invocationId: input.invocationId,
        harnessId: input.harnessId,
        kind: "assistant.message",
        phase: "completed",
        message: "项目回答。"
      }
    ];
    for (const event of events) await input.onEvent(event);
    return { answer: "项目回答。", session };
  });
  const runtime: ProjectExplainerRuntime = {
    harnessCatalog: () => registry.publicCatalog(),
    assertExplainerAvailable: () => undefined,
    runExplainer: runExplainer ?? defaultRun
  };
  return {
    storage,
    projectId,
    gateway,
    gatewayStore,
    calls,
    explainer: new ProjectExplainerService(runtime, storage, { gatewayStore })
  };
}

afterEach(async () => {
  await Promise.all(summaryServices.splice(0).map((service) => service.shutdown()));
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })
  ));
});

describe("ProjectExplainerService", () => {
  it("splits index organization into smaller fresh sessions for a smaller configured model window", async () => {
    const calls: ExplainerInvocationRequest[] = [];
    const f = await setup(async input => {
      calls.push(input);
      expect(injectionBudget(input.prompt, 16384, JSON.stringify(EXPLAINER_READ_CONTEXT_TOOL)).estimatedTokens).toBeLessThanOrEqual(8192);
      const children = JSON.parse(input.prompt.split("\n\n").at(-1)!).children as Array<{ id: string }>;
      return { answer: JSON.stringify({ summary: "A short topic", items: children.map(child => ({ id: child.id, summary: "Source result" })),
        groups: [{ summary: "Related results", members: children.map(child => child.id) }] }), session: {} as SessionRef };
    });
    await f.gatewayStore.update(f.gateway.id, { name: "Explainer gateway", url: "https://gateway.example.test/v1", apiKey: "server-only",
      models: ["fixture-model"], defaultModel: "fixture-model", protocol: "responses", modelContextWindows: { "fixture-model": 16384 } });
    const projectPath = f.storage.projectDir(f.projectId), baseDirectory = path.join(projectPath, "runtime", "organization-sources");
    await fs.mkdir(path.join(baseDirectory, "context-records"), { recursive: true });
    const children = Array.from({ length: 8 }, (_, index) => ({ id: `item-${index}`, metadata: { id: `record-${index}` },
      summary: "s".repeat(1300), path: `context-records/${String(index).padStart(64, "0")}.json`, total: 1 }));
    for (const child of children) await fs.writeFile(path.join(baseDirectory, child.path), JSON.stringify({ id: child.id, output: "Original record" }));
    const result = await f.explainer.organizeContext({ key: "adaptive", projectId: f.projectId, projectPath, baseDirectory, source: "history", level: 1, children }, new AbortController().signal);
    expect(calls.length).toBeGreaterThan(1); expect(new Set(calls.map(call => call.invocationId)).size).toBe(calls.length);
    expect(result.items).toHaveLength(8); expect(new Set(result.groups.flatMap(group => group.members)).size).toBe(8);
  });

  it("organizes context with the configured Explainer in fresh read-only sessions without touching user chat", async () => {
    const calls: ExplainerInvocationRequest[] = [];
    const f = await setup(async input => {
      calls.push(input);
      expect(input.session).toBeUndefined(); expect(input.evidenceInPrompt).toBe(true);
      expect(input.harnessId).toBe("fixture-b"); expect(input.model).toBe("fixture-model");
      expect(input.prompt).not.toContain("RAW_EXPERIMENT_RESULT");
      const quoted = JSON.parse(input.prompt.split("\n\n").at(-1)!);
      const client = new Client({ name: "organizer", version: "1" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(input.assistantMcp!.url)));
        expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["read_context"]);
        const selected = await client.callTool({ name: "read_context", arguments: { path: quoted.children[0].path } });
        expect(JSON.stringify(selected.content)).toContain("RAW_EXPERIMENT_RESULT");
      } finally { await client.close(); }
      return { answer: JSON.stringify({ summary: "saved experiment result", items: [{ id: quoted.children[0].id, summary: "result verified" }],
        groups: [{ summary: "experiment topic", members: [quoted.children[0].id] }] }),
        session: { schemaVersion: 1, harnessId: input.harnessId, adapterVersion: "1", nativeId: input.invocationId,
          generation: 0, durable: true, createdAt: new Date().toISOString() } };
    });
    await f.explainer.updateConfig(f.projectId, { harness: "fixture-b", gatewayId: f.gateway.id, model: "fixture-model", reasoningEffort: "high", confirmHarnessSwitch: true });
    const projectPath = f.storage.projectDir(f.projectId), sourceRoot = path.join(projectPath, "runtime", "sources");
    await fs.mkdir(path.join(sourceRoot, "context-records"), { recursive: true });
    const file = `context-records/${"a".repeat(64)}.json`;
    await fs.writeFile(path.join(sourceRoot, file), '{"result":"RAW_EXPERIMENT_RESULT"}');
    const chat = path.join(projectPath, "runtime", "explainer", "session.json");
    await fs.writeFile(chat, "PRESERVE_USER_INTERACTIVE_SESSION");
    const job = { key: "test-context", projectId: f.projectId, projectPath, baseDirectory: sourceRoot, source: "experiments", level: 0,
      children: [{ id: "result-1", metadata: { id: "exp-1", status: "completed" }, path: file, total: 1 }] };
    for (let index = 0; index < 2; index++) await expect(f.explainer.organizeContext(job, new AbortController().signal)).resolves.toMatchObject({ summary: "saved experiment result" });
    expect(calls).toHaveLength(2); expect(calls[0].invocationId).not.toBe(calls[1].invocationId);
    expect(calls[0].runtimePath).not.toBe(calls[1].runtimePath);
    expect(await fs.readFile(chat, "utf8")).toBe("PRESERVE_USER_INTERACTIVE_SESSION");
    expect(await fs.readFile(path.join(sourceRoot, file), "utf8")).toContain("RAW_EXPERIMENT_RESULT");
  });

  it.each(["codex", "pi", "dsh", "fixture-text-only"])("makes unparsed binary inputs explicit for the text-only %s recommendation", async harness => {
    const calls: ExplainerInvocationRequest[] = [];
    const { explainer, storage, gateway, gatewayStore } = await setup(async input => {
      calls.push(input);
      const evidence = await selectedRecommendationEvidence(input);
      expect(evidence).toMatchObject({ requirement: "Read evidence", inputAvailability: {
        textOnly: true, unavailableFiles: [{ path: "image.png", kind: "image" }, { path: "paper.pdf", kind: "pdf" }]
      } });
      expect(evidence.inputAvailability.warnings).toHaveLength(2);
      expect(await fs.readFile(path.join(input.workspacePath, "user_inputs", "notes.txt"), "utf8")).toBe("Observed 42 samples");
      expect(await fs.readFile(path.join(input.workspacePath, "user_inputs", "image.png"))).toEqual(Buffer.from([137, 80, 78, 71]));
      return { answer: "{}", session: {} as SessionRef };
    }, [{ ...descriptors[harness === "codex" ? 0 : 1]!, id: harness, label: harness, default: true }]);
    await gatewayStore.testHarness(gateway.id, harness, "fixture-model");
    const result = await explainer.generateRecommendation({ instructions: "Recommend only tools.", evidence: { requirement: "Read evidence" },
      attachments: [{ path: "notes.txt", kind: "text", text: "Observed 42 samples" },
        { path: "image.png", kind: "image", mediaType: "image/png", data: Buffer.from([137, 80, 78, 71]).toString("base64") },
        { path: "paper.pdf", kind: "pdf", mediaType: "application/pdf", data: Buffer.from("%PDF-test").toString("base64") }]
    }, new AbortController().signal);
    expect(result.inputWarnings).toHaveLength(2);
    expect(result.inputWarnings![0]).toContain("image.png");
    expect(result.inputWarnings![1]).toContain("paper.pdf");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.session).toBeUndefined();
    expect(await fs.readdir(path.join(storage.root, ".explainer-drafts"))).toEqual([]);
  });

  it.each([
    { formats: ["text", "image"] as const, unavailable: ["paper.pdf"] },
    { formats: ["text", "image", "pdf"] as const, unavailable: [] }
  ])("uses declared formats for a new Adapter's actual recommendation input transport: %j", async row => {
    let evidence: Record<string, any> | undefined;
    const descriptor: HarnessDescriptor = { ...descriptors[0]!, id: "fixture-media", label: "Media fixture",
      capabilities: { ...capabilities, explainerInputFormats: row.formats } };
    const { explainer, gateway, gatewayStore } = await setup(async input => {
      evidence = await selectedRecommendationEvidence(input);
      expect(await fs.readFile(path.join(input.workspacePath, "user_inputs", "image.png"))).toEqual(Buffer.from([137, 80]));
      return { answer: "{}", session: {} as SessionRef };
    }, [descriptor]);
    await gatewayStore.testHarness(gateway.id, descriptor.id, "fixture-model");
    const result = await explainer.generateRecommendation({ instructions: "Use the actually available evidence.", evidence: {}, attachments: [
      { path: "image.png", kind: "image", mediaType: "image/png", data: Buffer.from([137, 80]).toString("base64") },
      { path: "paper.pdf", kind: "pdf", mediaType: "application/pdf", data: Buffer.from("%PDF-fixture").toString("base64") }
    ] }, new AbortController().signal);
    expect(result.inputWarnings ?? []).toHaveLength(row.unavailable.length);
    expect(evidence?.inputAvailability?.unavailableFiles?.map((file: { path: string }) => file.path) ?? []).toEqual(row.unavailable);
    if (row.unavailable.length) expect(evidence?.inputAvailability.textOnly).toBe(false);
    else expect(evidence?.inputAvailability).toBeUndefined();
  });

  it("runs project recommendations through the same read-only Explainer without borrowing chat history or session", async () => {
    const inputs: ExplainerInvocationRequest[] = [];
    const { explainer, projectId, storage } = await setup(async (input) => {
      inputs.push(input);
      await validateStagedInvocationInputs(input);
      if (input.invocationId.startsWith("explainer_recommendation_")) {
        expect(input.session).toBeUndefined();
        expect(input.model).toBe("fixture-model");
        expect(input.reasoningEffort).toBe("high");
        expect(input.prompt).not.toContain("Keep existing identity");
        expect(await selectedRecommendationEvidence(input)).toMatchObject({ requirement: "Keep existing identity" });
        expect(await fs.readFile(path.join(input.workspacePath, "user_inputs", "inputs", "source.md"), "utf8")).toBe("Original input");
        expect(await fs.readFile(path.join(input.workspacePath, "user_inputs", "image.png"))).toEqual(Buffer.from([137, 80, 78, 71]));
        if (process.platform !== "win32") expect((await fs.stat(input.workspacePath)).mode & 0o777).toBe(0o500);
        expect(await fs.readFile(input.memoryPath, "utf8")).not.toContain("Old chat question");
      }
      return { answer: '{"skills":[],"autoSkills":[],"mcpServers":[],"experimentMcp":false}', session: {} as SessionRef };
    });
    await explainer.ask(projectId, "Old chat question", () => undefined, new AbortController().signal);
    const history = await explainer.history(projectId);
    const sessionPath = path.join(storage.projectDir(projectId), "runtime", "explainer", "session.json");
    const sessionBefore = await fs.readFile(sessionPath);
    const sourceBefore = await fs.readFile(path.join(storage.projectDir(projectId), "workspaces", "evidence.md"));
    const result = await explainer.generateRecommendation({
      projectId,
      instructions: "Return exactly one tool selection object.",
      evidence: { requirement: "Keep existing identity" },
      attachments: [
        { path: "inputs/source.md", kind: "text", text: "Original input" },
        { path: "image.png", kind: "image", mediaType: "image/png", data: Buffer.from([137, 80, 78, 71]).toString("base64") }
      ]
    }, new AbortController().signal);
    expect(result.answer).toContain('"experimentMcp":false');
    expect(result.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]!.workspacePath).not.toBe(inputs[0]!.workspacePath);
    expect(inputs[1]!.projectPath).not.toBe(storage.projectDir(projectId));
    expect(await explainer.history(projectId)).toEqual(history);
    expect(await fs.readFile(sessionPath)).toEqual(sessionBefore);
    expect(await fs.readFile(path.join(storage.projectDir(projectId), "workspaces", "evidence.md"))).toEqual(sourceBefore);
    expect(await fs.readdir(path.join(storage.root, ".explainer-drafts"))).toEqual([]);
    expect(explainer.isActive(projectId)).toBe(false);
  });

  it("shares configurable Explainer defaults across detached draft tasks without creating a project or replacing an existing project config", async () => {
    const { explainer, projectId, storage, gateway, calls } = await setup();
    await explainer.updateConfig(projectId, { harness: "fixture-a", gatewayId: gateway.id, model: "fixture-model", reasoningEffort: "low" });
    const history = await explainer.history(projectId);
    const projectConfig = await explainer.getConfig(projectId);
    const projectsBefore = await fs.readdir(storage.projectsDir());
    await explainer.updateDraftConfig({ harness: "fixture-b", gatewayId: gateway.id, model: "fixture-model", reasoningEffort: "medium" });
    const draft = await explainer.getRecommendationConfig();
    expect(draft.config).toMatchObject({ harness: "fixture-b", reasoningEffort: "medium", revision: 1 });
    for (const instructions of ["Return a complete project configuration.", "Return only the target Agent's tools."]) {
      await explainer.generateRecommendation({ instructions, evidence: { title: "Unsaved draft" }, configurationFingerprint: draft.fingerprint }, new AbortController().signal);
    }
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.harnessId === "fixture-b" && call.reasoningEffort === "medium" && !call.session)).toBe(true);
    expect(new Set(calls.map((call) => call.projectId)).size).toBe(2);
    expect(calls.every((call) => call.projectId.startsWith("explainer_draft_") && call.projectId !== projectId)).toBe(true);
    expect(await fs.readdir(storage.projectsDir())).toEqual(projectsBefore);
    expect(await fs.readdir(path.join(storage.root, ".explainer-drafts"))).toEqual([]);
    expect(await explainer.getConfig(projectId)).toEqual(projectConfig);
    expect(await explainer.history(projectId)).toEqual(history);
  });

  it("forwards detached model progress as counts without exposing reasoning or unfinished output", async () => {
    const progress = vi.fn();
    const { explainer } = await setup(async input => {
      const event = { phase: "delta" as const, requestId: "request-1", timestamp: "2026-10-14T00:00:00Z", streaming: true, deliveryMode: "native-stream" as const };
      await input.onModelStreamEvent?.({ ...event, deltaKind: "reasoning", text: "private reasoning" });
      await input.onModelStreamEvent?.({ ...event, deltaKind: "visible-text", text: '{"partial":' });
      await input.onModelStreamEvent?.({ ...event, deltaKind: "tool-arguments", text: "private tool data" });
      return { answer: "{}", session: {} as SessionRef };
    });
    await explainer.generateRecommendation({ instructions: "Return JSON", evidence: {}, onModelProgress: progress }, new AbortController().signal);
    expect(progress.mock.calls.map(([value]) => value)).toEqual([
      { kind: "reasoning", characters: "private reasoning".length },
      { kind: "output", characters: '{"partial":'.length }
    ]);
    expect(JSON.stringify(progress.mock.calls)).not.toContain("private");
    expect(JSON.stringify(progress.mock.calls)).not.toContain("partial");
  });

  it("rejects a stale Explainer selection before generation and one changed during generation", async () => {
    let changeConfiguration!: () => Promise<void>;
    const run = vi.fn(async () => {
      await changeConfiguration();
      return { answer: "old result", session: {} as SessionRef };
    });
    const { explainer, gateway, storage } = await setup(run);
    const first = await explainer.getRecommendationConfig();
    await explainer.updateDraftConfig({ harness: "fixture-b", gatewayId: gateway.id, model: "fixture-model" });
    await expect(explainer.generateRecommendation({ instructions: "Return JSON", evidence: {}, configurationFingerprint: first.fingerprint }, new AbortController().signal)).rejects.toThrow("配置已变化");
    expect(run).not.toHaveBeenCalled();
    changeConfiguration = async () => { await explainer.updateDraftConfig({ harness: "fixture-a", gatewayId: gateway.id, model: "fixture-model" }); };
    await expect(explainer.generateRecommendation({ instructions: "Return JSON", evidence: {} }, new AbortController().signal)).rejects.toThrow("配置已变化");
    expect(run).toHaveBeenCalledOnce();
    expect(await fs.readdir(path.join(storage.root, ".explainer-drafts"))).toEqual([]);
  });

  it("cancels detached turns at shutdown and cleans their private inputs without adding chat history", async () => {
    const run = vi.fn(async (_input: ExplainerInvocationRequest, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const { explainer, storage, projectId } = await setup(run);
    const before = await explainer.history(projectId);
    const failure = explainer.generateRecommendation({ instructions: "Return JSON", evidence: {} }, new AbortController().signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await explainer.shutdown();
    expect(await failure).toBeInstanceOf(Error);
    expect(await fs.readdir(path.join(storage.root, ".explainer-drafts"))).toEqual([]);
    expect(await explainer.history(projectId)).toEqual(before);
  });

  it("rejects unsafe or duplicate attachment paths and removes the failed draft", async () => {
    const { explainer, storage, calls } = await setup();
    for (const paths of [["../escape.md"], ["safe.md", "safe.md"]]) {
      await expect(explainer.generateRecommendation({
        instructions: "Return JSON", evidence: {},
        attachments: paths.map((filePath) => ({ path: filePath, kind: "text" as const, text: "Input" }))
      }, new AbortController().signal)).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
    expect(await fs.readdir(path.join(storage.root, ".explainer-drafts"))).toEqual([]);
  });

  it("summarizes full saved output in a fresh read-only turn without altering chat history", async () => {
    let inbox = "";
    const { explainer, projectId, gateway } = await setup(async (input) => {
      expect(input.session).toBeUndefined();
      expect(input.gateway.id).toBeDefined();
      expect(input.model).toBe("fixture-model");
      expect(input.harnessId).toBe("fixture-a");
      expect(input.reasoningEffort).toBe("low");
      expect(await fs.readdir(input.workspacePath)).toEqual(["Memory.md", `${input.invocationId}.md`]);
      // Exercise the real Facade staging checks, not only the mocked model call.
      await expect(validateStagedInvocationInputs(input)).resolves.toMatchObject({ inboxPath: input.inboxPath });
      inbox = await fs.readFile(input.inboxPath, "utf8");
      expect(input.prompt).toContain("不得修改文件");
      expect(input.prompt).toContain("不要调用工具");
      expect(input.prompt).toContain("最后的实验结果：92%");
      return { answer: "完成实验，准确率 92%，仍待复核。", session: {} as SessionRef };
    });
    const before = await explainer.history(projectId);
    const fullOutput = "输出".repeat(2000) + "最后的实验结果：92%";
    expect(await explainer.summarizeOutput(projectId, fullOutput, new AbortController().signal)).toContain("92%");
    expect(inbox).toBe(fullOutput);
    expect(await explainer.history(projectId)).toEqual(before);
    expect(explainer.isActive(projectId)).toBe(false);
    expect((await explainer.getConfig(projectId)).gatewayId).toBe(gateway.id);
  });

  it("coarsens quoted summary input for a small model window while preserving its full saved output", async () => {
    const fullOutput = "实验结果".repeat(1000) + "准确率 92%";
    const f = await setup(async input => {
      const window = input.gateway.modelContextWindows?.[input.model];
      expect(window).toBe(16384);
      expect(injectionBudget(input.prompt, window).estimatedTokens).toBeGreaterThan(8192);
      const fitted = fitContextInjection(input.prompt, window, input.contextBackgrounds);
      expect(fitted.budget.estimatedTokens).toBeLessThanOrEqual(8192);
      expect(fitted.prompt).toContain(input.inboxPath);
      expect(fitted.prompt).toContain("read_context");
      expect(fitted.prompt).not.toContain("<saved-agent-output>");
      expect(await fs.readFile(input.inboxPath, "utf8")).toBe(fullOutput);
      return { answer: "实验准确率 92%。", session: {} as SessionRef };
    });
    await f.gatewayStore.update(f.gateway.id, { name: "Explainer gateway", url: "https://gateway.example.test/v1", apiKey: "server-only",
      models: ["fixture-model"], defaultModel: "fixture-model", protocol: "responses", modelContextWindows: { "fixture-model": 16384 } });
    expect(await f.explainer.summarizeOutput(f.projectId, fullOutput, new AbortController().signal)).toContain("92%");
  });

  it("deduplicates summary jobs, caches across restart, and regenerates changed saved output", async () => {
    const { storage, projectId } = await setup();
    const state = minimalState(projectId);
    await storage.writeHandoff(state, "main", "inv_summary", "original".repeat(2000));
    const summarize = vi.fn(async () => "执行摘要");
    const service = new ExecutionSummaryService(storage, new EventHub(), summarize);
    summaryServices.push(service);
    await Promise.all(Array.from({ length: 5 }, () => service.ensure(projectId, "inv_summary")));
    await vi.waitFor(async () => expect((await service.ensure(projectId, "inv_summary")).status).toBe("completed"));
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]?.length).toBe(3);
    await service.shutdown();
    const resumed = new ExecutionSummaryService(storage, new EventHub(), summarize);
    summaryServices.push(resumed);
    expect((await resumed.ensure(projectId, "inv_summary")).text).toBe("执行摘要");
    expect(summarize).toHaveBeenCalledTimes(1);
    await storage.writeHandoff(state, "main", "inv_summary", "new saved output");
    await resumed.ensure(projectId, "inv_summary");
    await vi.waitFor(async () => expect((await resumed.ensure(projectId, "inv_summary")).status).toBe("completed"));
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("starts asynchronously on handoff events and only retries failures explicitly", async () => {
    const { storage, projectId } = await setup();
    await storage.writeHandoff(minimalState(projectId), "main", "inv_failed", "full output");
    const hub = new EventHub();
    const summarize = vi.fn(async () => { throw new Error("模型暂不可用"); });
    const service = new ExecutionSummaryService(storage, hub, summarize);
    summaryServices.push(service);
    expect(() => hub.publish({ projectId, seq: 1, ts: new Date().toISOString(), type: "handoff.saved", message: "", data: { invocationId: "inv_failed" } })).not.toThrow();
    await vi.waitFor(async () => expect((await service.ensure(projectId, "inv_failed")).status).toBe("failed"));
    await service.ensure(projectId, "inv_failed");
    expect(summarize).toHaveBeenCalledTimes(1);
    await service.ensure(projectId, "inv_failed", true);
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(2));
    await expect(service.ensure(projectId, "../state")).rejects.toThrow("Invalid invocation");
  });

  it("recovers an interrupted summary record and cancels running work on shutdown", async () => {
    const { storage, projectId } = await setup();
    await storage.writeHandoff(minimalState(projectId), "main", "inv_interrupted", "saved output");
    const directory = path.join(storage.projectDir(projectId), "runtime", "execution-summaries");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "inv_interrupted.json"), JSON.stringify({ invocationId: "inv_interrupted", status: "running" }));
    const summarize = vi.fn(async (_id: string, _output: string, signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("已取消")), { once: true });
    }));
    const service = new ExecutionSummaryService(storage, new EventHub(), summarize);
    summaryServices.push(service);
    await service.ensure(projectId, "inv_interrupted");
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    await service.shutdown();
    expect(JSON.parse(await fs.readFile(path.join(directory, "inv_interrupted.json"), "utf8"))).toMatchObject({ status: "failed", error: "已取消" });
  });

  it("uses Registry metadata, independently switches Harness, and rebuilds only its Session", async () => {
    const { explainer, projectId, gateway } = await setup();
    await expect(explainer.getConfig(projectId)).resolves.toMatchObject({
      harness: "fixture-a",
      gatewayId: gateway.id,
      nativeProtocol: "responses",
      available: true
    });
    await expect(explainer.updateConfig(projectId, {
      harness: "fixture-b",
      gatewayId: gateway.id,
      model: "fixture-model"
    })).resolves.toMatchObject({
      harness: "fixture-b",
      nativeProtocol: "chat-completions",
      gatewayProtocol: "responses",
      routeMode: "proxy",
      routeDirection: "chat-completions->responses",
      revision: 1,
      available: true
    });
    expect((await explainer.history(projectId)).events).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "已切换 harness，历史记录可按需读取" })
    ]));
    await expect(explainer.updateConfig(projectId, {
      harness: "removed-harness",
      gatewayId: gateway.id,
      model: "fixture-model"
    })).rejects.toBeInstanceOf(ProjectExplainerConfigurationError);
  });

  it.each(["untested", "failed", "stale"])("allows saving, recommendations and questions with a %s probe, showing a warning", async (status) => {
    const { explainer, projectId, gateway, gatewayStore, calls } = await setup();
    if (status !== "stale") {
      await gatewayStore.update(gateway.id, (await gatewayStore.get(gateway.id))!);
    }
    if (status === "failed") {
      gatewayStore.setAdapterSmokeProbe({
        ...smokeRunner(),
        runSmoke: async () => { throw new Error("Fixture Harness probe failed"); }
      });
      expect((await gatewayStore.testHarness(gateway.id, "fixture-b", "fixture-model")).status).toBe("failed");
    } else if (status === "stale") {
      const runner = smokeRunner();
      const identity: AdapterSmokeProbeRunner["cacheKey"] = async (input) => ({
        ...await runner.cacheKey(input), cacheKey: "replacement-cache", executableFingerprint: "replacement-executable"
      });
      gatewayStore.setAdapterSmokeProbe({ ...runner, cacheKey: identity, runSmoke: identity });
    }
    const selected = { harness: "fixture-b", gatewayId: gateway.id, model: "fixture-model" };
    await expect(explainer.updateDraftConfig(selected)).resolves.toMatchObject({
      available: true, validationWarning: expect.stringContaining("仍可使用")
    });
    await expect(explainer.updateConfig(projectId, selected)).resolves.toMatchObject({
      available: true, validationWarning: expect.stringContaining("尚未通过验证")
    });
    const before = await explainer.getRecommendationConfig();
    await expect(explainer.generateRecommendation({ instructions: "Return JSON", evidence: {}, configurationFingerprint: before.fingerprint }, new AbortController().signal))
      .resolves.toMatchObject({ answer: "项目回答。" });
    await explainer.ask(projectId, "直接尝试问答", () => undefined, new AbortController().signal);
    expect(calls).toHaveLength(2);
    gatewayStore.setAdapterSmokeProbe(smokeRunner());
    await gatewayStore.testHarness(gateway.id, "fixture-b", "fixture-model");
    const verified = await explainer.getRecommendationConfig();
    expect(verified.config.available).toBe(true);
    expect(verified.config.validationWarning).toBeUndefined();
    expect(verified.fingerprint).toBe(before.fingerprint);
  });

  it("reports an actual recommendation failure after attempting an untested combination", async () => {
    const run = vi.fn(async () => { throw new Error("Fixture upstream unavailable"); });
    const { explainer, gateway, gatewayStore } = await setup(run);
    await gatewayStore.update(gateway.id, (await gatewayStore.get(gateway.id))!);
    await explainer.updateDraftConfig({ harness: "fixture-a", gatewayId: gateway.id, model: "fixture-model" });
    await expect(explainer.generateRecommendation({ instructions: "Return JSON", evidence: {} }, new AbortController().signal)).rejects.toThrow("Fixture upstream unavailable");
    expect(run).toHaveBeenCalledOnce();
  });

  it("migrates a saved non-selectable explainer selection and discards its session", async () => {
    const hiddenDescriptor: HarnessDescriptor = {
      ...descriptors[1]!,
      id: "claude-code",
      label: "Claude Code",
      userSelectable: false
    };
    const { explainer, projectId, gateway, storage } = await setup(
      undefined,
      [...descriptors, hiddenDescriptor]
    );
    const directory = path.join(storage.projectDir(projectId), "runtime", "explainer");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({
      schemaVersion: 2,
      harness: "fixture-legacy",
      gatewayId: gateway.id,
      model: "fixture-model",
      reasoningEffort: "low",
      revision: 3,
      updatedAt: "2026-09-16T00:00:00.000Z"
    }), "utf8");
    await fs.writeFile(path.join(directory, "session.json"), "old legacy session", "utf8");

    await expect(explainer.getConfig(projectId)).resolves.toMatchObject({
      harness: "fixture-a",
      revision: 4,
      available: true
    });
    expect(JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf8")))
      .toMatchObject({ harness: "fixture-a", revision: 4 });
    await expect(fs.access(path.join(directory, "session.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the Catalog default selected when unavailable and an unselectable Harness is present", async () => {
    const { projectId, storage } = await setup();
    const catalog = [
      { ...descriptors[0]!, id: "codex", label: "Codex", default: true, available: false },
      { ...descriptors[1]!, id: "claude-code", label: "Claude Code", userSelectable: false, available: true },
      { ...descriptors[1]!, available: true }
    ];
    const runtime: ProjectExplainerRuntime = {
      harnessCatalog: async () => catalog,
      assertExplainerAvailable: () => undefined,
      runExplainer: async () => { throw new Error("not called"); }
    };
    const explainer = new ProjectExplainerService(runtime, storage, { model: "fixture-model" });

    await expect(explainer.getConfig(projectId)).resolves.toMatchObject({
      harness: "codex",
      available: false
    });
  });

  it("delegates read-only execution to the Facade and persists canonical tool/answer history", async () => {
    const { explainer, projectId, calls } = await setup();
    const events: ProjectExplainerEvent[] = [];
    await explainer.ask(
      projectId,
      "当前证据是什么？",
      (event) => { events.push(event); },
      new AbortController().signal
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      harnessId: "fixture-a",
      model: "fixture-model",
      reasoningEffort: "high"
    });
    expect(calls[0]?.prompt).toContain("Never modify files, run shell commands, use Skills, business MCP or Web Search");
    expect(calls[0]?.prompt).toContain("Use read_context or the injected read-only file tools");
    expect(calls[0]?.workspacePath).toContain(`${path.sep}readonly-`);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool", itemId: "read-1", phase: "started" }),
      expect.objectContaining({ kind: "tool_output", itemId: "read-1", text: "fixture evidence" }),
      expect.objectContaining({ kind: "assistant", text: "项目回答。", phase: "completed" }),
      expect.objectContaining({ kind: "status", text: "回答完成" })
    ]));
    expect((await explainer.history(projectId)).events.some((event) => event.kind === "reasoning"))
      .toBe(false);

    await explainer.ask(projectId, "继续。", () => undefined, new AbortController().signal);
    expect(calls[1]?.session).toMatchObject({
      harnessId: "fixture-a",
      nativeId: "fixture-a-native-0",
      durable: true
    });
    expect((await explainer.history(projectId)).events.filter((event) => event.kind === "user"))
      .toHaveLength(2);
  });

  it("rejects concurrent turns and cancellation waits for the active Facade call", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const runExplainer = vi.fn(async (
      _input: ExplainerInvocationRequest,
      signal: AbortSignal
    ) => {
      started();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    });
    const { explainer, projectId } = await setup(runExplainer);
    const turn = explainer.ask(projectId, "等待取消。", () => undefined, new AbortController().signal);
    await running;
    expect(explainer.isActive(projectId)).toBe(true);
    await expect(explainer.ask(
      projectId,
      "不能并发。",
      () => undefined,
      new AbortController().signal
    )).rejects.toBeInstanceOf(ProjectExplainerBusyError);
    await expect(explainer.reset(projectId)).rejects.toBeInstanceOf(ProjectExplainerBusyError);
    await explainer.cancel(projectId);
    await expect(turn).resolves.toBeUndefined();
    expect(explainer.isActive(projectId)).toBe(false);
    await expect(explainer.history(projectId)).resolves.toMatchObject({
      active: false,
      events: expect.arrayContaining([
        expect.objectContaining({ kind: "status", text: "解说已停止。" })
      ])
    });
  });

  it("cancels an active turn for every runtime-affecting config change and blocks stale Session writes", async () => {
    let started!: () => void;
    let release!: () => void;
    let activeSignal: AbortSignal | undefined;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const runExplainer = vi.fn(async (
      input: ExplainerInvocationRequest,
      signal: AbortSignal
    ) => {
      activeSignal = signal;
      started();
      await blocked;
      return {
        answer: "不得落盘的旧配置回答",
        session: {
          schemaVersion: 1 as const,
          harnessId: input.harnessId,
          adapterVersion: "1",
          generation: 0,
          nativeId: "stale-native-session",
          durable: true,
          createdAt: "2026-09-16T00:00:00.000Z"
        }
      };
    });
    const { explainer, projectId, gateway, storage } = await setup(runExplainer);
    const turn = explainer.ask(projectId, "等待配置变化。", () => undefined, new AbortController().signal);
    await running;

    const update = explainer.updateConfig(projectId, {
      harness: "fixture-a",
      gatewayId: gateway.id,
      model: "fixture-model",
      reasoningEffort: "low"
    });
    await vi.waitFor(() => expect(activeSignal?.aborted).toBe(true));
    release();
    await expect(Promise.all([turn, update])).resolves.toBeDefined();
    await expect(explainer.getConfig(projectId)).resolves.toMatchObject({
      reasoningEffort: "low",
      revision: 1
    });
    await expect(fs.readFile(
      path.join(storage.projectDir(projectId), "runtime", "explainer", "session.json"),
      "utf8"
    )).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify((await explainer.history(projectId)).events))
      .not.toContain("不得落盘的旧配置回答");
  });

  it("removes legacy reasoning and thinking bodies from the history API", async () => {
    const { explainer, projectId, storage } = await setup();
    const historyPath = path.join(
      storage.projectDir(projectId),
      "runtime",
      "explainer",
      "history.jsonl"
    );
    await fs.mkdir(path.dirname(historyPath), { recursive: true });
    const base = {
      projectId,
      turnId: "legacy-turn",
      ts: "2026-09-16T00:00:00.000Z",
      phase: "completed" as const
    };
    await fs.writeFile(historyPath, [
      JSON.stringify({ ...base, id: "legacy-reasoning", kind: "reasoning", text: "SECRET_REASONING_BODY" }),
      JSON.stringify({
        ...base,
        id: "legacy-thinking",
        kind: "assistant",
        text: "SECRET_THINKING_BODY",
        data: { canonicalEvent: { sourceType: "thinking_delta", message: "SECRET_NESTED_BODY" } }
      }),
      JSON.stringify({ ...base, id: "safe-answer", kind: "assistant", text: "可见回答" })
    ].join("\n") + "\n", "utf8");

    const history = await explainer.history(projectId);
    expect(history.events).toEqual([
      expect.objectContaining({ id: "safe-answer", text: "可见回答" })
    ]);
    expect(JSON.stringify(history.events)).not.toMatch(/SECRET_(?:REASONING|THINKING|NESTED)_BODY/);
  });

  it("archives product history and native Session atomically on reset", async () => {
    const { explainer, projectId, storage } = await setup();
    await explainer.ask(projectId, "生成历史。", () => undefined, new AbortController().signal);
    await explainer.reset(projectId);
    await expect(explainer.history(projectId)).resolves.toEqual({ events: [], active: false });
    const resetRoot = path.join(storage.projectDir(projectId), "runtime", "explainer", "resets");
    const archives = await fs.readdir(resetRoot);
    expect(archives).toHaveLength(1);
    expect(await fs.readdir(path.join(resetRoot, archives[0]!))).toEqual([
      "history.jsonl",
      "session.json"
    ]);
  });
});
