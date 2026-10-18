import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CommonProcessHost, buildInvocationEnvironment } from "../src/harness-runtime/process-host.js";
import { InvocationRecoveryController } from "../src/harness-runtime/invocation-recovery.js";
import { controlWindowsResident, protectWindowsRuntimeFile, readWindowsProcessIdentity, windowsExecutable,
  windowsRuntimeFileIsPrivate } from "../src/harness-runtime/windows-resident.js";
import { resolveResidentControlProxyCommand } from "../src/harness-runtime/runtime-support.js";
import { compileFilesystemAuthority, DescriptorFilesystemBroker, prepareFilesystemAuthorityMcp } from "../src/harness-runtime/filesystem-authority.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const absolute = path.resolve(root);
    if (!absolute.startsWith(path.join(os.tmpdir(), "openfars-windows-"))) throw new Error("Refusing cleanup outside fixture root");
    await fs.rm(absolute, { recursive: true, force: true });
  }
});

describe.runIf(process.platform === "win32")("Windows resident authority", () => {
  it("loads the real control MCP with a private Windows DACL", async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"openfars-windows-"));roots.push(root);
    const server=createServer(socket=>{
      let input="";socket.on("data",chunk=>{
        input+=chunk.toString();if(!input.includes("\n"))return;
        const call=JSON.parse(input.split("\n")[0]!);
        socket.end(JSON.stringify({ok:true,response:{jsonrpc:"2.0",id:call.request.id,result:{tools:[{name:"assign_group_tasks"}]}}})+"\n");
      });
    });
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const address=server.address();if(!address || typeof address==="string")throw new Error("Missing test server address");
    const configFile=path.join(root,"control.json");await fs.writeFile(configFile,JSON.stringify({schemaVersion:1,host:"127.0.0.1",port:address.port,token:"fixture-token"}));
    await protectWindowsRuntimeFile(configFile);expect(await windowsRuntimeFileIsPrivate(configFile)).toBe(true);
    const command=await resolveResidentControlProxyCommand();
    const child=spawn(command.command,[...command.args,configFile],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
    let output="",stderr="";child.stdout.on("data",chunk=>output+=chunk.toString());child.stderr.on("data",chunk=>stderr+=chunk.toString());
    try {
      child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})+"\n");
      await expect.poll(()=>output,{timeout:5000,message:stderr}).toContain("assign_group_tasks");
      expect(JSON.parse(output.trim()).result.tools[0].name).toBe("assign_group_tasks");
    }finally{
      child.kill();await new Promise(resolve=>child.once("close",resolve));await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  },15000);

  async function resident() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-windows-")); roots.push(root);
    const runtimePath = path.join(root, "runtime"); await fs.mkdir(runtimePath);
    const authority = { projectId: "windows-fixture", harnessId: "fixture", scopeId: "group-fixture", role: "leader" as const, coordinatorEpoch: 1 };
    const env = buildInvocationEnvironment({ common: { SCIENCEEVOLVE_PROJECT_ID: authority.projectId,
      SCIENCEEVOLVE_AGENT_HARNESS: authority.harnessId, SCIENCEEVOLVE_RESIDENT_SCOPE_ID: authority.scopeId,
      SCIENCEEVOLVE_GATEWAY_API_KEY: "fixture-route",
      SCIENCEEVOLVE_RESIDENT_ROLE: "leader", SCIENCEEVOLVE_COORDINATOR_EPOCH: "1", SCIENCEEVOLVE_ROLE_WORKSPACE: root } });
    const session = { schemaVersion: 1 as const, harnessId: "fixture", adapterVersion: "test", generation: 0,
      nativeId: "windows-fixture-session", durable: true, createdAt: new Date().toISOString() };
    const host = new CommonProcessHost();
    let output = "";
    const managed = await host.startResident({ scopeId: authority.scopeId, role: "leader", harnessId: "fixture",
      runtimePath, workspacePath: root, signal: new AbortController().signal,
      recoveryBudget: new InvocationRecoveryController(2), session: () => session,
      route: { baseUrl: "http://127.0.0.1:1234/v1", token: "fixture-route" },
      commonEnvironment: env, authorityEnvironment: env }, {
        command: process.execPath, args: ["-e", "require('node:readline').createInterface({input:process.stdin}).on('line',x=>process.stdout.write(x+'\\n'));setInterval(()=>{},1000)"],
        cwd: root, env, eventFormat: "jsonl", session, rawLogLimitBytes: 4096
      }, { onStdout: (chunk) => { output += chunk; } });
    const identity = await readWindowsProcessIdentity(managed.child.pid!);
    return { host, authority, runtimePath, managed, identity, output: () => output };
  }

  it("controls the native job, retains paused work, and cleans up all members", async () => {
    const fixture = await resident();
    try {
      expect((await controlWindowsResident(fixture.identity, "probe")).members.length).toBeGreaterThanOrEqual(2);
      await controlWindowsResident(fixture.identity, "pause");
      await fixture.managed.write("sentinel\n");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fixture.output()).not.toContain("sentinel");
      await controlWindowsResident(fixture.identity, "resume");
      await expect.poll(fixture.output, { timeout: 2000 }).toContain("sentinel");
      await fixture.host.cleanupResidentInterrupted(fixture.authority, fixture.runtimePath);
      expect((await controlWindowsResident(fixture.identity, "probe")).alive).toBe(false);
    } finally { fixture.managed.terminate(); await fixture.managed.waitForQuiescence(); await fixture.managed.completed; }
  }, 15000);

  it("acknowledges concurrent resident launches with separate job identities", async () => {
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => resident()));
    const opened = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    try {
      expect(results.filter(result => result.status === "rejected")).toEqual([]);
      expect(new Set(opened.map(fixture => fixture.identity.windowsJobName)).size).toBe(4);
      for (const fixture of opened) expect((await controlWindowsResident(fixture.identity, "probe")).alive).toBe(true);
    } finally {
      await Promise.all(opened.map(async fixture => {
        fixture.managed.terminate(); await fixture.managed.waitForQuiescence(); await fixture.managed.completed;
      }));
    }
  }, 15000);

  it("refuses a stale creation identity without killing the adjacent valid job", async () => {
    const fixture = await resident();
    try {
      await expect(controlWindowsResident({ ...fixture.identity, startTicks: "1" }, "terminate")).rejects.toThrow();
      expect((await controlWindowsResident(fixture.identity, "probe")).alive).toBe(true);
    } finally { fixture.managed.terminate(); await fixture.managed.waitForQuiescence(); await fixture.managed.completed; }
  }, 15000);

  it("kills inherited descendants when the supervisor is forcibly terminated", async () => {
    const fixture = await resident();
    const members = (await controlWindowsResident(fixture.identity, "probe")).members;
    fixture.managed.child.kill("SIGKILL"); await fixture.managed.completed;
    for (const pid of members) await expect.poll(async () => {
      try { await readWindowsProcessIdentity(pid); return true; } catch { return false; }
    }, { timeout: 3000 }).toBe(false);
  }, 15000);

  it("stages the pinned filesystem MCP and denies junctions, aliases, ADS and read-only writes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-windows-")); roots.push(root);
    const home=path.join(root,"home"), workspace=path.join(root,"workspace"), runtime=path.join(root,"runtime");
    await Promise.all([home,workspace,runtime].map(directory=>fs.mkdir(directory)));
    const memory=path.join(workspace,"Memory.md");await fs.writeFile(memory,"");await fs.writeFile(path.join(home,"read.txt"),"read");
    const authority=await compileFilesystemAuthority({ permission:"workspace", role:"delivery", gitEnabled:false,
      serviceUserRoot:home,executionWorktree:workspace,ownedMemoryPath:memory,protectedRoots:[] });
    const prepared=await prepareFilesystemAuthorityMcp({authority,executionRuntimePath:runtime});
    const config=JSON.parse(await fs.readFile(prepared.configPath,"utf8"));
    const broker=await DescriptorFilesystemBroker.open({authority,helperPath:config.helperPath,pythonExecutable:await windowsExecutable("python.exe")});
    try {
      const reader=authority.rootBindings.find(row=>row.path===home)!;const writer=authority.rootBindings.find(row=>row.write)!;
      expect((await broker.read(reader.id,"read.txt")).content.toString()).toBe("read");
      const page = await broker.readPage(reader.id,"read.txt",0,2);
      expect(page).toMatchObject({bytes:2,nextOffset:2,totalBytes:4,eof:false});
      expect((await broker.readPage(reader.id,"read.txt",page.nextOffset,2,page.version)).content.toString()).toBe("ad");
      await broker.makeDirectory(writer.id,"nested");await broker.writeAtomic(writer.id,"nested/result.txt",Buffer.from("written"));
      expect((await broker.read(writer.id,"nested/result.txt")).content.toString()).toBe("written");
      expect((await broker.listDirectory(writer.id,"nested")).entries[0]?.name).toBe("result.txt");
      await expect(broker.writeAtomic(reader.id,"read.txt",Buffer.from("illegal"))).rejects.toThrow();
      for (const candidate of ["../read.txt","read.txt:ads","NUL",".GIT/config","alias~1/file"]) await expect(broker.read(reader.id,candidate)).rejects.toThrow();
      await fs.symlink(home,path.join(workspace,"junction"),"junction");
      await expect(broker.read(writer.id,"junction/read.txt")).rejects.toThrow();
      await fs.link(path.join(home,"read.txt"),path.join(workspace,"hard.txt"));
      await expect(broker.writeAtomic(writer.id,"hard.txt",Buffer.from("illegal"))).rejects.toThrow();
      expect((await broker.matrix()).primitive).toBe("win32-pinned-handles");
    } finally {await broker.close();}
  },15000);
});
