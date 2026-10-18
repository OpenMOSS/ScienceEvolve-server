/** Private supervisor: its IPC lifetime belongs to one Agent invocation. */
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import type { ProjectMcpHostConfig } from "./project-mcp.js";

let upstream: Client | undefined;
let httpServer: http.Server | undefined;
let closing = false;
const active = new Set<Server>();

async function listAllMcpTools(client: Client): Promise<void> {
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 30_000 });
    for (const tool of page.tools) {
      if (names.has(tool.name)) throw new Error("MCP tools/list returned duplicate names");
      names.add(tool.name);
    }
    if (names.size > 10_000) throw new Error("MCP tools/list exceeded 10000 tools");
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error("MCP tools/list repeated its pagination cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor);
}

async function close(code = 0) {
  if (closing) return;
  closing = true;
  const force = setTimeout(() => {
    if (process.platform !== "win32") process.kill(-process.pid, "SIGKILL");
    else process.exit(1);
  }, 5_000);
  httpServer?.close();
  httpServer?.closeAllConnections();
  await Promise.allSettled([...active].map((server) => server.close()));
  await upstream?.close().catch(() => undefined);
  clearTimeout(force);
  if (process.platform !== "win32") {
    try { process.kill(-process.pid, "SIGKILL"); } catch { /* group gone */ }
  }
  process.exit(code);
}
process.on("error", () => { void close(1); });
process.once("disconnect", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });

async function start(config: ProjectMcpHostConfig) {
  if (closing) return;
  // Start from the MCP SDK's allowlisted process environment. Task code only
  // receives additional host values through its explicit envFrom mapping.
  const env = getDefaultEnvironment();
  for (const [target, source] of Object.entries(config.definition.envFrom)) {
    if (process.env[source] === undefined) throw new Error(`Missing environment variable ${source}`);
    env[target] = process.env[source]!;
  }
  const require = createRequire(import.meta.url);
  const nodeModulePaths = require.resolve.paths("@modelcontextprotocol/sdk") ?? [];
  env.NODE_PATH = [...nodeModulePaths, ...(env.NODE_PATH ? [env.NODE_PATH] : [])].join(path.delimiter);
  env.SCIENCEEVOLVE_MCP_SOURCE_DIR = config.directory;
  env.SCIENCEEVOLVE_WORKSPACE = config.workspacePath;
  env.SCIENCEEVOLVE_PROJECT_ROOT = config.projectPath;
  const transport = new StdioClientTransport({
    command: config.definition.command === "node" ? process.execPath : config.definition.command,
    args: [path.join(config.directory, config.definition.entrypoint), ...config.definition.args],
    cwd: config.workspacePath, env, stderr: "pipe"
  });
  let diagnosticBytes = 0;
  transport.stderr?.on("data", (chunk: Buffer) => {
    const remaining = 1_048_576 - diagnosticBytes;
    if (remaining > 0) process.stderr.write(chunk.subarray(0, remaining));
    diagnosticBytes += chunk.length;
  });
  const client = upstream = new Client({ name: "openfars-project-mcp", version: "0.1.0" }, { capabilities: {} });
  client.onclose = () => { if (!closing) void close(1); };
  await client.connect(transport, { timeout: 30_000 });
  const capabilities = client.getServerCapabilities() ?? {};
  if (capabilities.tools) await listAllMcpTools(client);
  if (closing) return;
  const route = `/mcp/${config.routeToken}`;
  httpServer = http.createServer(async (request, response) => {
    if (request.url !== route) { response.writeHead(404).end(); return; }
    if (request.method !== "POST") { response.writeHead(405, { allow: "POST" }).end(); return; }
    const server = new Server({ name: config.name, version: "0.1.0" }, { capabilities: {
      ...(capabilities.tools ? { tools: {} } : {}), ...(capabilities.resources ? { resources: {} } : {}), ...(capabilities.prompts ? { prompts: {} } : {})
    } });
    active.add(server);
    const options = (signal: AbortSignal) => ({ signal, timeout: 60_000 });
    if (capabilities.tools) {
      server.setRequestHandler(ListToolsRequestSchema, (req, extra) => client.listTools(req.params, options(extra.signal)));
      server.setRequestHandler(CallToolRequestSchema, (req, extra) => client.callTool(req.params, undefined, options(extra.signal)));
    }
    if (capabilities.resources) {
      server.setRequestHandler(ListResourcesRequestSchema, (req, extra) => client.listResources(req.params, options(extra.signal)));
      server.setRequestHandler(ListResourceTemplatesRequestSchema, (req, extra) => client.listResourceTemplates(req.params, options(extra.signal)));
      server.setRequestHandler(ReadResourceRequestSchema, (req, extra) => client.readResource(req.params, options(extra.signal)));
    }
    if (capabilities.prompts) {
      server.setRequestHandler(ListPromptsRequestSchema, (req, extra) => client.listPrompts(req.params, options(extra.signal)));
      server.setRequestHandler(GetPromptRequestSchema, (req, extra) => client.getPrompt(req.params, options(extra.signal)));
    }
    response.once("close", () => { active.delete(server); void server.close(); });
    try {
      const httpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(httpTransport);
      await httpTransport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(502).end("Project MCP request failed");
      else response.end();
      active.delete(server);
      await server.close().catch(() => undefined);
    }
  });
  await new Promise<void>((resolve, reject) => { httpServer!.once("error", reject); httpServer!.listen(0, "127.0.0.1", resolve); });
  if (closing || !process.connected) { await close(); return; }
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("No project MCP port");
  process.send?.({ type: "ready", url: `http://127.0.0.1:${address.port}${route}` });
}
process.once("message", (config: ProjectMcpHostConfig) => {
  void start(config).catch((error) => {
    process.stderr.write(`${String(error).slice(0, 4_000)}\n`);
    if (process.connected) process.send?.({ type: "failed" });
    void close(1);
  });
});
