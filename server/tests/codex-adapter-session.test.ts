import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRunRequest, ProjectState } from "../src/types.js";
import type { SessionRef } from "../src/harness-runtime/contracts.js";
import { HarnessRuntimeFacade } from "../src/harness-runtime/runtime.js";
import { BUILTIN_HARNESS_DESCRIPTORS } from "../src/harness-runtime/registry.js";

const roots: string[] = [];
const codexAdapterVersion = BUILTIN_HARNESS_DESCRIPTORS.find(
  (descriptor) => descriptor.id === "codex"
)!.adapterVersion;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

async function fakeCodex(
  root: string,
  mode: "valid" | "missing" | "resume-mismatch" | "starts-then-fails" | "malformed-hang"
): Promise<{ executable: string; capture: string; later: string }> {
  const executable = path.join(root, `fake-codex-${mode}.mjs`);
  const capture = path.join(root, `fake-codex-${mode}.jsonl`);
  const later = path.join(root, `fake-codex-${mode}-later.txt`);
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const resumed = args.includes("resume");
const requestedThread = resumed ? args.at(-2) : "";
const mode = ${JSON.stringify(mode)};
const emittedThread = mode === "resume-mismatch" && resumed
  ? "thread-unexpected"
  : "thread-official-replacement";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const lineValue = (prefix, suffix) => {
  const line = prompt.split("\\n").find((value) => value.startsWith(prefix));
  if (!line) return "";
  const value = line.slice(prefix.length);
  return suffix && value.endsWith(suffix)
    ? value.slice(0, -suffix.length)
    : value;
};
const inboxPath = lineValue("Read the invocation Inbox at ", ".");
const memoryPath = lineValue(
  "Read persistent project memory at ",
  " before acting."
) || lineValue(
  "Read persistent Agent memory at ",
  " before acting."
);
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({
  args,
  resumed,
  requestedThread,
  emittedThread: mode === "missing" ? null : emittedThread,
  prompt,
  inboxPath,
  memoryPath,
  inbox: fs.readFileSync(inboxPath, "utf8"),
  memory: fs.readFileSync(memoryPath, "utf8"),
  codexHome: process.env.CODEX_HOME ?? null,
  pid: process.pid
}) + "\\n");
if (mode !== "missing") {
  console.log(JSON.stringify({ type: "thread.started", thread_id: emittedThread }));
}
if (mode === "malformed-hang") {
  process.stdout.write('{"type":"turn.started" broken}\\n');
  setTimeout(() => {
    fs.writeFileSync(${JSON.stringify(later)}, "late output was reached\\n");
    console.log(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "must not be emitted" }
    }));
    console.log(JSON.stringify({ type: "turn.completed" }));
  }, 250);
  setTimeout(() => process.exit(0), 1000);
} else if (mode === "starts-then-fails") {
  console.log(JSON.stringify({ type: "turn.started" }));
  process.exitCode = 7;
} else {
  console.log(JSON.stringify({ type: "turn.started" }));
  console.log(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "Codex fixture complete." }
  }));
  console.log(JSON.stringify({ type: "turn.completed" }));
}
`,
    { encoding: "utf8", mode: 0o700 }
  );
  return { executable, capture, later };
}

async function durableRequest(
  root: string,
  invocationId: string,
  kind: "main" | "worker" = "main",
  agent = kind
): Promise<AgentRunRequest> {
  const projectId = kind === "main"
    ? `prj_${"c".repeat(32)}`
    : `prj_${"d".repeat(32)}`;
  const projectPath = path.join(root, projectId);
  const workspacePath = path.join(projectPath, "workspaces");
  const inboxPath = path.join(
    projectPath,
    "messages",
    `0001_${invocationId}_to_${agent}.md`
  );
  const runtimePath = path.join(projectPath, "runtime", invocationId);
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(path.dirname(inboxPath), { recursive: true }),
    fs.mkdir(runtimePath, { recursive: true })
  ]);
  await Promise.all([
    fs.writeFile(inboxPath, `${agent} authoritative inbox\n`, "utf8"),
    fs.writeFile(
      path.join(workspacePath, "Memory.md"),
      `${agent} persistent memory\n`,
      "utf8"
    )
  ]);
  const project = {
    id: projectId,
    agents: {
      [agent]: {
        model: "fixture-model",
        harness: "codex",
        gatewayId: "gwy_fixture",
        gatewaySnapshot: {
          id: "gwy_fixture",
          name: "Fixture Gateway",
          url: "https://gateway.example.test/v1",
          apiKey: "fixture-secret",
          models: ["fixture-model"],
          defaultModel: "fixture-model",
          protocol: "responses",
          nativeProtocol: "responses",
          routeMode: "direct"
        },
        skills: [],
        autoSkills: [],
        mcpServers: [],
        instructions: "Return a concise handoff.",
        reasoningEffort: "high",
        permission: "workspace",
        webSearch: false,
        sessionPersistence: kind === "main",
        decisionBy: "main"
      }
    },
    agentSessionIds: {},
    agentSessions: {},
    agentSessionMeta: {}
  } as unknown as ProjectState;
  return {
    project,
    purpose: "workflow",
    agent,
    kind,
    permission: "workspace",
    invocationId,
    inboxPath,
    projectPath,
    workspacePath,
    schemaPath: path.join(projectPath, "schema.json"),
    skillPaths: [],
    autoSkillPaths: [],
    availableSkillPaths: [],
    runtimePath
  };
}

describe("Codex Adapter durable session identity", () => {
  it("makes Codex Main and Worker actually read their staged Inbox and Memory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-codex-inputs-"));
    roots.push(root);
    const fake = await fakeCodex(root, "valid");
    const close = vi.fn(async () => undefined);
    const runtime = new HarnessRuntimeFacade({
      harnessExecutables: { codex: fake.executable },
      protocolProxyFactory: vi.fn(async () => ({
        baseUrl: "http://127.0.0.1:43193/v1",
        token: "invocation-token",
        close
      }))
    });

    const invocations = [
      { kind: "main", agent: "main", invocationId: "inv_codex_inputs_main" },
      { kind: "worker", agent: "writing", invocationId: "inv_codex_inputs_worker" }
    ] as const;
    for (const invocation of invocations) {
      const request = await durableRequest(
        root,
        invocation.invocationId,
        invocation.kind,
        invocation.agent
      );
      expect(path.basename(request.inboxPath)).toBe(
        `0001_${invocation.invocationId}_to_${invocation.agent}.md`
      );
      const result = await runtime.run(
        request,
        () => undefined,
        new AbortController().signal
      );
      expect(result.handoff).toBe("Codex fixture complete.");
    }

    const captures = (await fs.readFile(fake.capture, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        prompt: string;
        inboxPath: string;
        memoryPath: string;
        inbox: string;
        memory: string;
        codexHome: string;
      });
    expect(captures).toHaveLength(2);
    for (const capture of captures) {
      expect(capture.inboxPath).toContain(
        `${path.sep}.scienceevolve${path.sep}inbox${path.sep}`
      );
      expect(capture.memoryPath).toMatch(/Memory\.md$/);
      expect(capture.prompt).toContain(capture.inboxPath);
      expect(capture.prompt).toContain(capture.memoryPath);
      expect(capture.codexHome).toContain(
        `${path.sep}runtime${path.sep}harness-sessions${path.sep}`
      );
      expect(capture.codexHome).not.toContain(
        `${path.sep}runtime${path.sep}inv_codex_inputs_`
      );
    }
    expect(captures.map((capture) => capture.inbox)).toEqual([
      "main authoritative inbox\n",
      "writing authoritative inbox\n"
    ]);
    expect(captures.map((capture) => capture.memory)).toEqual([
      "main persistent memory\n",
      "writing persistent memory\n"
    ]);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("terminates Codex on malformed JSONL and emits no later canonical events", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-codex-stream-failfast-"));
    roots.push(root);
    const fake = await fakeCodex(root, "malformed-hang");
    const runtime = new HarnessRuntimeFacade({
      harnessExecutables: { codex: fake.executable },
      protocolProxyFactory: vi.fn(async () => ({
        baseUrl: "http://127.0.0.1:43193/v1",
        token: "invocation-token",
        close: async () => undefined
      }))
    });
    const request = await durableRequest(root, "inv_codex_stream_failfast");
    const officialEvents = vi.fn();
    request.onOfficialHarnessEvent = officialEvents;

    await expect(runtime.run(
      request,
      () => undefined,
      new AbortController().signal
    )).rejects.toMatchObject({
      code: "HARNESS_EVENT_STREAM_FAILED",
      safeMessage: "Invalid official JSON event"
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect(fs.lstat(fake.later)).rejects.toMatchObject({ code: "ENOENT" });
    expect(officialEvents).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(officialEvents.mock.calls)).not.toContain("must not be emitted");
  });

  it("persists the official thread identity before a later turn failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-codex-id-early-"));
    roots.push(root);
    const fake = await fakeCodex(root, "starts-then-fails");
    const runtime = new HarnessRuntimeFacade({
      harnessExecutables: { codex: fake.executable },
      protocolProxyFactory: vi.fn(async () => ({
        baseUrl: "http://127.0.0.1:43193/v1",
        token: "invocation-token",
        close: async () => undefined
      }))
    });
    const request = await durableRequest(root, "inv_codex_early_identity");
    const onSessionStarted = vi.fn();
    request.onSessionStarted = onSessionStarted;

    await expect(runtime.run(
      request,
      () => undefined,
      new AbortController().signal
    )).rejects.toThrow();

    expect(onSessionStarted).toHaveBeenCalledOnce();
    expect(onSessionStarted).toHaveBeenCalledWith(expect.objectContaining({
      harnessId: "codex",
      nativeId: "thread-official-replacement",
      durable: true
    }));
  });

  it("fails closed instead of persisting pending identity when thread.started is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-codex-id-missing-"));
    roots.push(root);
    const fake = await fakeCodex(root, "missing");
    const runtime = new HarnessRuntimeFacade({
      harnessExecutables: { codex: fake.executable },
      protocolProxyFactory: vi.fn(async () => ({
        baseUrl: "http://127.0.0.1:43193/v1",
        token: "invocation-token",
        close: async () => undefined
      }))
    });
    const request = await durableRequest(root, "inv_codex_missing");
    const onSessionStarted = vi.fn();
    request.onSessionStarted = onSessionStarted;

    await expect(runtime.run(
      request,
      () => undefined,
      new AbortController().signal
    )).rejects.toMatchObject({
      code: "HARNESS_CONTRACT_VIOLATION",
      source: "adapter",
      harnessId: "codex"
    });
    expect(onSessionStarted).not.toHaveBeenCalled();
  });

  it("turns a resumed identity mismatch into a same-Harness replacement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-codex-id-resume-"));
    roots.push(root);
    const fake = await fakeCodex(root, "resume-mismatch");
    const runtime = new HarnessRuntimeFacade({
      harnessExecutables: { codex: fake.executable },
      protocolProxyFactory: vi.fn(async () => ({
        baseUrl: "http://127.0.0.1:43193/v1",
        token: "invocation-token",
        close: async () => undefined
      }))
    });
    const request = await durableRequest(root, "inv_codex_resume_mismatch");
    const previous: SessionRef = {
      schemaVersion: 1,
      harnessId: "codex",
      adapterVersion: codexAdapterVersion,
      generation: 6,
      nativeId: "thread-previous",
      durable: true,
      createdAt: "2026-09-16T00:00:00.000Z"
    };
    request.project.agentSessions = { main: previous };
    const onSessionStarted = vi.fn();
    const onOfficialHarnessEvent = vi.fn();
    const traces: string[] = [];
    request.onSessionStarted = onSessionStarted;
    request.onOfficialHarnessEvent = onOfficialHarnessEvent;

    const result = await runtime.run(
      request,
      (_kind, message) => { traces.push(message); },
      new AbortController().signal
    );

    expect(result).toMatchObject({
      handoff: "Codex fixture complete.",
      threadId: "thread-official-replacement"
    });
    expect(traces).toContain(
      "Native session resume failed; retrying once with a same-Harness replacement"
    );
    expect(onSessionStarted).toHaveBeenCalledWith(expect.objectContaining({
      harnessId: "codex",
      generation: 7,
      nativeId: "thread-official-replacement",
      durable: true
    }));
    // The rejected resume is stopped at the identity boundary. None of its
    // frames are allowed into the persisted canonical trace.
    expect(onOfficialHarnessEvent).toHaveBeenCalledTimes(4);
    expect(onOfficialHarnessEvent.mock.calls.map(([event]) => event.seq)).toEqual([
      0, 1, 2, 3
    ]);
    const captures = (await fs.readFile(fake.capture, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        resumed: boolean;
        requestedThread: string;
        emittedThread: string;
        codexHome: string;
      });
    expect(captures).toHaveLength(2);
    expect(captures[0]).toMatchObject({
      resumed: true,
      requestedThread: previous.nativeId,
      emittedThread: "thread-unexpected"
    });
    expect(captures[1]).toMatchObject({
      resumed: false,
      emittedThread: "thread-official-replacement"
    });
    expect(captures[0]?.codexHome).toBe(captures[1]?.codexHome);
  });
});
