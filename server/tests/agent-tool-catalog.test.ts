import { describe, expect, it } from "vitest";
import { buildAgentToolCatalog } from "../src/agent-tool-catalog.js";
import { compileInvocationPolicy, compileWorkflowPrompt } from "../src/harness-runtime/invocation-policy.js";
import type { AgentRunRequest } from "../src/types.js";

describe("Agent resource discovery", () => {
  it("provides legal global/project references without host paths, source, arguments or environment", () => {
    const catalog = buildAgentToolCatalog([
      { id: "builtin:measure", name: "Measurement", description: "Measure fixed inputs", source: "builtin", path: "/private/service/skills/measure/SKILL.md" }
    ], { check: { files: { "SKILL.md": "---\nname: check\ndescription: Verify fixed results\n---\nprivate-skill-body" } } }, {
      verify: { entrypoint: "server.js", files: { "server.js": "private-server-body", "README.md": "# Verify mathematical results\nprivate-mcp-body" },
        args: ["private-argument"], envFrom: { TOKEN: "PRIVATE_HOST_TOKEN" } }
    });
    expect(catalog.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: "builtin:measure", description: "Measure fixed inputs" }),
      expect.objectContaining({ reference: "project:check", description: "Verify fixed results" })
    ]));
    expect(catalog.mcps).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "fixed", selection: { name: "citation-check", url: "https://118.196.152.186/mcp/citation-check" } }),
      expect.objectContaining({ source: "project", description: "Verify mathematical results", selection: { name: "verify", project: "verify" } })
    ]));
    const serialized = JSON.stringify(catalog);
    for (const privateValue of ["/private/service", "private-skill-body", "private-server-body", "private-mcp-body", "private-argument", "PRIVATE_HOST_TOKEN"]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(catalog.experiments.selection).toEqual({ experimentMcp: true });
    expect(catalog.experiments.conditions.join(" ")).toContain("workspace Workers");
    expect(catalog.harnesses.find(item => item.id === "codex")).toMatchObject({ skills: true, mcp: true });
  });

  it("does not invent a purpose for project services without metadata", () => {
    const catalog = buildAgentToolCatalog([], {}, { undocumented: { entrypoint: "server.js", files: { "server.js": "secret source" } } });
    expect(catalog.mcps.find(item => item.name === "undocumented")?.description).toContain("purpose is not declared");
    expect(JSON.stringify(catalog)).not.toContain("secret source");
  });

  it("gives an authorized Main metadata while leaving its actual tool policy unchanged", () => {
    const catalog = buildAgentToolCatalog([]);
    const config = { instructions: "Configure the next Agent", skills: [], autoSkills: [], mcpServers: [], webSearch: false };
    const request = { agent: "main", kind: "main", permission: "workspace", skillPaths: [], autoSkillPaths: [],
      toolCatalog: catalog, project: { agents: { main: config }, orchestration: { allowMainReconfiguration: true } },
      control: { stagingPath: "/runtime/actions.json", capability: "server-only", stateVersion: 1,
        candidates: [], decisionBy: "main", allowUserIntervention: false, canComplete: false,
        allowWorkflowReconfiguration: true, requireBridge: true } } as unknown as AgentRunRequest;
    const inputs = { projectPath: "/project", workspacePath: "/workspace", inboxPath: "/inbox", memoryPath: "/memory", runtimePath: "/runtime", inboxSha256: "fixture" };
    const policy = compileInvocationPolicy(config as AgentRunRequest["project"]["agents"][string], request);
    const prompt = compileWorkflowPrompt(request, inputs, policy);
    expect(prompt).toContain("<agent_tool_catalog>");
    expect(prompt).toContain('"experimentMcp":true');
    expect(policy.mcpServers).toEqual([]);
    expect(policy.skillPaths).toEqual([]);
    for (const patch of [{ agent: "worker", kind: "worker" }, { purpose: "explainer" },
      { control: { ...request.control, allowWorkflowReconfiguration: false } }, { terminalPushObservation: { operationId: "original" } },
      { project: { ...request.project, orchestration: { allowMainReconfiguration: false } } }]) {
      const other = { ...request, ...patch } as AgentRunRequest;
      other.project = { ...other.project, agents: { main: config, worker: config } } as AgentRunRequest["project"];
      expect(compileWorkflowPrompt(other, inputs, policy)).not.toContain("<agent_tool_catalog>");
    }
  });
});
