#!/usr/bin/env node
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

// Optional, manual conversion for the existing generic Web JSON importer.
// Neither the Server nor the frontend imports or executes this script.
const [sourceArgument, outputArgument, ...extra] = process.argv.slice(2);
if (!sourceArgument || !outputArgument || extra.length) {
  console.error("Usage: node example/export-web-workflow.mjs <workflow.json> <output.web.json>");
  process.exitCode = 1;
} else {
  try {
    const source = await realpath(sourceArgument);
    const output = path.resolve(outputArgument);
    if (source === output) throw new Error("Choose a separate output file; the original workflow must be preserved.");
    const workflow = JSON.parse((await readFile(source, "utf8")).replace(/^\uFEFF/, ""));
    if (!workflow.agents || !workflow.orchestration) throw new Error("Expected agents and orchestration in the source workflow.");
    const directory = path.dirname(source);
    const agents = {};
    for (const [name, configuration] of Object.entries(workflow.agents)) {
      const { proxy: _proxy, gatewaySource: _gatewaySource, gatewayId: _gatewayId, ...agent } = configuration;
      for (const field of ["skills", "autoSkills"]) {
        if (!Array.isArray(agent[field])) continue;
        agent[field] = await Promise.all(agent[field].map(async (selection) => {
          if (!selection.startsWith("./skills/")) return selection;
          const candidate = path.resolve(directory, selection);
          const skill = await realpath(path.basename(candidate).toLowerCase() === "skill.md" ? candidate : path.join(candidate, "SKILL.md"));
          const relative = path.relative(directory, skill);
          if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Skill escapes the example directory: ${selection}`);
          return skill;
        }));
      }
      agents[name] = agent;
    }
    const document = {
      schemaVersion: 2,
      name: workflow.name || path.basename(directory),
      agents,
      orchestration: {
        ...workflow.orchestration,
        schemaVersion: workflow.orchestration.schemaVersion ?? 2,
        collaborations: workflow.orchestration.collaborations ?? []
      },
      ...(workflow.skillDefinitions ? { skillDefinitions: workflow.skillDefinitions } : {}),
      ...(workflow.mcpDefinitions ? { mcpDefinitions: workflow.mcpDefinitions } : {})
    };
    // Git account settings are configured separately in the Web project form.
    await writeFile(output, JSON.stringify(document, null, 2) + "\n", { flag: "wx" });
    console.log(`Created ${output}`);
    console.log(`Git collaboration in the source: ${workflow.git?.enabled ? "enabled; configure a Web GitHub account before starting" : "disabled"}.`);
    console.log("Import this file on the Web homepage. Paste requirement.txt separately and configure each Agent's gateway/model.");
    console.log("Skill paths refer to this machine; re-export on the Server host if using another computer.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
