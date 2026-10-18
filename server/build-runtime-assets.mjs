import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.dirname(fileURLToPath(import.meta.url));
// Source tests execute the TypeScript bridge; deployed Agents execute its JS.
// Validate both independently reviewed pins before a build can be deployed.
// Never regenerate a trusted pin from the very artifact it must validate.
const { DESCRIPTOR_BROKER_MCP_SHA256, DESCRIPTOR_BROKER_MCP_COMPILED_SHA256 } =
  await import("./dist/src/harness-runtime/filesystem-authority.js");
for (const [relativePath, expected] of [
  ["src/harness-runtime/descriptor-broker-mcp.ts", DESCRIPTOR_BROKER_MCP_SHA256],
  ["dist/src/harness-runtime/descriptor-broker-mcp.js", DESCRIPTOR_BROKER_MCP_COMPILED_SHA256]
]) {
  const actual = createHash("sha256").update(await readFile(path.join(serverRoot, relativePath))).digest("hex");
  assert.equal(actual, expected, `${relativePath} differs from its reviewed runtime pin`);
}
const assets = [
  {
    source: path.join(serverRoot, "src", "harness-runtime", "windows-apply-patch.cs"),
    destination: path.join(serverRoot, "dist", "src", "harness-runtime", "windows-apply-patch.cs"),
    mode: 0o644
  },
  {
    source: path.join(serverRoot, "src", "harness-runtime", "descriptor-broker-windows.py"),
    destination: path.join(serverRoot, "dist", "src", "harness-runtime", "descriptor-broker-windows.py"),
    mode: 0o644
  },
  {
    source: path.join(serverRoot, "src", "harness-runtime", "windows-resident-helper.py"),
    destination: path.join(serverRoot, "dist", "src", "harness-runtime", "windows-resident-helper.py"),
    mode: 0o644
  },
  {
    source: path.join(serverRoot, "src", "harness-runtime", "dsh-sdk-resume-plugin.mjs"),
    destination: path.join(serverRoot, "dist", "src", "harness-runtime", "dsh-sdk-resume-plugin.mjs"),
    mode: 0o644
  },
  {
    source: path.join(serverRoot, "src", "harness-runtime", "descriptor-broker-helper.py"),
    destination: path.join(
      serverRoot,
      "dist",
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
