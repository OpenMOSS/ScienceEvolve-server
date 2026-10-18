import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("production collaboration dispatcher rejection", () => {
  it.each(["trace", "official"])("returns the original %s write failure without a detached process-fatal rejection", async mode => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-dispatcher-rejection-"));
    directories.push(directory);
    const script = path.join(directory, "fixture.mjs");
    await fs.writeFile(script, `
      import assert from 'node:assert/strict';
      const {ProductionCollaborationInvocationDispatcher}=await import(process.argv[2]);
      const mode=process.argv[3];
      const original=new Error('Collaboration writer lease was lost');
      let writes=0, caughtOriginal=false;
      const storage={
        appendTrace:async()=>{},
        appendEvent:async()=>{writes+=1;if(writes===1)throw original;},
        hub:{publishHarnessEvent(){}}
      };
      const dispatcher=new ProductionCollaborationInvocationDispatcher(storage);
      const state={id:'prj_fixture'};
      const request={agent:'worker',invocationId:'inv_fixture'};
      dispatcher.decorate({state,request});
      const trace=dispatcher.trace({state,agentId:'worker',invocationId:'inv_fixture'});
      const call=()=>mode==='trace'
        ? trace('stderr','safe fixture diagnostic')
        : request.onOfficialHarnessEvent({kind:'tool.completed',invocationId:'inv_fixture',harnessId:'pi'});
      try{await call();}catch(error){caughtOriginal=error===original;}
      assert.equal(caughtOriginal,true,'The durable write failure must reach its caller unchanged');
      console.log(JSON.stringify({caughtOriginal}));
      // Node's ordinary unhandled-rejection behavior must stay enabled. On
      // the old code, its detached finally promise terminates this process.
      await new Promise(resolve=>setTimeout(resolve,30));
      await call();
      assert.equal(writes,2,'The next queued callback must still reach storage');
      await new Promise(resolve=>setTimeout(resolve,30));
      console.log(JSON.stringify({caughtOriginal,writes,followupSucceeded:true}));
    `);
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), script,
        new URL("../src/collaboration-runtime.ts", import.meta.url).href, mode], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 12_000
      });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    expect(result.stdout).toContain('"caughtOriginal":true');
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toEqual({
      caughtOriginal: true, writes: 2, followupSucceeded: true
    });
  }, 15_000);
});
