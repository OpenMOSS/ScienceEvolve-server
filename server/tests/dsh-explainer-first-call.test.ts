import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ExplainerAssistantStore } from "../src/explainer-assistant.js";
import { openExplainerAssistantMcp } from "../src/explainer-assistant-mcp.js";
import { SavedResearchTaskStore } from "../src/saved-research-tasks.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { HarnessRuntimeFacade } from "../src/harness-runtime/runtime.js";
import { startProtocolProxy } from "../src/protocol-router.js";

const executable = path.resolve("../harness/dsh/node_modules/.bin/dsh");

it.runIf(existsSync(executable))("lets installed DSH query the schema and create different rosters on their first MCP calls", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-dsh-first-call-"));
  const tasks = new SavedResearchTaskStore(root);
  const gateway = { id: `gwy_${"c".repeat(32)}`, name: "Synthetic fixture", url: "https://gateway.invalid/v1", apiKey: "fixture-only",
    protocol: "responses" as const, models: ["fixture-model"], defaultModel: "fixture-model" };
  const store = new ExplainerAssistantStore(root, { tasks, skills: new SkillCatalog([]), project: async () => undefined,
    catalog: async () => ({ availableRoutes: [{ harness: "dsh", gatewayId: gateway.id, model: gateway.defaultModel }] }) });
  const context = await store.create();
  const graph = { ...context.draft.orchestration,
    agents: [{ name: "main", template: "main" }, { name: "coder", template: "execution" }, { name: "auditor", template: "review" }],
    input: { source: "input", target: "coder" },
    routes: { main: [{ target: "coder", kind: "weak" }, { target: "auditor", kind: "weak" }],
      coder: [{ target: "auditor", kind: "strong" }], auditor: [{ target: "finish", kind: "strong" }] },
    decisionPlans: { main: "Coordinate", coder: "Implement", auditor: "Verify" },
    termination: { ...context.draft.orchestration.termination, agent: "auditor" } };
  const patch = { title: "First-call roster", requirement: "Implement and verify the supplied public task", orchestration: graph,
    agents: { coder: context.draft.agents!.execution, auditor: context.draft.agents!.review } };
  const projectPath = store.directory(context.id), runtimePath = path.join(projectPath, "runtime", "explainer"), workspacePath = path.join(runtimePath, "workspaces");
  await fs.mkdir(workspacePath, { recursive: true });
  const inboxPath = path.join(workspacePath, "inv_dsh_first_call.md"), memoryPath = path.join(workspacePath, "Memory.md");
  await fs.writeFile(inboxPath, "Read the selected schema and create two isolated drafts through MCP.");
  await fs.writeFile(memoryPath, "Isolated regression test.");
  const controller = new AbortController(), errors: string[] = [], actions: string[] = [];
  const mcp = await openExplainerAssistantMcp(store, context.id, controller.signal, async action => { actions.push(action.kind); });
  let requests = 0;
  const runtime = new HarnessRuntimeFacade({ harnessExecutables: { dsh: executable },
    protocolProxyFactory: options => startProtocolProxy({ ...options, validateGatewayTarget: async () => undefined,
      modelFetch: async (_url, init) => {
        requests++;
        const body = JSON.parse(String(init.body));
        const names = (body.tools ?? []).map((tool: { name: string }) => tool.name);
        const read = names.find((name: string) => name.endsWith("__get_context"));
        const create = names.find((name: string) => name.endsWith("__create_draft"));
        expect(read).toBeTruthy(); expect(create).toBeTruthy();
        const frames: Record<string, unknown>[] = [];
        if (requests <= 3) {
          const args = requests === 1 ? { section: "schema", key: "orchestration", entry: "termination" }
            : { expectedRevision: requests - 2, operationId: `native-first-call-${requests}`,
              patch: requests === 2 ? patch : JSON.stringify({ ...patch, title: "Encoded roster" }) };
          const item = { id: `fc-${requests}`, call_id: `call-${requests}`, type: "function_call", name: requests === 1 ? read : create, arguments: JSON.stringify(args) };
          frames.push({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
            { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments },
            { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments },
            { type: "response.output_item.done", output_index: 0, item });
        } else frames.push({ type: "response.output_text.delta", delta: "Both drafts were created on their first calls." });
        frames.push({ type: "response.completed", response: { id: `resp-${requests}`, status: "completed", usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
        return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      } }) });
  try {
    const result = await runtime.runExplainer({ invocationId: "inv_dsh_first_call", projectId: context.id, projectPath, runtimePath, workspacePath, inboxPath, memoryPath,
      harnessId: "dsh", gateway, model: gateway.defaultModel, reasoningEffort: "low", assistantMcp: { url: mcp.url },
      prompt: "Read the selected contract, create two isolated drafts and report the result.", onTrace: () => undefined,
      onEvent: event => { if (event.tool?.isError || event.tool?.status === "failed") errors.push(event.tool.outputPreview ?? event.tool.name); } }, controller.signal);
    expect(result.answer).toBe("Both drafts were created on their first calls.");
    expect(errors).toEqual([]); expect(actions).toEqual(["draft.created", "draft.created"]);
    expect(requests).toBe(4);
    const saved = await tasks.list(); expect(saved).toHaveLength(2);
    for (const task of saved) expect(Object.keys(task.agents).sort()).toEqual(["auditor", "coder", "main"]);
    expect((await store.get(context.id)).draft).toEqual(context.draft);
  } finally { controller.abort(); await mcp.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);
