import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { ResidentNativeDriver, codexAppServerCodec, claudeStreamJsonCodec } from "../src/harness-runtime/resident-native-driver.js";
import type { SessionRef } from "../src/harness-runtime/contracts.js";

const roots:string[]=[],children:ChildProcessWithoutNullStreams[]=[];
afterEach(async()=>{
  for(const child of children.splice(0))if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");
  await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));
});
async function native(source:string){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"openfars-init-quiet-"));roots.push(root);
  const file=path.join(root,"native.cjs");await fs.writeFile(file,source,{mode:0o700});
  const child=spawn(process.execPath,[file],{cwd:root,stdio:["pipe","pipe","pipe"],detached:true});children.push(child);return child;
}
const session=(harnessId:string,nativeId:string):SessionRef=>({schemaVersion:1,harnessId,nativeId,adapterVersion:"fixture",generation:0,durable:true,createdAt:"2026-10-14T00:00:00.000Z"});
const authority={activate:async(turn:{inputId:string;invocationId:string})=>({...turn,ownershipEpoch:1,release:()=>undefined})};
function codexSource(kind:"silent"|"finite"|"continuous"|"unexpected"){
  return `const r=require('node:readline').createInterface({input:process.stdin});
  const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
  r.on('line',line=>{const q=JSON.parse(line);
    if(q.method==='initialize')return send({id:q.id,result:{}});
    if(q.method==='thread/start'){
      const idle=()=>send({method:'warning',params:{threadId:'quiet-thread',message:'bounded fixture notification'}});
      if(${JSON.stringify(kind)}==='finite')for(let i=0;i<8;i++)idle();
      if(${JSON.stringify(kind)}==='unexpected')send({method:'item/started',params:{threadId:'quiet-thread',turnId:'unauthorized-turn',item:{type:'agentMessage',id:'out-of-turn'}}});
      send({id:q.id,result:{thread:{id:'quiet-thread'}}});
      if(${JSON.stringify(kind)}==='continuous')setInterval(idle,10);
      return;
    }
    if(q.method==='thread/unsubscribe')return send({id:q.id,result:{}});
    if(q.method==='turn/start')throw Error('No business input is authorized by the initialization fixture');
  });`;
}

describe("resident initialization quiet proof",()=>{
  it.each(["silent","finite"] as const)("accepts a valid %s initialization after its consumer was delayed beyond the production bound",async kind=>{
    const child=await native(codexSource(kind));
    const codec=codexAppServerCodec({cwd:process.cwd(),model:"fixture",sandbox:"read-only"});
    const settle=codec.settleIdle!;let delayed=false,consumerBlockedMs=0;
    codec.settleIdle=async(connection,current)=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      if(!delayed){delayed=true;timer=setTimeout(()=>{
        const started=performance.now();while(performance.now()-started<1100){}consumerBlockedMs=performance.now()-started;
      },1);}
      try{await settle(connection,current);}finally{if(timer)clearTimeout(timer);}
    };
    const driver=await ResidentNativeDriver.open({child,session:session("codex","pending:quiet"),codec,turnAuthority:authority,ownershipEpoch:1});
    expect(consumerBlockedMs).toBeGreaterThanOrEqual(1100);
    expect(driver.session.nativeId).toBe("quiet-thread");expect((await driver.probe()).alive).toBe(true);
    await driver.close();
  });

  it("keeps the original one-second production bound for continuously arriving allowed notifications",async()=>{
    const child=await native(codexSource("continuous"));let error:any;
    try{await ResidentNativeDriver.open({child,session:session("codex","pending:quiet"),
      codec:codexAppServerCodec({cwd:process.cwd(),model:"fixture",sandbox:"read-only"}),turnAuthority:authority,ownershipEpoch:1});}
    catch(value){error=value;}
    expect(error?.message).toContain("Codex initialization notifications did not quiesce");
    expect(error.details).toMatchObject({operation:"initialization-quiescence",maximumMs:1000,quietMs:100});
    expect(error.details.acceptedNotifications).toBeGreaterThan(0);
    expect(error.details.lastReceivedElapsedMs+100).toBeGreaterThan(1000);
  });

  it("does not discard an unexpected turn frame during initialization",async()=>{
    const child=await native(codexSource("unexpected"));
    await expect(ResidentNativeDriver.open({child,session:session("codex","pending:quiet"),
      codec:codexAppServerCodec({cwd:process.cwd(),model:"fixture",sandbox:"read-only"}),turnAuthority:authority,ownershipEpoch:1}))
      .rejects.toThrow(/out-of-turn|unexpected|unrecognized|quiescen/i);
  });
});

describe("resident process exit facts",()=>{
  it.each([17,"SIGTERM"] as const)("retains the actual %s exit fact when no protocol result arrived",async exit=>{
    const child=await native(`const r=require('node:readline').createInterface({input:process.stdin});
      r.once('line',()=>{${typeof exit==='number'?`process.exit(${exit})`:`process.kill(process.pid,'${exit}')`}});`);
    const driver=await ResidentNativeDriver.open({child,session:session("claude-code","original-session"),
      codec:claudeStreamJsonCodec(),turnAuthority:authority,ownershipEpoch:1});
    let error:any;
    try{await driver.submit({inputId:"input-1",invocationId:"inv-1",prompt:"Fixture only; no tools or business.",
      route:{baseUrl:"http://127.0.0.1:45000/v1",token:"fixture-token"}});}catch(value){error=value;}
    expect(error?.message).toBe("Resident native process exited while awaiting a protocol frame");
    expect(error.details).toMatchObject({protocol:"claude-stream-json",exitCode:typeof exit==='number'?exit:null,signal:typeof exit==='string'?exit:null});
    expect(error.exitCode).toBe(typeof exit==='number'?exit:null);expect(error.signal).toBe(typeof exit==='string'?exit:null);
  });
});
