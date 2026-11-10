import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const exec = promisify(execFile);
const launcher = fileURLToPath(new URL("../../scripts/run-in-cpu-group.sh", import.meta.url));
it("fails before executing a command when its delegated group is unavailable", async () => {
  await expect(exec("bash", [launcher, "/missing-cpu-group", "echo", "must-not-run"]))
    .rejects.toMatchObject({ code: 78, stdout: "" });
});
it("registers its own PID and preserves command arguments before exec", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cpu-group-launch-"));
  try {
    await fs.writeFile(path.join(root, "cpu.max"), "200000 100000"); await fs.writeFile(path.join(root, "cgroup.procs"), "");
    const r = await exec("bash", [launcher, root, process.execPath, "-e", "process.stdout.write(JSON.stringify({pid:process.pid,args:process.argv.slice(1)}))", "argument with spaces"]);
    const result = JSON.parse(r.stdout);
    expect(Number((await fs.readFile(path.join(root, "cgroup.procs"), "utf8")).trim())).toBe(result.pid);
    expect(result.args).toEqual(["argument with spaces"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
