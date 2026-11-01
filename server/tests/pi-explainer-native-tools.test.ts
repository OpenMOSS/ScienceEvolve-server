import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { openExplainerAssistantMcp } from "../src/explainer-assistant-mcp.js";
import type { ExplainerAssistantStore } from "../src/explainer-assistant.js";
import { HarnessRuntimeFacade } from "../src/harness-runtime/runtime.js";
import { startProtocolProxy } from "../src/protocol-router.js";
import { explainerToolNames } from "../src/internal/shared/explainer-tools.js";

const executable = path.resolve("../harness/pi/node_modules/.bin/pi");

it.runIf(existsSync(executable))(
  "lets installed Pi execute Explainer MCP draft tools while keeping native tools disabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-pi-explainer-tools-"));
    const projectId = `prj_${"a".repeat(32)}`;
    const projectPath = path.join(root, projectId);
    const runtimePath = path.join(projectPath, "runtime", "explainer");
    const workspacePath = path.join(runtimePath, "workspaces");
    await fs.mkdir(workspacePath, { recursive: true });
    const inboxPath = path.join(workspacePath, "inv_pi_native_draft_tools.md");
    const memoryPath = path.join(workspacePath, "Memory.md");
    await fs.writeFile(inboxPath, "Create an isolated test draft through the provided MCP tools.");
    await fs.writeFile(memoryPath, "Synthetic test only.");
    const calls: string[] = [];
    const advertisedTools: string[][] = [];
    const controller = new AbortController();
    const store = {
      host: {},
      async get() { return { id: projectId }; },
      availableToolNames() { return explainerToolNames({ startProjects: false, submitWorkflow: false }); },
      async call(_id: string, name: string, args: Record<string, unknown>) {
        calls.push(name);
        if (name === "get_context") return { result: { revision: 0 } };
        expect(args.expectedRevision).toBe(calls.length - 2);
        if (name === "delete_drafts") {
          await fs.rm(path.join(root, "draft.json"));
          return { result: { deletedTasks: [{ id: `task_${"b".repeat(32)}` }] } };
        }
        if (!["create_draft", "update_saved_draft"].includes(name)) throw new Error("Unexpected test tool");
        await fs.writeFile(path.join(root, "draft.json"), JSON.stringify(args.patch));
        return { result: { savedTask: { id: `task_${"b".repeat(32)}`, title: "Isolated draft", updatedAt: "2026-10-29T00:00:00Z" } } };
      }
    } as unknown as ExplainerAssistantStore;
    const mcp = await openExplainerAssistantMcp(store, projectId, controller.signal, async () => undefined);
    const answer = "The isolated test draft was created, updated and deleted through MCP.";
    let requests = 0;
    const runtime = new HarnessRuntimeFacade({
      harnessExecutables: { pi: executable },
      protocolProxyFactory: options => startProtocolProxy({
        ...options,
        validateGatewayTarget: async () => undefined,
        modelFetch: async (_url, init) => {
          requests++;
          const body = JSON.parse(String(init.body));
          const names = (body.tools ?? []).map((tool: { name: string }) => tool.name);
          advertisedTools.push(names);
          const contextTool = names.find((name: string) => name.endsWith("__get_context"));
          const draftTool = names.find((name: string) => name.endsWith("__create_draft"));
          const editTool = names.find((name: string) => name.endsWith("__update_saved_draft"));
          const deleteTool = names.find((name: string) => name.endsWith("__delete_drafts"));
          const frames: Record<string, unknown>[] = [];
          // An unavailable MCP catalog reproduces the original empty Pi turn.
          if (contextTool && draftTool && editTool && deleteTool && requests <= 4) {
            const tool = [contextTool, draftTool, editTool, deleteTool][requests - 1];
            const selected = { taskId: `task_${"b".repeat(32)}`, expectedUpdatedAt: "2026-10-29T00:00:00Z" };
            const args = requests === 1 ? {} : requests === 2 ? { expectedRevision: 0,
              operationId: "isolated-native-draft", patch: { title: "Isolated draft" } }
              : requests === 3 ? { expectedRevision: 1, operationId: "isolated-native-update", ...selected, patch: { title: "Edited draft" } }
              : { expectedRevision: 2, operationId: "isolated-native-delete", tasks: [selected] };
            const item = { id: `fc-${requests}`, call_id: `call-${requests}`,
              type: "function_call", name: tool, arguments: JSON.stringify(args) };
            frames.push({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
              { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments },
              { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments },
              { type: "response.output_item.done", output_index: 0, item });
          } else if (contextTool && draftTool && editTool && deleteTool) {
            frames.push({ type: "response.output_text.delta", delta: answer });
          }
          frames.push({ type: "response.completed", response: { id: `resp-${requests}`, status: "completed",
            usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
          return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" }
          });
        }
      })
    });
    try {
      const result = await runtime.runExplainer({
        invocationId: "inv_pi_native_draft_tools", projectId, projectPath, runtimePath,
        workspacePath, inboxPath, memoryPath, harnessId: "pi", model: "fixture-model",
        gateway: { id: `gwy_${"c".repeat(32)}`, name: "Synthetic fixture", url: "https://gateway.invalid/v1",
          apiKey: "fixture-only", protocol: "responses", models: ["fixture-model"], defaultModel: "fixture-model" },
        reasoningEffort: "low", prompt: "Read context, create the isolated draft through MCP, and report the result.",
        assistantMcp: { url: mcp.url }, onTrace: () => undefined, onEvent: () => undefined
      }, controller.signal);
      expect(result.answer).toBe(answer);
      expect(calls).toEqual(["get_context", "create_draft", "update_saved_draft", "delete_drafts"]);
      await expect(fs.access(path.join(root, "draft.json"))).rejects.toThrow();
      expect(requests).toBe(5);
      for (const names of advertisedTools) {
        expect(names.some(name => name.endsWith("__create_draft"))).toBe(true);
        expect(names.some(name => name.endsWith("__delete_drafts"))).toBe(true);
        expect(names.every(name => name.startsWith("mcp__openfars-project-explainer__"))).toBe(true);
      }
    } finally {
      controller.abort();
      await mcp.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000
);
