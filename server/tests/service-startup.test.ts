import {execFile} from "node:child_process";
import {promises as fs} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {afterEach, expect, it} from "vitest";

const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const roots: string[] = [];
const processes: number[] = [];

afterEach(async () => {
  for (const pid of processes.splice(0)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* Fixture already exited. */ }
  }
  await Promise.all(roots.splice(0).map(root => fs.rm(root, {recursive:true, force:true})));
});

async function fixture(delayMs: number, fatal = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-startup-"));
  roots.push(root);
  for (const directory of ["scripts", ".runtime/node/bin", ".runtime/codex/node_modules/.bin", "server/dist/src"]) {
    await fs.mkdir(path.join(root, directory), {recursive:true});
  }
  for (const name of ["start-openfars.sh", "check-service-process.mjs"]) {
    await fs.copyFile(path.join(repository, "scripts", name), path.join(root, "scripts", name));
  }
  await fs.symlink(process.execPath, path.join(root, ".runtime/node/bin/node"));
  await fs.writeFile(path.join(root, ".runtime/codex/node_modules/.bin/codex"), "#!/bin/sh\nexit 0\n", {mode:0o700});
  await fs.writeFile(path.join(root, ".env"), "");
  const portServer = http.createServer();
  await new Promise<void>(resolve => portServer.listen(0, "127.0.0.1", resolve));
  const port = (portServer.address() as {port:number}).port;
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const entry = fatal ? "process.stderr.write('fixture startup failure\\n');process.exit(17);"
    : `const http=require('node:http');setTimeout(()=>http.createServer((req,res)=>res.end(JSON.stringify({pid:process.pid}))).listen(process.env.PORT,'127.0.0.1'),${delayMs});`;
  await fs.writeFile(path.join(root, "server/dist/src/index.js"), entry);
  const pidFile = path.join(root, ".runtime/state/openfars.pid");
  const start = async () => {
    try {
      const result = await exec("bash", [path.join(root, "scripts/start-openfars.sh")], {
        cwd:root, env:{...process.env, PORT:String(port), OPENFARS_FOREGROUND:"0", OPENFARS_STARTUP_TIMEOUT_SECONDS:"1"}, timeout:15_000
      });
      return {code:0, output:result.stdout+result.stderr};
    } catch (error) {
      const failure = error as {code:number;stdout:string;stderr:string};
      return {code:failure.code, output:failure.stdout+failure.stderr};
    } finally {
      const pid = Number(await fs.readFile(pidFile, "utf8").catch(() => ""));
      if (pid > 1 && !processes.includes(pid)) processes.push(pid);
    }
  };
  const retainPid = async () => {
    const pid = Number((await fs.readFile(pidFile, "utf8")).trim());
    processes.push(pid);
    return pid;
  };
  const ready = async () => {
    const deadline = Date.now()+10_000;
    while (Date.now()<deadline) {
      try { return await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as {pid:number}; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    throw new Error("Fixture did not become ready");
  };
  return {start, retainPid, ready, pidFile};
}

it.runIf(process.platform === "linux")("retains a delayed startup and observes the same service on another start", async () => {
  const f = await fixture(4500);
  expect((await f.start()).code).toBe(2);
  const pid = await f.retainPid();
  expect((await f.start()).code).toBe(2);
  expect(Number((await fs.readFile(f.pidFile, "utf8")).trim())).toBe(pid);
  expect((await f.ready()).pid).toBe(pid);
  expect((await f.start()).code).toBe(0);
  expect((await f.ready()).pid).toBe(pid);
}, 20_000);

it.runIf(process.platform === "linux")("reports and removes an actually exited startup", async () => {
  const f = await fixture(0, true);
  const result = await f.start();
  expect(result.code).toBe(1);
  expect(result.output).toContain("fixture startup failure");
  await expect(fs.stat(f.pidFile)).rejects.toMatchObject({code:"ENOENT"});
});

it.runIf(process.platform === "linux")("keeps an immediately healthy background service alive after the launcher exits", async () => {
  const f = await fixture(0);
  expect((await f.start()).code).toBe(0);
  const pid = await f.retainPid();
  expect((await f.ready()).pid).toBe(pid);
  expect((await f.start()).code).toBe(0);
  expect((await f.ready()).pid).toBe(pid);
});
