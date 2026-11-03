import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const serverRoot = path.dirname(fileURLToPath(import.meta.url));
const distOption = process.argv.indexOf("--dist");
const distRoot = distOption < 0 ? path.join(serverRoot, "dist") : path.resolve(process.argv[distOption + 1]);
// Source tests execute the TypeScript bridge; deployed Agents execute its JS.
// Validate both independently reviewed pins before a build can be deployed.
// Never regenerate a trusted pin from the very artifact it must validate.
const { DESCRIPTOR_BROKER_MCP_SHA256, DESCRIPTOR_BROKER_MCP_COMPILED_SHA256 } =
  await import(pathToFileURL(path.join(distRoot, "src/harness-runtime/filesystem-authority.js")).href);
for (const [relativePath, expected] of [
  ["src/harness-runtime/descriptor-broker-mcp.ts", DESCRIPTOR_BROKER_MCP_SHA256],
  ["dist/src/harness-runtime/descriptor-broker-mcp.js", DESCRIPTOR_BROKER_MCP_COMPILED_SHA256]
]) {
  const actual = createHash("sha256").update(await readFile(relativePath.startsWith("dist/") ? path.join(distRoot, relativePath.slice(5)) : path.join(serverRoot, relativePath))).digest("hex");
  assert.equal(actual, expected, `${relativePath} differs from its reviewed runtime pin`);
}
const assets = [
  {
    source: path.join(serverRoot, "src", "harness-runtime", "windows-apply-patch.cs"),
    destination: path.join(distRoot, "src", "harness-runtime", "windows-apply-patch.cs"),
    mode: 0o644
  },
  {
    source: path.join(serverRoot, "src", "harness-runtime", "descriptor-broker-windows.py"),
    destination: path.join(distRoot, "src", "harness-runtime", "descriptor-broker-windows.py"),
    mode: 0o644
  },
  {
    source: path.join(serverRoot, "src", "harness-runtime", "windows-resident-helper.py"),
    destination: path.join(distRoot, "src", "harness-runtime", "windows-resident-helper.py"),
    mode: 0o644
  },
  {
    source: path.join(serverRoot, "src", "harness-runtime", "dsh-sdk-resume-plugin.mjs"),
    destination: path.join(distRoot, "src", "harness-runtime", "dsh-sdk-resume-plugin.mjs"),
    mode: 0o644
  },
  {
    source: path.join(serverRoot, "src", "harness-runtime", "descriptor-broker-helper.py"),
    destination: path.join(
      distRoot,
      "src",
      "harness-runtime",
      "descriptor-broker-helper.py"
    ),
    mode: 0o644
  }
];

for (const asset of assets) {
  await mkdir(path.dirname(asset.destination), { recursive: true });
  await copyFile(asset.source, asset.destination);
  await chmod(asset.destination, asset.mode);
}

async function compiledFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await compiledFiles(file));
    else if (entry.isFile() && /\.(?:js|mjs|py|cs)$/.test(entry.name)) files.push(file);
  }
  return files.sort();
}
const digest = createHash("sha256");
for (const file of await compiledFiles(distRoot)) digest.update(path.relative(distRoot, file)).update("\0").update(await readFile(file));
await writeFile(path.join(distRoot, "build-info.json"), JSON.stringify({ buildId: digest.digest("hex"), builtAt: new Date().toISOString() }) + "\n");
