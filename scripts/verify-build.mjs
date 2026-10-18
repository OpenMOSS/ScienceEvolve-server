import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// The running server reads web/dist on every request. Verification must build
// a source snapshot, never overwrite the files of that running service.
const repo = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
const git = async (...args) => (await exec("git", args, { cwd: repo, maxBuffer: 8 * 1024 * 1024 })).stdout;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function tree(directory) {
  const files = {};
  async function visit(current, relative = "") {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name), file = path.join(current, entry.name);
      assert.ok(!entry.isSymbolicLink(), `Build artifact must not be a symlink: ${file}`);
      if (entry.isDirectory()) await visit(file, name);
      else if (entry.isFile()) files[name] = hash(await fs.readFile(file));
    }
  }
  try { await visit(directory); }
  catch (error) { if (error.code !== "ENOENT") throw error; return null; }
  return files;
}
await fs.mkdir(path.join(repo, "temp", "build-checks"), { recursive: true });
const directory = await fs.mkdtemp(path.join(repo, "temp", "build-checks", "check-"));
const source = path.join(directory, "source");
await fs.mkdir(source);
const before = { web: await tree(path.join(repo, "web/dist")), server: await tree(path.join(repo, "server/dist")) };
const commit = (await git("rev-parse", "HEAD")).trim();
const status = await git("status", "--porcelain");
const sourceHashes = {};
for (const name of (await git("ls-files", "--cached", "-z")).split("\0").filter(Boolean)) {
  const input = path.join(repo, name), output = path.join(source, name);
  let stat;
  try { stat = await fs.lstat(input); }
  catch (error) { if (error.code === "ENOENT") continue; throw error; }
  assert.ok(stat.isFile(), `Build source must be a regular tracked file: ${name}`);
  const bytes = await fs.readFile(input);
  sourceHashes[name] = hash(bytes);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, bytes, { mode: stat.mode & 0o777 });
}
// Reuse installed packages but keep .tmp/.vite-temp and other build caches in
// the snapshot. Linking the whole node_modules directory would leak writes.
for (const workspace of ["", "server", "web"]) {
  const installed = path.join(repo, workspace, "node_modules");
  const destination = path.join(source, workspace, "node_modules");
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(installed).catch((error) => {
    if (error.code === "ENOENT") return []; throw error;
  });
  for (const name of entries.filter((name) => !name.startsWith(".") || name === ".bin")) {
    await fs.symlink(path.join(installed, name), path.join(destination, name));
  }
}
console.log(`Isolated npm run build: ${directory}`);
const log = await fs.open(path.join(directory, "build.log"), "wx", 0o600);
let exitCode;
try {
  const child = spawn("npm", ["run", "build"], { cwd: source, stdio: ["ignore", log.fd, log.fd] });
  exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally { await log.close(); }
const after = { web: await tree(path.join(repo, "web/dist")), server: await tree(path.join(repo, "server/dist")) };
const artifacts = { web: await tree(path.join(source, "web/dist")), server: await tree(path.join(source, "server/dist")) };
const receipt = { command: "npm run build", commit, status, directory, checkedAt: new Date().toISOString(),
  exitCode, sourceHashes, artifacts, originalArtifactsBefore: before, originalArtifactsAfter: after,
  log: { path: "build.log", sha256: hash(await fs.readFile(path.join(directory, "build.log"))) } };
await fs.writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
assert.deepEqual(after, before, "Original build artifacts changed during verification; inspect receipt.json");
assert.equal(exitCode, 0, `Isolated build failed; read ${path.join(directory, "build.log")}`);
assert.ok(artifacts.web?.["index.html"] && artifacts.server?.["src/index.js"], "Build outputs are missing");
console.log(`Build passed; original web/dist and server/dist hashes preserved. Receipt: ${path.join(directory, "receipt.json")}`);
