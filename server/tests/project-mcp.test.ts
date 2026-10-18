import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  startProjectMcps,
  materializeProjectMcps,
  mcpDefinitionsSchema,
  validateProjectMcpReferences,
  type ProjectMcpLease
} from "../src/project-mcp.js";
import { createProjectSchema, mergeAgentConfigs } from "../src/validation.js";
import {
  mainAgentOrchestrationDocument,
  parseAgentOrchestrationProposal
} from "../src/agent-orchestration-reconfiguration.js";
import { projectMcpSource } from "./fixtures/project-mcp-source.js";

const roots: string[] = [];
const leases: ProjectMcpLease[] = [];
afterEach(async () => {
  await Promise.all(leases.splice(0).map((lease) => lease.close()));
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })));
});

async function options(version = "one") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-project-mcp-"));
  roots.push(root);
  const workspacePath = path.join(root, "workspace");
  await fs.mkdir(workspacePath);
  return {
    projectPath: path.join(root, "prj_test"),
    workspacePath,
    runtimePath: path.join(root, "runtime"),
    definitions: {
      evidence: {
        entrypoint: "server.cjs",
        files: { "server.cjs": projectMcpSource(version) }
      }
    },
    servers: [{ name: "evidence", project: "evidence" }] as const,
    signal: new AbortController().signal
  };
}

async function connect(url: string): Promise<Client> {
  const client = new Client(
    { name: "openfars-project-mcp-test", version: "1" },
    { capabilities: {} }
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

it("validates project references, entrypoints, paths, env names, and selection shape", () => {
  const definition = { entrypoint: "server.cjs", files: { "server.cjs": "code" } };
  const missing = createProjectSchema.parse({
    title: "test",
    requirement: "test",
    agents: { main: { mcpServers: [{ name: "task", project: "missing" }] } }
  });
  expect(() => validateProjectMcpReferences(
    mergeAgentConfigs(missing.agents, missing.orchestration),
    {}
  )).toThrow("undefined project MCP");
  for (const entry of [
    { name: "a", project: "task", url: "https://example.com/mcp" },
    { name: "a", project: "../task" },
    { name: "citation-check", project: "task" }
  ]) {
    expect(() => createProjectSchema.parse({
      title: "test",
      requirement: "test",
      mcpDefinitions: { task: definition },
      agents: { main: { mcpServers: [entry] } }
    })).toThrow();
  }
  for (const input of [
    { ...definition, entrypoint: "missing" },
    { ...definition, files: { "server.cjs": "code", "../escape": "bad" } },
    { ...definition, envFrom: { KEY: "literal with spaces" } }
  ]) {
    expect(() => mcpDefinitionsSchema.parse({ task: input })).toThrow();
  }
});

it("keeps accepted MCPs immutable while allowing append-only definitions", () => {
  const parsed = createProjectSchema.parse({
    title: "test",
    requirement: "test",
    mcpDefinitions: { task: {
      entrypoint: "server.cjs",
      files: { "server.cjs": projectMcpSource("one") }
    } },
    agents: { main: { mcpServers: [{ name: "task", project: "task" }] } }
  });
  parsed.orchestration.allowMainReconfiguration = true;
  const agents = mergeAgentConfigs(parsed.agents, parsed.orchestration);
  const original = parsed.mcpDefinitions!;
  const document = mainAgentOrchestrationDocument(
    "prj_test",
    parsed.orchestration,
    agents,
    {},
    original
  );
  document.mcpDefinitions.task.files["server.cjs"] = projectMcpSource("two");
  expect(() => parseAgentOrchestrationProposal(
    JSON.stringify(document),
    "prj_test",
    parsed.orchestration,
    agents,
    { mcpDefinitions: original }
  )).toThrow("immutable");
  document.mcpDefinitions = {
    "task-v2": {
      entrypoint: "server.cjs",
      files: { "server.cjs": projectMcpSource("two") }
    }
  };
  const proposal = parseAgentOrchestrationProposal(
    JSON.stringify(document),
    "prj_test",
    parsed.orchestration,
    agents,
    { mcpDefinitions: original }
  );
  expect(proposal.mcpDefinitions.task).toEqual(original.task);
  expect(proposal.mcpDefinitions["task-v2"].files["server.cjs"]).toContain('"two"');
  document.mcpDefinitions = {};
  document.agents.main.instructions = "preserve old resources";
  expect(parseAgentOrchestrationProposal(
    JSON.stringify(document),
    "prj_test",
    parsed.orchestration,
    agents,
    { mcpDefinitions: original }
  ).mcpDefinitions).toEqual(expect.objectContaining(original));
});

it("hosts stdio tools/resources/prompts in the shared workspace and collects the process", async () => {
  const input = await options();
  vi.stubEnv("SCIENCEEVOLVE_TEST_LABEL", "task-owned");
  vi.stubEnv("SCIENCEEVOLVE_UNMAPPED_SECRET", "must-not-leak");
  const lease = await startProjectMcps({
    ...input,
    servers: [...input.servers],
    definitions: {
      evidence: {
        ...input.definitions.evidence,
        envFrom: { TASK_LABEL: "SCIENCEEVOLVE_TEST_LABEL" }
      }
    }
  });
  leases.push(lease);
  const endpoint = lease.servers[0].url;
  expect(endpoint).toBeTruthy();
  const client = await connect(endpoint!);
  let pid = 0;
  try {
    expect((await client.listTools()).tools[0].name).toBe("evidence");
    const result = await client.callTool({ name: "evidence" });
    const info = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    pid = info.pid;
    expect(info).toMatchObject({
      version: "one",
      cwd: input.workspacePath,
      label: "task-owned"
    });
    expect(info.unmapped).toBeUndefined();
    expect((await client.readResource({ uri: "task://evidence" })).contents[0].text).toBe("one");
    expect((await client.getPrompt({ name: "review" })).messages[0].content)
      .toMatchObject({ text: "one" });
    expect(alive(pid)).toBe(true);
  } finally {
    await client.close();
    await lease.close();
  }
  await vi.waitFor(() => expect(alive(pid)).toBe(false));

  const old = await materializeProjectMcps(input.projectPath, input.definitions);
  const revised = await materializeProjectMcps(input.projectPath, {
    evidence: {
      ...input.definitions.evidence,
      files: { "server.cjs": projectMcpSource("two") }
    }
  });
  expect(old.evidence).not.toBe(revised.evidence);
  await fs.writeFile(path.join(revised.evidence, "server.cjs"), "uncommitted");
  await expect(materializeProjectMcps(input.projectPath, {
    evidence: {
      ...input.definitions.evidence,
      files: { "server.cjs": projectMcpSource("two") }
    }
  })).rejects.toThrow("modified outside apply_workflow");
}, 15_000);

it("closes an in-flight project service on cancellation", async () => {
  const input = await options();
  const controller = new AbortController();
  const lease = await startProjectMcps({
    ...input,
    servers: [...input.servers],
    signal: controller.signal
  });
  leases.push(lease);
  const client = await connect(lease.servers[0].url!);
  const result = await client.callTool({ name: "evidence" });
  const pid = JSON.parse((result.content as Array<{ text: string }>)[0].text).pid;
  const pending = client.callTool({
    name: "evidence",
    arguments: { wait: true }
  }).catch(() => undefined);
  controller.abort();
  await lease.close();
  await client.close();
  await pending;
  await vi.waitFor(() => expect(alive(pid)).toBe(false));
}, 15_000);

it("cleans all started services when a later project MCP fails startup", async () => {
  const input = await options();
  input.definitions.evidence.files["server.cjs"] =
    "require('node:fs').writeFileSync('started.pid', String(process.pid));\n" +
    projectMcpSource("one");
  await expect(startProjectMcps({
    ...input,
    servers: [
      ...input.servers,
      { name: "bad", project: "bad" }
    ],
    definitions: {
      ...input.definitions,
      bad: {
        entrypoint: "bad.cjs",
        files: { "bad.cjs": "throw new Error('broken')" }
      }
    }
  })).rejects.toThrow(/initialize|ready/);
  const pid = Number(await fs.readFile(
    path.join(input.workspacePath, "started.pid"),
    "utf8"
  ));
  await vi.waitFor(() => expect(alive(pid)).toBe(false));
  expect(await fs.readFile(
    path.join(input.runtimePath, "mcp", "bad.stderr.log"),
    "utf8"
  )).toContain("broken");
}, 15_000);

it("reports an unexpected service exit to the invocation owner", async () => {
  const input = await options();
  const onFailure = vi.fn();
  const lease = await startProjectMcps({
    ...input,
    servers: [...input.servers],
    onFailure
  });
  leases.push(lease);
  const client = await connect(lease.servers[0].url!);
  try {
    const result = await client.callTool({ name: "evidence" });
    const pid = JSON.parse((result.content as Array<{ text: string }>)[0].text).pid;
    process.kill(pid, "SIGKILL");
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce(), { timeout: 5_000 });
  } finally {
    await client.close();
  }
}, 10_000);
