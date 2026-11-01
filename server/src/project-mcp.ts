import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { materializeVersion, projectNameSchema, relativeFileSchema, textFilesSchema } from "./project-files.js";
import type { AgentConfigMap, AgentMcpServer } from "./types.js";

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const definition = z.object({
  files: textFilesSchema,
  command: z.string().trim().min(1).max(4096).refine((command) => !/[\x00-\x1f]/.test(command), "Invalid MCP executable").default("node"),
  entrypoint: relativeFileSchema,
  args: z.array(z.string().max(4096).refine((arg) => !arg.includes("\0"))).max(64).default([]),
  envFrom: z.record(envName, envName).default({})
}).strict().superRefine((value, ctx) => {
  if (!value.files[value.entrypoint]?.trim()) ctx.addIssue({ code: "custom", message: "MCP entrypoint must name a non-empty file in files" });
});
export const mcpDefinitionsSchema = z.record(projectNameSchema, definition).superRefine((definitions, ctx) => {
  if (Object.keys(definitions).length > 32 || Buffer.byteLength(JSON.stringify(definitions), "utf8") > 1_048_576) {
    ctx.addIssue({ code: "custom", message: "Project MCP supports at most 32 definitions and 1 MiB of content" });
  }
});
export type ProjectMcpDefinitions = z.input<typeof mcpDefinitionsSchema>;
export type ResolvedProjectMcpDefinitions = z.output<typeof mcpDefinitionsSchema>;

export function mcpRevision(input: ProjectMcpDefinitions[string]): string {
  const value = definition.parse(input);
  return createHash("sha256").update(JSON.stringify({
    files: Object.entries(value.files).sort(([a], [b]) => a.localeCompare(b)),
    command: value.command, entrypoint: value.entrypoint, args: value.args,
    envFrom: Object.entries(value.envFrom).sort(([a], [b]) => a.localeCompare(b))
  })).digest("hex");
}

export function validateProjectMcpReferences(agents: AgentConfigMap, definitions: ProjectMcpDefinitions): void {
  for (const [agent, config] of Object.entries(agents)) {
    for (const server of config.mcpServers) {
      if (server.project !== undefined && !Object.hasOwn(definitions, server.project)) throw new Error(`${agent} references undefined project MCP: ${server.project}`);
    }
  }
}

export function changedProjectMcps(before: ProjectMcpDefinitions = {}, after: ProjectMcpDefinitions = {}): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) =>
    !Object.hasOwn(before, name) || !Object.hasOwn(after, name) || mcpRevision(before[name]) !== mcpRevision(after[name]));
}

export async function materializeProjectMcps(projectDir: string, input: ProjectMcpDefinitions = {}): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(mcpDefinitionsSchema.parse(input))) {
    result[name] = await materializeVersion(projectDir, "mcp", name, mcpRevision(value), value.files);
  }
  return result;
}

export interface ProjectMcpHostConfig {
  name: string;
  definition: ResolvedProjectMcpDefinitions[string];
  directory: string;
  workspacePath: string;
  projectPath: string;
  routeToken: string;
}
export interface ProjectMcpLease {
  servers: AgentMcpServer[];
  close(): Promise<void>;
}
async function hostModule(): Promise<{ file: string; execArgv: string[] }> {
  const base = fileURLToPath(new URL("./project-mcp-host.js", import.meta.url));
  try { await fs.access(base); return { file: base, execArgv: [] }; } catch { /* source tests */ }
  const source = base.replace(/\.js$/, ".ts");
  await fs.access(source);
  return { file: source, execArgv: ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href] };
}
async function stopHost(child: ChildProcess, exited: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.disconnect();
  const timer = setTimeout(() => {
    try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already gone */ }
  }, 6_000);
  try { await exited; } finally { clearTimeout(timer); }
}

/** One service instance per selected definition per Agent invocation; no public ports or global registry. */
export async function startProjectMcps(input: {
  definitions?: ProjectMcpDefinitions; servers: AgentMcpServer[];
  projectPath: string; workspacePath: string; runtimePath: string; signal: AbortSignal;
  onFailure?: (error: Error) => void;
}): Promise<ProjectMcpLease> {
  const selected = [...new Set(input.servers.flatMap((server) => server.project === undefined ? [] : [server.project]))];
  if (!selected.length) return { servers: input.servers, close: async () => {} };
  const definitions = mcpDefinitionsSchema.parse(input.definitions ?? {});
  for (const name of selected) if (!Object.hasOwn(definitions, name)) throw new Error(`Undefined project MCP: ${name}`);
  const sources = await materializeProjectMcps(input.projectPath, definitions);
  const module = await hostModule();
  const hosts: Array<{ child: ChildProcess; exited: Promise<void> }> = [];
  const urls = new Map<string, string>();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= Promise.all(hosts.map(({ child, exited }) => stopHost(child, exited))).then(() => undefined);
  const abort = () => { void close(); };
  input.signal.addEventListener("abort", abort, { once: true });
  try {
    for (const name of selected) {
      input.signal.throwIfAborted();
      const runtimeRoot = path.join(input.runtimePath, "mcp");
      await fs.mkdir(runtimeRoot, { recursive: true });
      const directory = await fs.mkdtemp(path.join(runtimeRoot, `${name}-`));
      await fs.cp(sources[name], directory, { recursive: true });
      input.signal.throwIfAborted();
      const logPath = path.join(runtimeRoot, `${name}.stderr.log`);
      const log = await fs.open(logPath, "w", 0o600);
      let child: ChildProcess;
      try {
        input.signal.throwIfAborted();
        child = fork(module.file, [], { execArgv: module.execArgv, stdio: ["ignore", "ignore", log.fd, "ipc"], detached: process.platform !== "win32" });
      } finally { void log.close(); }
      let ready = false;
      child.once("exit", () => {
        if (process.platform !== "win32" && child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* already collected */ }
        }
        if (ready && !closing && !input.signal.aborted) input.onFailure?.(new Error(`Project MCP ${name} exited during the invocation; diagnostics: ${logPath}`));
      });
      const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.on("error", () => resolve()); });
      hosts.push({ child, exited });
      const config: ProjectMcpHostConfig = { name, definition: definitions[name], directory, workspacePath: input.workspacePath, projectPath: input.projectPath, routeToken: randomBytes(32).toString("hex") };
      const url = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error(`Project MCP ${name} startup timed out`)), 35_000);
        const onExit = () => finish(new Error(`Project MCP ${name} exited before becoming ready`));
        const onError = () => finish(new Error(`Project MCP ${name} could not start`));
        const onAbort = () => finish(new Error(`Project MCP ${name} startup aborted`));
        const onMessage = (message: unknown) => {
          const result = message as { type?: string; url?: string };
          if (result.type === "ready" && result.url) finish(undefined, result.url);
          else if (result.type === "failed") finish(new Error(`Project MCP ${name} failed to initialize; diagnostics: ${logPath}`));
        };
        function finish(error?: Error, value?: string) {
          clearTimeout(timeout); child.off("exit", onExit); child.off("error", onError); child.off("message", onMessage); input.signal.removeEventListener("abort", onAbort);
          if (error) reject(error); else resolve(value!);
        }
        child.once("exit", onExit); child.once("error", onError); child.on("message", onMessage); input.signal.addEventListener("abort", onAbort, { once: true });
        if (input.signal.aborted) onAbort(); else child.send(config, (error) => { if (error) onError(); });
      });
      if (closing || child.exitCode !== null || child.signalCode !== null) throw new Error(`Project MCP ${name} exited during startup`);
      ready = true;
      urls.set(name, url);
    }
    input.signal.throwIfAborted();
    return { servers: input.servers.map((server) => server.project === undefined ? server : { name: server.name, url: urls.get(server.project)! }), close: async () => { input.signal.removeEventListener("abort", abort); await close(); } };
  } catch (error) {
    input.signal.removeEventListener("abort", abort);
    await close();
    throw error;
  }
}
