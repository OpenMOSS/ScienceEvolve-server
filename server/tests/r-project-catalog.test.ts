import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { buildManifest, applyPlannedEdits, newResources, PROJECT_MCP_NAME } from "../../scripts/r-projects/catalog.mjs";
import { createProjectSchema, mergeAgentConfigs } from "../src/validation.js";
import { mainAgentOrchestrationDocument, parseAgentOrchestrationProposal } from "../src/agent-orchestration-reconfiguration.js";
import { startProjectMcps, mcpRevision, validateProjectMcpReferences } from "../src/project-mcp.js";
import { skillRevision, validateProjectSkillReferences } from "../src/project-skills.js";
const binding = { runId: "catalog-test", gatewayId: `gwy_${"a".repeat(32)}`, githubAccountId: `gha_${"b".repeat(32)}`, model: "test-model", harness: "pi", observedAt: "2026-10-06T00:00:00Z", evidencePath: "test fixture only" };
const manifest = buildManifest(binding);
const entry = (code: string) => manifest.cases.find((value: { code: string }) => value.code === code)!;
const groups = (code: string) => createProjectSchema.parse(entry(code).payload).orchestration.scopedWorkflow!.groups;
function proposalFor(code: string) {
  const e = entry(code), p = createProjectSchema.parse(e.payload), agents = mergeAgentConfigs(p.agents, p.orchestration);
  const document = mainAgentOrchestrationDocument(code, p.orchestration, agents, p.skillDefinitions, p.mcpDefinitions);
  const parse = (value: unknown) => parseAgentOrchestrationProposal(JSON.stringify(value), code, p.orchestration, agents, { skillDefinitions: p.skillDefinitions, mcpDefinitions: p.mcpDefinitions });
  return { entry: e, project: p, document, parse };
}
describe("R-series specification contracts", () => {
  it("requires observed runtime binding and distinct run names", () => {
    expect(() => buildManifest()).toThrow(/runId/);
    expect(() => buildManifest({ ...binding, gatewayId: undefined })).toThrow(/gateway/);
    const second = buildManifest({ ...binding, runId: "another-run" });
    expect(second.cases[0].payload.title).not.toBe(manifest.cases[0].payload.title);
    expect(second.cases[0].payload.git.repositoryName).not.toBe(manifest.cases[0].payload.git.repositoryName);
  });
  it.each(manifest.cases.map((e: { code: string }) => e.code))("validates ALL Main edits and runtime bindings: %s", (code) => {
    const { entry: e, project, document, parse } = proposalFor(code);
    expect(project.orchestration.input.target).toBe("main");
    expect(project.orchestration.scopedWorkflow!.groups.length).toBeGreaterThanOrEqual(2);
    for (const [name, agent] of Object.entries(project.agents!)) {
      expect(agent).toMatchObject({ gatewayId: binding.gatewayId, harness: binding.harness, model: binding.model });
      expect(agent.instructions).toContain("agent-memory/");
      expect(agent.instructions).not.toContain("Own the explicitly assigned");
      if (name === "main") expect(agent.instructions).toContain("If all requested targets/resources already match");
      if (code === "R04") expect(agent.instructions.includes("acceptancePendingFile")).toBe(name === "implementer");
    }
    const accepted = parse(applyPlannedEdits(document, e));
    for (const g of accepted.orchestration.scopedWorkflow!.groups) for (const l of g.workflow.loops ?? []) expect(l.maxIterations).toBe(2);
    validateProjectSkillReferences(accepted.agents, accepted.skillDefinitions!);
    validateProjectMcpReferences(accepted.agents, accepted.mcpDefinitions!);
    expect(e.launchReady).toBe(false);
  });
  it("keeps R01 normal with BOTH inputs [1,2,3] and R02 explicitly artifact-free", () => {
    expect(entry("R01").input.rounds).toEqual([[1, 2, 3], [1, 2, 3]]);
    expect(entry("R01").faults).toBeUndefined();
    const p = createProjectSchema.parse(entry("R02").payload);
    expect(p.orchestration.resultFormat).toMatchObject({ none: true, presets: [], custom: "" });
    expect(p.agents!.implementer.instructions).toContain("no source file or empty commit");
    for (const agent of Object.values(p.agents!)) {
      expect(agent.instructions).toContain('Expected record.result in every group: {"sum":5}');
      expect(agent.instructions).not.toContain('"all":{"sum":5}');
    }
  });
  it("R05 requests two siblings sharing a Worker, with two edited Loops", () => {
    const gs = groups("R05");
    expect(gs[0].workflow.input.edges.map((e) => e.target)).toEqual(["G_parent_G_left", "G_parent_G_right"]);
    for (const g of gs.slice(1)) expect(g.workflow.nodes.some((n) => n.kind === "agent" && n.agentId === "shared_worker")).toBe(true);
    expect(entry("R05").mainEdits.filter((e: { kind: string }) => e.kind === "loop")).toHaveLength(2);
    expect(gs.slice(1).map((g) => g.workflow.loops![0].exitTo)).toEqual(["G_left_pack", "G_right_pack"]);
    expect(entry("R05").payload.agents.parent_review.instructions).toContain("there is no implicit join");
    expect(entry("R06").payload.agents.parent_review.instructions).toContain("finish this invocation promptly");
    expect(entry("R05").payload.agents.shared_worker.instructions).toContain('Expected record.result by scope: {"G_left":{"sum":3},"G_right":{"sum":7},"G_parent":{"left":3,"right":7,"total":10}}');
    expect(entry("R05").payload.agents.shared_worker.instructions).toContain("Select only the value for the current group");
  });
  it("R06 shares ONE Leader across parent and both children", () => {
    const gs = groups("R06");
    expect(gs.map((g) => g.id)).toEqual(["G_parent", "G_left", "G_right"]);
    expect(new Set(gs.map((g) => g.leaderAgentId))).toEqual(new Set(["shared_leader"]));
    expect(gs.slice(1).every((g) => g.parentGroupId === "G_parent")).toBe(true);
    expect(entry("R06").mainEdits).toHaveLength(2);
  });
  it.each(["R07", "R16"])("%s contains a real three-level parent chain", (code) => {
    const gs = groups(code);
    expect(gs.map((g) => [g.id, g.parentGroupId])).toEqual([["G_parent", undefined], ["G_middle", "G_parent"], ["G_leaf", "G_middle"]]);
    expect(gs[2].workflow.loops![0]).toMatchObject({ maxIterations: 1, exitTo: "G_leaf_pack" });
  });
  it("R08 routes Worker to its Leader scope and returns to Worker", () => {
    const p = createProjectSchema.parse(entry("R08").payload);
    expect(p.orchestration.scopedWorkflow!.rootAgentIds).toContain("coordinator");
    expect(p.orchestration.routes.coordinator).toEqual([{ target: "G_parent", kind: "weak" }, { target: "main", kind: "weak" }]);
    expect(p.orchestration.routes.G_parent).toEqual([{ target: "coordinator", kind: "strong" }]);
    expect(p.orchestration.scopedWorkflow!.groups[0].leaderAgentId).toBe("coordinator");
    expect(p.agents!.coordinator.sessionPersistence).toBe(false);
    expect(p.agents!.coordinator.instructions).toContain("first root Worker");
    expect(entry("R03").payload.agents.implementer.sessionPersistence).toBe(false);
  });
  it("R10 assigns four actual weak branches to all required decision owners", () => {
    const { entry: e, document, parse } = proposalFor("R10"), a = parse(applyPlannedEdits(document, e));
    expect(a.agents.child_gate.decisionBy).toBe("agent");
    expect(a.agents.parent_gate.decisionBy).toBe("main");
    const gs = a.orchestration.scopedWorkflow!.groups;
    expect(gs.find((g) => g.id === "G_child")!.decisionBy).toBe("agent");
    expect(gs.find((g) => g.id === "G_child_parent")!.decisionBy).toBe("main");
    for (const [g, n] of [["G_child", "child_gate"], ["G_parent", "parent_gate"], ["G_parent", "G_parent_G_child"], ["G_parent", "parent_second_child"]]) {
      const routes = gs.find((v) => v.id === g)!.workflow.routes[n!];
      expect(routes).toHaveLength(2);
      expect(routes.every((edge) => edge.kind === "weak")).toBe(true);
    }
  });
  it("R15 adds absent resources, preserves omissions and rejects mutation/deletion", () => {
    const { entry: e, project: p, document: d, parse } = proposalFor("R15");
    expect(p.mcpDefinitions!["r15-new-sum"]).toBeUndefined();
    const a = parse(applyPlannedEdits(structuredClone(d), e));
    expect(a.agents.implementer.mcpServers).toContainEqual({ name: "r15-new-sum", project: "r15-new-sum" });
    expect(mcpRevision(a.mcpDefinitions!["r15-protected-old"])).toBe(mcpRevision(p.mcpDefinitions!["r15-protected-old"]));
    expect(skillRevision(a.skillDefinitions!["r15-protected-old"])).toBe(skillRevision(p.skillDefinitions!["r15-protected-old"]));
    const omit = applyPlannedEdits(structuredClone(d), e);
    delete omit.mcpDefinitions["r15-protected-old"]; delete omit.skillDefinitions["r15-protected-old"];
    expect(parse(omit).mcpDefinitions).toEqual(a.mcpDefinitions);
    for (const change of ["source", "config", "delete"]) {
      const invalid = applyPlannedEdits(structuredClone(d), e);
      if (change === "source") invalid.mcpDefinitions["r15-protected-old"].files["server.cjs"] += "\n// changed";
      if (change === "config") invalid.mcpDefinitions["r15-protected-old"].args = ["--changed"];
      if (change === "delete") invalid.mcpDefinitions["r15-protected-old"] = null;
      expect(() => parse(invalid)).toThrow();
      expect(p.mcpDefinitions!["r15-new-sum"]).toBeUndefined();
    }
    const next = mainAgentOrchestrationDocument("R15", a.orchestration, a.agents, a.skillDefinitions, a.mcpDefinitions);
    next.mcpDefinitions["r15-new-sum"].files["server.cjs"] += "\n// immutable too";
    expect(() => parseAgentOrchestrationProposal(JSON.stringify(next), "R15", a.orchestration, a.agents, { skillDefinitions: a.skillDefinitions, mcpDefinitions: a.mcpDefinitions })).toThrow(/immutable/);
  });
  it("R16 expects numeric count 3/sum 6 and leaves browser observation pending", () => {
    const e = entry("R16"), values = e.input.rows.map((v: string) => Number(v.trim()));
    expect({ count: values.length, sum: values.reduce((a: number, b: number) => a+b, 0) }).toEqual(e.expected);
    expect(e.pending).toContain("browser observer available");
  });
  it("R09 rejects an unchanged second proposal and R15 permits formatting/reference-only edits", () => {
    for (const code of ["R09", "R15"]) {
      const { entry: e, document, parse } = proposalFor(code);
      const a = parse(applyPlannedEdits(document, e));
      const next = mainAgentOrchestrationDocument(code, a.orchestration, a.agents, a.skillDefinitions, a.mcpDefinitions);
      const parseNext = () => parseAgentOrchestrationProposal(JSON.stringify(next, null, 4), code, a.orchestration, a.agents, { skillDefinitions: a.skillDefinitions, mcpDefinitions: a.mcpDefinitions });
      expect(() => parseNext()).toThrow(/does not contain a configuration change/);
      if (code === "R15") {
        next.agents.checker.skills = ["project:r15-new-sum"];
        const referencesOnly = parseNext();
        expect(referencesOnly.skillDefinitions).toEqual(a.skillDefinitions);
        expect(referencesOnly.mcpDefinitions).toEqual(a.mcpDefinitions);
      }
    }
  });
  it("the real Node check tool reports failing assertions instead of inventing success", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "r-node-check-"));
    await fs.writeFile(path.join(root, "check.mjs"), "import assert from 'node:assert/strict'; assert.equal(1+2+3,7);\n");
    const lease = await startProjectMcps({ definitions: entry("R05").payload.mcpDefinitions,
      servers: [{ name: PROJECT_MCP_NAME, project: PROJECT_MCP_NAME }], projectPath: path.join(root, "project"),
      workspacePath: root, runtimePath: path.join(root, "runtime"), signal: new AbortController().signal });
    const client = new Client({ name: "catalog-test", version: "1" }, { capabilities: {} });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(lease.servers[0].url!)));
      const result = await client.callTool({ name: "run_node", arguments: { file: "check.mjs" } });
      expect(result.isError).toBe(true);
      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.exitCode).toBe(1);
      expect(data.stderr).toContain("AssertionError");
      await fs.writeFile(path.join(root, "check.mjs"), "import assert from 'node:assert/strict'; assert.equal(1+2+3,6);\n");
      expect((await client.callTool({ name: "run_node", arguments: { file: "check.mjs" } })).isError).toBe(false);
      await fs.writeFile(path.join(root,"partial.json"),JSON.stringify({group:"G_parent",round:2,partial:true,sourceGroup:"G_left",result:{sum:3}}));
      const contribution = await client.callTool({name:"verify_file",arguments:{file:"partial.json",group:"G_parent",round:2,sourceGroup:"G_left"}});
      expect(contribution.isError).toBe(false);
      expect(JSON.parse((contribution.content as Array<{text:string}>)[0].text).coverage).toBe("contribution");
      expect((await client.callTool({name:"verify_file",arguments:{file:"partial.json",group:"G_parent",round:2}})).isError).toBe(true);
    } finally { await client.close(); await lease.close(); await fs.rm(root, { recursive: true, force: true }); }
  }, 15_000);
  it("runs real protected/new MCPs and verifies review data without creating source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "r-catalog-mcp-")), workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "review.json"), JSON.stringify({ group: "G_child", round: 1, result: { sum: 5 } }));
    const defs = { ...entry("R02").payload.mcpDefinitions, "r15-protected-old": entry("R15").payload.mcpDefinitions["r15-protected-old"], ...newResources.mcpDefinitions };
    const lease = await startProjectMcps({ definitions: defs, servers: Object.keys(defs).map((name) => ({ name, project: name })), projectPath: path.join(root, "project"), workspacePath: workspace, runtimePath: path.join(root, "runtime"), signal: new AbortController().signal });
    try {
      for (const server of lease.servers) {
        const client = new Client({ name: "catalog-test", version: "1" }, { capabilities: {} });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(server.url!)));
          if (server.name === PROJECT_MCP_NAME) {
            const good = await client.callTool({ name: "verify_file", arguments: { file: "review.json", group: "G_child", round: 1 } });
            expect(good.isError).toBe(false);
            expect(JSON.parse((good.content as Array<{ text: string }>)[0].text).exitCode).toBe(0);
            expect((await client.callTool({ name: "verify_file", arguments: { file: "review.json", group: "G_child", round: 2 } })).isError).toBe(true);
            await fs.writeFile(path.join(workspace, "review.json"), JSON.stringify({ group: "G_child", round: 1, result: { all: { sum: 5 } } }));
            const wrapped = await client.callTool({ name: "verify_file", arguments: { file: "review.json", group: "G_child", round: 1 } });
            expect(wrapped.isError).toBe(true);
            expect(JSON.parse((wrapped.content as Array<{ text: string }>)[0].text)).toMatchObject({
              expected: { sum: 5 }, actual: { all: { sum: 5 } }, exitCode: 1
            });
          } else if (server.name === "r15-new-sum") {
            const result = await client.callTool({ name: "sum_values", arguments: { values: [4, 5, 6] } });
            expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({ sum: 15 });
          } else expect((await client.callTool({ name: "ping", arguments: {} })).isError).not.toBe(true);
        } finally { await client.close(); }
      }
      expect(await fs.readdir(workspace)).toEqual(["review.json"]);
    } finally { await lease.close(); await fs.rm(root, { recursive: true, force: true }); }
  }, 20_000);
});
