import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { buildManifest, applyPlannedEdits, sha256 } from "./catalog.mjs";
import { createProjectSchema, mergeAgentConfigs } from "../../server/dist/src/validation.js";
import { mainAgentOrchestrationDocument, parseAgentOrchestrationProposal } from "../../server/dist/src/agent-orchestration-reconfiguration.js";
import { skillRevision, validateProjectSkillReferences } from "../../server/dist/src/project-skills.js";
import { mcpRevision, validateProjectMcpReferences } from "../../server/dist/src/project-mcp.js";
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (!args.includes("--binding") || !args.includes("--output")) throw Error("Usage: validate.mjs --binding <observed-runtime.json> --output <stable-run-directory>");
const binding = JSON.parse(await fs.readFile(value("--binding"), "utf8"));
const directory = path.resolve(value("--output"));
const manifest = buildManifest(binding);
const results = [];
for (const entry of manifest.cases) {
  const parsed = createProjectSchema.parse(entry.payload);
  const agents = mergeAgentConfigs(parsed.agents, parsed.orchestration);
  validateProjectSkillReferences(agents, parsed.skillDefinitions);
  validateProjectMcpReferences(agents, parsed.mcpDefinitions);
  const id = `r-projects-${entry.code.toLowerCase()}`;
  const proposal = applyPlannedEdits(mainAgentOrchestrationDocument(id, parsed.orchestration, agents, parsed.skillDefinitions, parsed.mcpDefinitions), entry);
  const accepted = parseAgentOrchestrationProposal(JSON.stringify(proposal), id, parsed.orchestration, agents, { skillDefinitions: parsed.skillDefinitions, mcpDefinitions: parsed.mcpDefinitions });
  for (const group of accepted.orchestration.scopedWorkflow.groups) for (const loop of group.workflow.loops ?? []) assert.equal(loop.maxIterations, 2, `${entry.code}/${loop.id}`);
  validateProjectSkillReferences(accepted.agents, accepted.skillDefinitions);
  validateProjectMcpReferences(accepted.agents, accepted.mcpDefinitions);
  entry.payload = parsed;
  entry.payloadSha256 = sha256(parsed);
  entry.resourceHashes = {
    skills: Object.fromEntries(Object.entries(parsed.skillDefinitions).map(([name, def]) => [name, skillRevision(def)])),
    mcps: Object.fromEntries(Object.entries(parsed.mcpDefinitions).map(([name, def]) => [name, mcpRevision(def)]))
  };
  const groups = parsed.orchestration.scopedWorkflow.groups;
  const depth = (g) => g.parentGroupId ? 1 + depth(groups.find((p) => p.id === g.parentGroupId)) : 1;
  results.push({ code: entry.code, schemaAndProposalValid: true, payloadSha256: entry.payloadSha256,
    groupDepth: Math.max(...groups.map(depth)), loops: groups.flatMap((g) => (g.workflow.loops ?? []).map((loop) => ({ groupId: g.id, ...loop, acceptedMaxIterations: 2 }))),
    resourceHashes: entry.resourceHashes, launchReady: entry.launchReady, pending: entry.pending });
}
await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2)+"\n");
await fs.writeFile(path.join(directory, "validation-report.json"), JSON.stringify({ schemaVersion: 2, generatedAt: new Date().toISOString(),
  scope: "Offline payload/schema and authorized Main proposal parsing only; no live runtime, fault injection or project completion claim.",
  manifestSha256: sha256(manifest), cases: results }, null, 2)+"\n");
console.log(JSON.stringify({ directory, validated: results.length, launchReady: 0 }));
