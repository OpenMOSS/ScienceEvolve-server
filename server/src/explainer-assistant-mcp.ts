import http from "node:http";
import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { redactTrace } from "./utils.js";
import type { AssistantAction, ExplainerAssistantStore } from "./explainer-assistant.js";
import { EXPLAINER_MCP_NAME, EXPLAINER_DRAFT_FIELD_GUIDANCE } from "./internal/shared/explainer-tools.js";

export { EXPLAINER_MCP_NAME } from "./internal/shared/explainer-tools.js";
const mutationProperties = {
  expectedRevision: { type: "integer", minimum: 0, description: "Exact revision returned by get_context." },
  operationId: { type: "string", minLength: 8, maxLength: 160, pattern: "^[A-Za-z0-9_-]+$", description: "Stable unique operation identity. Reuse only for an exact retry." },
  explanation: { type: "string", description: "Brief user-facing explanation of the change." }
};
export const EXPLAINER_TOOLS = [
  { name: "get_context", description: "Default: current revision, section names and the complete Agent index only. Every metadata index includes all entries without pagination; detail bodies are opened individually. Read a selected draft field with section=draft,key=<field>; one Agent with section=agent,key=<agentId>; list catalog fields with section=catalog, then key=<field> and entry=<listed entry> for one full record. Project/workflow sections likewise use key. Read only needed details before editing, and refresh after a stale revision rejection.",
    inputSchema: { type: "object", properties: {
      section: { type: "string", enum: ["overview", "draft", "agent", "catalog", "project", "workflow", "evidence"] },
      key: { type: "string", minLength: 1, maxLength: 256 }, entry: { type: "string", minLength: 1, maxLength: 1024 }
    }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  ...[
    ["update_draft", "Update the current draft using an RFC 7396 JSON merge patch. Valid project designs automatically save to the homepage draft library and return a link; running-project adjustment drafts remain proposals. Never starts research or creates a repository. Objects merge, arrays replace, null removes. Provide a complete valid graph whenever changing graph structure."],
    ["save_draft", "Create or save the project as a persistent draft in the homepage library. Never launches research or creates a Git repository. Returns the actual saved task ID and navigation link."],
    ["undo_draft", "Undo the last assistant draft edit when the user asks. User edits made since then are preserved through revision checks."],
    ["submit_workflow_adjustment", "Submit the current adjustment draft to an existing running project, only when the user asks to apply their changes. The existing Workflow mechanism decides the actual safe application time. Never launches projects."]
  ].map(([name, description]) => ({ name: name!, description: description!,
    inputSchema: { type: "object", properties: { ...mutationProperties,
      ...(name === "update_draft" ? { patch: { type: "object", additionalProperties: false,
        description: "Read get_context first. Omit unrelated fields. Workflow/configuration edits must preserve requirement; requirement is the research brief for downstream research Agents, not your workflow-design instructions.",
        properties: { title: { type: "string" }, requirement: { type: "string", description: EXPLAINER_DRAFT_FIELD_GUIDANCE.requirement },
          agents: { type: ["object", "null"], description: EXPLAINER_DRAFT_FIELD_GUIDANCE.agents },
          orchestration: { type: ["object", "null"], description: EXPLAINER_DRAFT_FIELD_GUIDANCE.orchestration },
          git: { type: ["object", "null"], description: EXPLAINER_DRAFT_FIELD_GUIDANCE.git },
          skillDefinitions: { type: ["object", "null"] }, mcpDefinitions: { type: ["object", "null"] } } },
        workflowBase: { type: "object", properties: { revision: { type: "integer" }, hash: { type: "string" } }, required: ["revision", "hash"], additionalProperties: false,
          description: "Set only after reviewing and rebasing the draft against this exact current official Workflow version." } } : {}) },
      required: ["expectedRevision", "operationId", ...(name === "update_draft" ? ["patch"] : [])], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }))
];

/** A short-lived, invocation-bound native MCP endpoint. The Harness's own
 * agent performs its tool loop; OpenFARS never scripts a conversational flow. */
export const EXPLAINER_READ_CONTEXT_TOOL = { name: "read_context", description: "Read a selected immutable context index, group, or detail file. Use its full listed path. Large files return explicit byte offsets, total bytes and EOF; continue only for the selected material you need. Filesystem is read-only and limited to this invocation's quoted context directory.",
  inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1 },
    offset: { type: "integer", minimum: 0 }, maxBytes: { type: "integer", minimum: 4, maximum: 32768 } }, required: ["path"], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } };

interface ContextReadRoot { path: string; dev: bigint; ino: bigint }
async function pinContextRoots(root: string | readonly string[]): Promise<ContextReadRoot[]> {
  const roots: ContextReadRoot[] = [];
  for (const candidate of typeof root === "string" ? [root] : root) {
    const real = await fs.realpath(candidate).catch(() => undefined);
    if (!real) continue;
    const stat = await fs.lstat(real, { bigint: true });
    if (stat.isDirectory() && !stat.isSymbolicLink()) roots.push({ path: real, dev: stat.dev, ino: stat.ino });
  }
  return roots;
}

async function openContextFile(root: ContextReadRoot, file: string): Promise<FileHandle> {
  const current = await fs.lstat(root.path, { bigint: true });
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== root.dev || current.ino !== root.ino)
    throw new Error("Invocation context root changed; use the current authorized input");
  if (process.platform !== "linux") {
    if (await fs.realpath(file) !== file) throw new Error("Context reader rejects symlinks");
    return fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  }
  const directories: FileHandle[] = [];
  try {
    let parent = await fs.open(root.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    directories.push(parent);
    const pinned = await parent.stat({ bigint: true });
    if (pinned.dev !== root.dev || pinned.ino !== root.ino) throw new Error("Context root identity changed");
    const parts = path.relative(root.path, file).split(path.sep);
    for (const part of parts.slice(0, -1)) {
      parent = await fs.open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      directories.push(parent);
      if ((await parent.stat({ bigint: true })).dev !== root.dev) throw new Error("Context reader rejects mount crossings");
    }
    const handle = await fs.open(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if ((await handle.stat({ bigint: true })).dev !== root.dev) { await handle.close(); throw new Error("Context reader rejects mount crossings"); }
    return handle;
  } finally { await Promise.all(directories.map(directory => directory.close())); }
}

export async function readExplainerContext(root: string | readonly string[], args: Record<string, unknown>): Promise<unknown> {
  return readPinnedContext(await pinContextRoots(root), args);
}

async function readPinnedContext(roots: readonly ContextReadRoot[], args: Record<string, unknown>): Promise<unknown> {
  if (typeof args.path !== "string" || !args.path || args.path.includes("\0")) throw new Error("read_context requires a listed file path");
  const offset = args.offset ?? 0, maxBytes = args.maxBytes ?? 32768;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(maxBytes) || Number(maxBytes) < 4 || Number(maxBytes) > 32768)
    throw new Error("read_context offset/maxBytes are out of range");
  if (!roots.length) throw new Error("Invocation context read roots are unavailable");
  const file = path.resolve(roots[0].path, args.path);
  const selected = roots.find(base => file.startsWith(`${base.path}${path.sep}`));
  if (!selected) throw new Error("Context file is outside the invocation's read-only root");
  const handle = await openContextFile(selected, file);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Context reader accepts regular, non-linked files only");
    const buffer = Buffer.alloc(Number(maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, Number(offset));
    let length = bytesRead;
    if (Number(offset) + length < stat.size && length > 3) {
      // End at a UTF-8 boundary; nextOffset always advances over exactly the
      // bytes returned, so continuation never loses part of a Chinese token.
      let start = length - 1;
      while (start >= 0 && (buffer[start] & 0xc0) === 0x80) start--;
      const lead = buffer[start], expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (start >= 0 && length - start < expected) length = start;
    }
    return { path: file, offset, nextOffset: Number(offset) + length, totalBytes: stat.size,
      eof: Number(offset) + length >= stat.size, text: buffer.subarray(0, length).toString("utf8") };
  } finally { await handle.close(); }
}

export async function openExplainerAssistantMcp(store: ExplainerAssistantStore | undefined, id: string, signal: AbortSignal,
  onAction: (action: AssistantAction) => Promise<void>, readDirectory?: string | readonly string[]): Promise<{ url: string; close(): Promise<void> }> {
  const readRoots = readDirectory ? await pinContextRoots(readDirectory) : [];
  const route = `/mcp/${randomBytes(24).toString("hex")}`;
  const active = new Set<Server>();
  const pending = new Set<Promise<unknown>>();
  const server = http.createServer(async (request, response) => {
    if (request.url !== route || signal.aborted) { response.writeHead(404).end(); return; }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const mcp = new Server({ name: EXPLAINER_MCP_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
    active.add(mcp);
    const tools = [...(store ? EXPLAINER_TOOLS : []), ...(readDirectory ? [EXPLAINER_READ_CONTEXT_TOOL] : [])];
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    mcp.setRequestHandler(CallToolRequestSchema, async request => {
      try {
        signal.throwIfAborted();
        if (!tools.some(tool => tool.name === request.params.name)) throw new Error("Unknown Project Explainer tool");
        if (request.params.name === "read_context" && readDirectory) return {
          content: [{ type: "text", text: JSON.stringify(await readPinnedContext(readRoots, request.params.arguments ?? {})) }]
        };
        const operation = store!.call(id, request.params.name, request.params.arguments ?? {}, signal);
        pending.add(operation);
        let result: Awaited<typeof operation>;
        try { result = await operation; } finally { pending.delete(operation); }
        if (result.action) await onAction(result.action);
        const value = result.action ? { kind: result.action.kind, summary: result.action.summary,
          changedFields: result.action.changedFields, href: result.action.href, requestId: result.action.requestId,
          context: { id: result.action.context.id, revision: result.action.context.revision,
            taskId: result.action.context.taskId, projectId: result.action.context.projectId,
            canUndo: result.action.context.canUndo } } : result.result;
        return { content: [{ type: "text", text: JSON.stringify(value) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: redactTrace(error instanceof Error ? error.message : "Project Explainer tool failed") }] };
      }
    });
    response.once("close", () => { active.delete(mcp); void mcp.close().catch(() => undefined); });
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport); await transport.handleRequest(request, response);
    } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Project Explainer MCP endpoint is unavailable");
  return { url: `http://127.0.0.1:${address.port}${route}`, close: async () => {
    await Promise.allSettled([...pending]); server.closeAllConnections();
    await Promise.allSettled([...active].map(item => item.close()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
