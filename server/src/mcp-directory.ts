import type { AgentMcpServer } from "./types.js";

/**
 * System MCP servers shipped with OpenFARS.  The directory is deliberately a
 * data-only module: credentials are resolved from the server process
 * environment and are never part of this response or a browser bundle.
 */
export interface FixedMcpDefinition {
  name: string;
  description: string;
  url: string;
}

export const FIXED_MCP_BASE_URL = "https://118.196.152.186/mcp" as const;
export const FIXED_MCP_TOKEN_ENV_VAR = "SCIENCEEVOLVE_FIXED_MCP_TOKEN" as const;

export const FIXED_MCP_DIRECTORY: readonly FixedMcpDefinition[] = Object.freeze([
  { name: "ai4fusion-mcp", description: "核聚变物理的数据库 MCP", url: `${FIXED_MCP_BASE_URL}/ai4fusion-mcp` },
  { name: "ai4polymat-epoxy", description: "环氧树脂预测 MCP", url: `${FIXED_MCP_BASE_URL}/ai4polymat-epoxy` },
  { name: "aistudio-auth", description: "星河启智用户登录与科研工具", url: `${FIXED_MCP_BASE_URL}/aistudio-auth` },
  { name: "astronomy_knowledge_base", description: "天文学知识库", url: `${FIXED_MCP_BASE_URL}/astronomy_knowledge_base` },
  { name: "bohrium-auth", description: "Bohrium 用户登录与科研工具", url: `${FIXED_MCP_BASE_URL}/bohrium-auth` },
  { name: "inkstone-auth", description: "书生端砚用户登录与科研工具", url: `${FIXED_MCP_BASE_URL}/inkstone-auth` },
  { name: "citation-check", description: "Verify citations, literature sources, and consistency between claims and references.", url: `${FIXED_MCP_BASE_URL}/citation-check` },
  { name: "idea-agent", description: "Evaluate the novelty, feasibility, and research value of scientific ideas.", url: `${FIXED_MCP_BASE_URL}/idea-agent` },
  { name: "reading_agent", description: "Run long-form literature reading and asynchronous research analysis tasks.", url: `${FIXED_MCP_BASE_URL}/reading_agent` }
]);

const byName = new Map(FIXED_MCP_DIRECTORY.map((entry) => [entry.name.toLowerCase(), entry]));

export function fixedMcpDefinition(name: string): FixedMcpDefinition | undefined {
  return byName.get(name.trim().toLowerCase());
}

/** Exact name and URL matching is required before the server token is used. */
export function isFixedMcpServer(server: Pick<AgentMcpServer, "name"> & Partial<Pick<AgentMcpServer, "url">>): boolean {
  if (!server.url) return false;
  const definition = fixedMcpDefinition(server.name);
  return Boolean(definition && definition.name === server.name.trim() && definition.url === server.url?.trim());
}

/**
 * Reject a user supplied URL that attempts to impersonate a fixed entry.  A
 * custom server with an unrelated name remains fully supported.
 */
export function assertMcpServerIdentity(server: Pick<AgentMcpServer, "name"> & Partial<Pick<AgentMcpServer, "url">>): void {
  if (server.name.trim().toLowerCase() === "scienceevolve-sii") {
    throw new Error("内置 scienceevolve-sii 使用 experimentMcp 独立选择，不接受自定义连接或项目 MCP 引用");
  }
  if (server.name.trim().toLowerCase() === "scienceevolve-sleep") {
    throw new Error("scienceevolve-sleep 是自动注入的内置 MCP，不能作为自定义 MCP 配置");
  }
  const definition = fixedMcpDefinition(server.name);
  if (definition && !isFixedMcpServer(server)) {
    throw new Error(`系统 MCP ${definition.name} 的名称和 URL 必须与固定目录完全匹配`);
  }
}

export function normalizeMcpServerSelection(
  servers: readonly AgentMcpServer[]
): AgentMcpServer[] {
  const result: AgentMcpServer[] = [];
  const names = new Set<string>();
  for (const raw of servers) {
    const name = String(raw?.name ?? "").trim();
    const url = String(raw?.url ?? "").trim();
    const server: AgentMcpServer = raw.project === undefined
      ? { name, url }
      : { name, project: raw.project };
    if (!name || (raw.project === undefined && !url)) throw new Error("MCP 名称和 URL 不能为空");
    assertMcpServerIdentity(server);
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error("MCP 名称不能重复");
    names.add(key);
    result.push(server);
  }
  if (result.length > 32) throw new Error("每个 Agent 最多可配置 32 个 MCP");
  return result;
}

/** Project references must be resolved to invocation-local HTTP endpoints before a Harness starts. */
export function resolvedMcpServers(
  servers: readonly AgentMcpServer[]
): Array<{ name: string; url: string }> {
  return servers.map((server) => {
    if (!server.url) throw new Error(`Unresolved project MCP: ${server.name}`);
    return { name: server.name, url: server.url };
  });
}

export function sameMcpServerSelection(
  left: AgentMcpServer,
  right: AgentMcpServer
): boolean {
  return left.name === right.name &&
    left.url === right.url &&
    left.project === right.project;
}

/** Public directory records are safe to serialize to the browser. */
export function publicFixedMcpDirectory(): FixedMcpDefinition[] {
  return FIXED_MCP_DIRECTORY.map((entry) => ({ ...entry }));
}

export function fixedMcpToken(): string | undefined {
  const value = process.env[FIXED_MCP_TOKEN_ENV_VAR];
  return value?.trim() || undefined;
}
