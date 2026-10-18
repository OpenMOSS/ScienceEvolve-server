import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SharedProjectExplainerService,
  type ProjectExplainerBaseConfig,
  type ProjectExplainerConfigChange,
  type ProjectExplainerCoreHost,
  type ProjectExplainerEvent
} from "../src/internal/shared/project-explainer.js";

interface Config extends ProjectExplainerBaseConfig { selector: string }
interface ConfigInput extends ProjectExplainerConfigChange { selector: string; model: string }
interface Session { id: string }
interface Route { id: string }

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shared-explainer-"));
  roots.push(root);
  const projectPath = path.join(root, "project");
  const workspacePath = path.join(projectPath, "workspaces");
  const runtimePath = path.join(projectPath, "runtime", "explainer");
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(runtimePath, { recursive: true });
  await fs.writeFile(path.join(workspacePath, "evidence.md"), "verified evidence", "utf8");
  let config: Config = {
    schemaVersion: 2,
    harness: "fixture-a",
    selector: "route-a",
    nativeProtocol: "responses",
    gatewayProtocol: "responses",
    model: "fixture-model",
    reasoningEffort: "high",
    revision: 0,
    updatedAt: new Date().toISOString(),
    available: true,
    routeMode: "direct"
  };
  let session: Session | undefined;
  const invocations: Array<{ session?: Session; inbox: string; prompt: string; mode: number; selectedEvidence: string; priorMessages: number; selectedPriorMessage?: string; fileIndex: Array<{ path: string; bytes?: number }> }> = [];
  const progress = vi.fn(async () => true);
  const host: ProjectExplainerCoreHost<Config, ConfigInput, Route, Session> = {
    project: async () => ({ projectPath, workspacePath, runtimePath, evidence: { status: "running", overallProgress: { percent: 10 } } }),
    getConfig: async () => structuredClone(config),
    proposeConfig: async (_id, current, input) => ({
      ...current,
      harness: input.harness,
      selector: input.selector,
      model: input.model,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString()
    }),
    saveConfig: async (_id, next) => { config = structuredClone(next); },
    configFingerprint: (value) => JSON.stringify([value.harness, value.selector, value.model, value.reasoningEffort]),
    resolveRoute: async (_id, value) => ({ id: value.selector }),
    routeStatus: (route, value) => ({ harness: value.harness, gatewaySource: route.id }),
    run: async (input) => {
      const inbox = await fs.readFile(input.inboxPath, "utf8");
      const indexPath = inbox.match(/Context index: (.+)/)![1];
      const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
      const directory = index.baseDirectory;
      const filesSource = index.entries.find((entry: any) => entry.key === "explainer.workspace-files");
      const list = JSON.parse(await fs.readFile(path.join(directory, filesSource.list.path), "utf8"));
      const file = list.entries.find((entry: any) => entry.path === "evidence.md");
      const selectedEvidence = await fs.readFile(path.join(input.workspacePath, file.path), "utf8");
      const historySource = index.entries.find((entry: any) => entry.key === "explainer.conversation");
      const history = historySource ? JSON.parse(await fs.readFile(path.join(directory, historySource.list.path), "utf8")) : undefined;
      const selectedPriorMessage = history?.entries[0] ? JSON.parse(await fs.readFile(path.join(directory, history.entries[0].detail.path), "utf8")).text : undefined;
      invocations.push({ session: input.session, inbox, prompt: input.prompt, selectedEvidence,
        priorMessages: history?.total ?? 0, selectedPriorMessage, fileIndex: list.entries,
        mode: (await fs.stat(input.workspacePath)).mode & 0o777 });
      await input.onEvent({
        eventId: "hidden",
        kind: "assistant.message",
        message: "hidden reasoning",
        sourceType: "thinking_delta"
      } as Parameters<typeof input.onEvent>[0] & { sourceType: string });
      await input.onEvent({ eventId: "answer", kind: "assistant.message", message: "Evidence answer" });
      return { answer: "Evidence answer\n进度建议：20%｜依据：verified completed workspace evidence", session: { id: "session-1" } };
    },
    readSession: async () => session,
    writeSession: async (_id, _config, next) => { session = structuredClone(next); },
    sessionPath: () => path.join(runtimePath, "session.json")
  };
  // A stale host hook and model suggestion must never mutate workflow progress.
  Object.assign(host, { reportProgress: progress });
  return { service: new SharedProjectExplainerService(host), host, invocations, progress, getConfig: () => config };
}

describe("shared Project Explainer core", () => {
  it("does not build project evidence or trigger context organization when polling chat history", async () => {
    const { service, host, invocations } = await setup();
    const project = await host.project("project");
    const calls = vi.spyOn(host, "project").mockImplementation(async (_id, options) => {
      expect(options).toEqual({ includeEvidence: false }); return { ...project, evidence: {} };
    });
    try {
      await service.history("project"); await service.history("project");
      expect(calls).toHaveBeenCalledTimes(2); expect(invocations).toHaveLength(0);
    } finally { calls.mockRestore(); }
  });
  it("reads only the requested history tail across UTF-8 boundaries and corrupt rows", async () => {
    const { service, host } = await setup();
    const project = await host.project("project");
    const file = path.join(project.runtimePath, "history.jsonl");
    const base = { projectId: "project", turnId: "turn", ts: "2026-10-17T00:00:00Z", phase: "completed" };
    const text = "跨块🙂".repeat(4_000);
    await fs.writeFile(file, [
      JSON.stringify({ ...base, id: "hidden", kind: "reasoning", text: "x".repeat(2_000_000) }),
      JSON.stringify({ ...base, id: "one", kind: "assistant", text }),
      JSON.stringify({ ...base, id: "two", kind: "assistant", text }), "{partial-row"
    ].join("\r\n"));
    let bytesRead = 0;
    const open = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === file) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async (...input: any[]) => {
          const result = await (read as any)(...input); bytesRead += result.bytesRead; return result;
        });
      }
      return handle;
    });
    const readFileSpy = vi.spyOn(fs, "readFile");
    try {
      const history = await service.history("project", 2);
      expect(history.events.map(event => event.id)).toEqual(["one", "two"]);
      expect(history.events.map(event => event.text)).toEqual([text, text]);
      expect(bytesRead).toBeGreaterThan(0);
      expect(bytesRead).toBeLessThan(256 * 1024);
      expect(readFileSpy.mock.calls.some(call => String(call[0]) === file)).toBe(false);
    } finally { openSpy.mockRestore(); readFileSpy.mockRestore(); }
  });

  it("lists all workspace file paths, including late, large and binary files, without injecting their contents", async () => {
    const { service, host, invocations } = await setup();
    const project = await host.project("project");
    await Promise.all(Array.from({ length: 251 }, (_, index) => fs.writeFile(path.join(project.workspacePath, `source-${String(index).padStart(3, "0")}.txt`), `PRIVATE_FILE_CONTENT_${index}`)));
    await fs.writeFile(path.join(project.workspacePath, "large.log"), "PRIVATE_LARGE_DETAIL".repeat(4000));
    await fs.writeFile(path.join(project.workspacePath, "binary.bin"), Buffer.from([0, 255, 1, 2]));
    await service.ask("project", "Choose one relevant file", () => undefined, new AbortController().signal);
    const invocation = invocations[0]!;
    expect(invocation.fileIndex).toHaveLength(254);
    expect(invocation.fileIndex.some(entry => entry.path === "source-250.txt")).toBe(true);
    expect(invocation.fileIndex.find(entry => entry.path === "large.log")?.bytes).toBeGreaterThan(48_000);
    expect(invocation.fileIndex.some(entry => entry.path === "binary.bin")).toBe(true);
    expect(invocation.inbox).not.toContain("PRIVATE_"); expect(invocation.prompt).not.toContain("PRIVATE_");
  });

  it("shows one recovery status for malformed arguments and preserves the successful answer without diagnostic concatenation", async () => {
    const { service, host } = await setup();
    host.run = async input => {
      const diagnostic = { diagnostic: true, diagnosticSource: "proxy", errorCode: "PROTOCOL_TOOL_ARGUMENTS_INVALID" };
      await input.onTrace("stderr", "Protocol proxy rejected malformed tool arguments", diagnostic);
      for (let index = 0; index < 5; index += 1) await input.onTrace("stderr", "Protocol proxy quarantined a request after malformed tool arguments", diagnostic);
      await input.onTrace("status", "Explainer received invalid tool arguments; retrying once", { ...diagnostic, automaticRecovery: true });
      return { answer: "配置已保存，请先查看草稿。", session: { id: "replacement-session" } };
    };
    const events: ProjectExplainerEvent[] = [];
    await service.ask("project", "保存草稿", event => { events.push(event); }, new AbortController().signal);
    expect(events.some(event => event.kind === "error")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("quarantined");
    expect(events.find(event => event.kind === "assistant")!.text).toBe("配置已保存，请先查看草稿。");
    const history = await service.history("project");
    const recovery = history.events.filter(event => event.data?.automaticRecovery);
    expect(recovery).toHaveLength(1);
    expect(recovery[0]!.text).toBe("工具参数格式有误，正在自动恢复（1/1）…");
  });

  it("reports exhausted malformed-argument recovery in plain language while preserving conversation history", async () => {
    const { service, host } = await setup();
    host.run = async () => { throw Object.assign(new Error("provider raw invalid JSON"), { code: "PROTOCOL_RECOVERY_EXHAUSTED" }); };
    const events: ProjectExplainerEvent[] = [];
    await service.ask("project", "保存配置", event => { events.push(event); }, new AbortController().signal);
    expect(events.find(event => event.kind === "error")!.text).toContain("自动恢复后仍未成功");
    expect((await service.history("project")).events.some(event => event.kind === "user" && event.text === "保存配置")).toBe(true);
  });

  it("streams tool lifecycles and explicit public summaries, persists them, and excludes private reasoning", async () => {
    const { service, host } = await setup();
    host.run = async input => {
      await input.onEvent({ eventId: "private", kind: "assistant.message", message: "RAW_PRIVATE_THOUGHT",
        sourceType: "thinking_delta" } as Parameters<typeof input.onEvent>[0] & { sourceType: string });
      await input.onEvent({ eventId: "summary-a", itemId: "summary-1", kind: "reasoning.summary", phase: "delta", message: "先读取配置，" });
      await input.onEvent({ eventId: "summary-b", itemId: "summary-1", kind: "reasoning.summary", phase: "delta", message: "再检查协作关系。" });
      await input.onEvent({ eventId: "tool-a", kind: "tool.started", tool: { callId: "tool-1", name: "get_context" } });
      await input.onEvent({ eventId: "tool-b", kind: "tool.updated", tool: { callId: "tool-1", name: "get_context" } });
      await input.onEvent({ eventId: "tool-c", kind: "tool.failed", tool: { callId: "tool-1", name: "get_context", outputPreview: "读取失败" } });
      return { answer: "请重试读取配置。", session: { id: "session-1" } };
    };
    const events: ProjectExplainerEvent[] = [];
    await service.ask("project", "检查配置", event => { events.push(event); }, new AbortController().signal);
    expect(events.filter(event => event.kind === "tool").map(event => event.phase)).toEqual(["started", "delta", "completed"]);
    expect(events.find(event => event.kind === "tool_output")?.text).toBe("读取失败");
    expect(events.filter(event => event.kind === "reasoning").map(event => event.itemId)).toEqual(["summary-1", "summary-1"]);
    expect(JSON.stringify(events)).not.toContain("RAW_PRIVATE_THOUGHT");
    const history = await service.history("project");
    expect(history.events.find(event => event.kind === "reasoning")?.text).toBe("先读取配置，再检查协作关系。");
    expect(history.events.some(event => event.kind === "tool_output")).toBe(true);
    expect(JSON.stringify(history)).not.toContain("RAW_PRIVATE_THOUGHT");
  });

  it("publishes partial text immediately and preserves segment identity through tools, completion and persisted history", async () => {
    const { service, host } = await setup();
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    host.run = async input => {
      await input.onEvent({ eventId: "delta-1", itemId: "assistant-0-0", kind: "assistant.delta", message: "Evidence " });
      await input.onEvent({ eventId: "delta-2", itemId: "assistant-0-0", kind: "assistant.delta", message: "answer" });
      await paused;
      await input.onEvent({ eventId: "tool-start", kind: "tool.started", tool: { callId: "read-1", name: "read" } });
      await input.onEvent({ eventId: "complete-1", itemId: "assistant-0-0", kind: "assistant.message", message: "Evidence answer" });
      await input.onEvent({ eventId: "tool-end", kind: "tool.completed", tool: { callId: "read-1", name: "read", outputPreview: "verified" } });
      await input.onEvent({ eventId: "complete-2", itemId: "assistant-0-1", kind: "assistant.message", message: "Evidence answer" });
      return { answer: "Evidence answer", session: { id: "session-1" } };
    };
    const events: ProjectExplainerEvent[] = [];
    const pending = service.ask("project", "Explain this evidence", event => { events.push(event); }, new AbortController().signal);
    try {
      await vi.waitFor(() => expect(events.filter(event => event.kind === "assistant")).toHaveLength(2));
      expect(service.isActive("project")).toBe(true);
      expect(events.filter(event => event.kind === "assistant").map(event => [event.text, event.phase, event.itemId]))
        .toEqual([["Evidence ", "delta", "assistant-0-0"], ["answer", "delta", "assistant-0-0"]]);
      expect(events.some(event => event.data?.turnComplete)).toBe(false);
    } finally {
      release();
      await pending;
    }
    expect(events.filter(event => event.kind === "assistant").map(event => event.itemId))
      .toEqual(["assistant-0-0", "assistant-0-0", "assistant-0-0", "assistant-0-1"]);
    const history = await service.history("project");
    expect(history.events.filter(event => event.kind === "assistant").map(event => [event.text, event.phase, event.itemId]))
      .toEqual([["Evidence answer", "delta", "assistant-0-0"], ["Evidence answer", "completed", "assistant-0-0"], ["Evidence answer", "completed", "assistant-0-1"]]);
  });

  it("publishes completion only after the history is persisted and the next turn is available", async () => {
    const { service } = await setup();
    let complete = false;
    await service.ask("project", "Check completion", async event => {
      if (!event.data?.turnComplete) return;
      complete = true;
      expect(service.isActive("project")).toBe(false);
      const history = await service.history("project");
      expect(history.events.some(item => item.kind === "user" && item.text === "Check completion")).toBe(true);
      expect(history.events.some(item => item.data?.turnComplete)).toBe(true);
    }, new AbortController().signal);
    expect(complete).toBe(true);
  });
  it("uses a read-only evidence snapshot, persists safe history, and resumes only its own Session", async () => {
    const { service, invocations, progress } = await setup();
    const events: string[] = [];
    await service.ask("project", "What is complete?", (event) => { events.push(`${event.kind}:${event.text}`); }, new AbortController().signal);
    await service.ask("project", "Continue", () => undefined, new AbortController().signal);

    if (process.platform !== "win32") expect(invocations[0]?.mode).toBe(0o500);
    expect(invocations[0]?.inbox).not.toContain("verified evidence");
    expect(invocations[0]?.selectedEvidence).toBe("verified evidence");
    expect(invocations[0]?.inbox).toContain("What is complete?");
    expect(invocations[0]?.session).toBeUndefined();
    expect(invocations[1]?.session).toEqual({ id: "session-1" });
    expect(invocations[1]?.inbox).not.toContain("What is complete?");
    expect(invocations[1]?.priorMessages).toBeGreaterThanOrEqual(2);
    expect(invocations[1]?.selectedPriorMessage).toBe("What is complete?");
    expect(progress).not.toHaveBeenCalled();
    expect(invocations[0]?.prompt).toContain("do not propose or claim changes to it");
    expect(events.some((event) => event.includes("项目总进度已更新"))).toBe(false);
    expect(events).toContain("assistant:Evidence answer");
    const history = await service.history("project");
    expect(history.events.some((event) => event.kind === "reasoning")).toBe(false);
    expect(JSON.stringify(history.events)).not.toContain("hidden reasoning");
    expect(JSON.stringify(history.events)).not.toContain("apiKey");
  });

  it("rebuilds the native Session when the host route or Harness changes", async () => {
    const { service, getConfig } = await setup();
    await service.updateConfig("project", {
      harness: "fixture-b",
      selector: "route-b",
      model: "next-model",
      confirmHarnessSwitch: true
    });
    expect(getConfig()).toMatchObject({ harness: "fixture-b", selector: "route-b", model: "next-model", revision: 1 });
    expect((await service.history("project")).events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "status", text: "已切换 harness，历史记录可按需读取" })
    ]));
  });

  it("keeps the native Session and history when the user saves unchanged settings", async () => {
    const { service, getConfig, invocations } = await setup();
    await service.ask("project", "Start this conversation", () => undefined, new AbortController().signal);
    const before = await service.history("project");
    await service.updateConfig("project", { harness: "fixture-a", selector: "route-a", model: "fixture-model" });
    expect(getConfig().revision).toBe(0); expect(await service.history("project")).toEqual(before);
    await service.ask("project", "Continue this conversation", () => undefined, new AbortController().signal);
    expect(invocations[1].session).toEqual({ id: "session-1" });
  });
});
