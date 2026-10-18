import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { sha256 } from "../../scripts/r-projects/catalog.mjs";
import { launchSelected, selectCases, verifyReadiness, verifyRuntimeBinding, verifyS09Evidence } from "../../scripts/r-projects/launch.mjs";
import { nativeFiles } from "../../scripts/r-projects/verify-r16-native.mjs";
const roots: string[] = [];
const temporary = async () => { const r = await fs.mkdtemp(path.join(os.tmpdir(),"r-launch-test-")); roots.push(r); return r; };
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => fs.rm(r,{ recursive:true,force:true }))); });
const manifest = () => ({ schemaVersion:2,serviceUrl:"http://fixture.invalid",binding:{runId:"fixture",gatewayId:"gateway",githubAccountId:"github",model:"model",harness:"pi"},batches:{ foundation:["R01","R02"] },cases:["R01","R02"].map((code) => { const payload = { title:`${code} fixture` }; return { code,payload,payloadSha256:sha256(payload) }; }) });
it("selects only an explicit batch/case set and rejects changed payloads", () => {
  const m=manifest();
  expect(selectCases(m,{batch:"foundation"}).map((e:{code:string})=>e.code)).toEqual(["R01","R02"]);
  expect(selectCases(m,{cases:"R02"})).toHaveLength(1);
  expect(()=>selectCases(m,{})).toThrow(/exactly one/);
  expect(()=>selectCases(m,{cases:"R01,R01"})).toThrow(/Duplicate/);
  m.cases[0].payload.title="changed";
  expect(()=>selectCases(m,{cases:"R01"})).toThrow(/payload changed/);
});
it("never creates during planning or before the whole batch readiness check succeeds", async () => {
  const directory=await temporary(),m=manifest(),calls:string[]=[];
  const api=async(route:string,payload?:object)=>{ calls.push(`${payload?"POST":"GET"} ${route}`); return {projects:[]}; };
  await launchSelected({directory,manifest:m,selected:m.cases,api});
  expect(calls).toEqual(["GET /projects?includeArchived=true","GET /projects?includeArchived=true"]);
  await expect(launchSelected({directory,manifest:m,selected:m.cases,api,create:true,assertReady:async()=>{throw Error("S09 incomplete");}})).rejects.toThrow(/S09 incomplete/);
  expect(calls.some((c)=>c.startsWith("POST"))).toBe(false);
});
it("does not adopt an existing title without a creation receipt", async () => {
  const directory=await temporary(),m=manifest();
  await expect(launchSelected({directory,manifest:m,selected:[m.cases[0]],api:async()=>({projects:[{id:`prj_${"a".repeat(32)}`,title:m.cases[0].payload.title}]})})).rejects.toThrow(/do not adopt by title/);
});
it("records each accepted project before a later timeout and never retries an uncertain POST", async () => {
  const directory=await temporary(),m=manifest();let posts=0;
  const id=`prj_${"a".repeat(32)}`;
  const api=async(route:string,payload?:{title:string})=>{
    if(payload){ posts++; if(posts===2)throw Error("lost create response"); return {project:{id,title:payload.title,status:"running"}}; }
    if(route.includes("view=state"))return {project:{id,title:m.cases[0].payload.title,status:"running"}};
    return {projects:[]};
  };
  const options={directory,manifest:m,selected:m.cases,api,create:true,assertReady:async()=>{}};
  await expect(launchSelected(options)).rejects.toThrow(/lost create/);
  const registry=JSON.parse(await fs.readFile(path.join(directory,"launch-result.json"),"utf8"));
  expect(registry.results).toMatchObject([{code:"R01",projectId:id}]);
  expect(JSON.parse(await fs.readFile(path.join(directory,"R02.submission.json"),"utf8")).status).toBe("pending");
  await expect(launchSelected(options)).rejects.toThrow(/uncertain pending/);
  expect(posts).toBe(2);
  const replay=await launchSelected({...options,selected:[m.cases[0]]});
  expect(replay[0].action).toBe("registered");
  expect(posts).toBe(2);
});
it("requires current exact-route and exact-executable evidence", () => {
  const m=manifest(),now=Date.now();
  const test={status:"passed",model:"model",harness:"pi",gatewayRevision:2,routerCompatibilityVersion:"12",testedAt:new Date(now).toISOString(),adapterVersion:"1",executableFingerprint:"current",stageResults:["text_ordinary","text_stream","tool_ordinary","tool_stream","adapter_smoke"].map(stage=>({stage,status:"passed"}))};
  const catalog={routerCompatibilityVersion:"12",harnesses:[{id:"pi",available:true,purposes:["workflow"],adapterVersion:"1",executableFingerprint:"current"}],gateways:[{id:"gateway",apiKeyConfigured:true,models:["model"],revision:2,tests:[test]}]};
  const github={accounts:[{id:"github",status:"ready"}]};
  expect(()=>verifyRuntimeBinding(m,catalog,github,now)).not.toThrow();
  test.executableFingerprint="old";
  expect(()=>verifyRuntimeBinding(m,catalog,github,now)).toThrow(/smoke probe/);
  test.executableFingerprint="current";test.gatewayRevision=1;
  expect(()=>verifyRuntimeBinding(m,catalog,github,now)).toThrow(/protocol probe/);
});
it("verifies hashed original-S09/check/service artifacts and rejects changed process identity", async () => {
  const directory=await temporary(),m=manifest(),head="fixture-commit";
  const write=async(name:string,value:unknown)=>{const content=JSON.stringify(value);await fs.writeFile(path.join(directory,name),content);return{path:name,sha256:createHash("sha256").update(content).digest("hex")};};
  const log=await write("fixture-log.json",{fixture:true});
  const checks=await write("checks.json",{commit:head,commands:["npm run typecheck","npm test","npm run build","git diff --check"].map(command=>({command,exitCode:0,log}))});
  const s09=await write("s09.json",{originalInvocationId:"inv_b3e26f6b39ed805ab616e1704ee56183",status:"accepted",conclusion:"fixture only",originalProtocol:log,writerTimeline:log,stopProof:log});
  const service=await write("service.json",{commit:head,base:m.serviceUrl,pid:123,startTicks:"456",harnessVersion:"fixture",buildFiles:[log],startupLog:log});
  const readiness={manifestSha256:sha256(m),finalChecks:checks,s09,service,cases:Object.fromEntries(m.cases.map(e=>[e.code,{payloadSha256:e.payloadSha256}]))};
  const input={directory,manifest:m,selected:m.cases,readiness,head,identity:async()=>({pid:123,startTicks:"456"}),health:{status:"ok",harnessVersion:"fixture"}};
  await expect(verifyReadiness(input)).resolves.toBeUndefined();
  await expect(verifyReadiness({...input,identity:async()=>({pid:123,startTicks:"789"})})).rejects.toThrow(/identity changed/);
  await expect(verifyReadiness({...input,head:"new-unchecked-commit"})).rejects.toThrow(/another commit/);
  const r16 = { ...m.cases[0], code: "R16", faults: ["pi-native-retry"] };
  const nativeManifest = { ...m, cases: [r16] };
  const incomplete = await write("r16-generic-proof.json", { case: "R16", runId: m.binding.runId, variant: "pi-native-retry",
    status: "verified-isolated", bindingRule: "fixture", command: "fixture", scope: "fixture", isolationTestLog: log,
    commit: head, manifestSha256: sha256(nativeManifest), payloadSha256: r16.payloadSha256 });
  await expect(verifyReadiness({ ...input, manifest: nativeManifest, selected: [r16], readiness: { ...readiness,
    manifestSha256: sha256(nativeManifest), cases: { R16: { payloadSha256: r16.payloadSha256, faults: { "pi-native-retry": incomplete } } } } }))
    .rejects.toThrow(/native Pi identity/);
  await fs.writeFile(path.join(directory,"fixture-log.json"),"altered");
  await expect(verifyReadiness(input)).rejects.toThrow(/Evidence changed/);
});
it("accepts bound native regressions with an explicit historical gap and rejects unsafe or stale proofs", async () => {
  const directory=await temporary(),m=manifest(),head="fixture-commit";
  const r16={...m.cases[0],code:"R16"};m.cases.push(r16);
  const packageRoot=await fs.realpath(await fs.mkdtemp(path.join(directory,"pi-package-")));
  const hashes:Record<string,string>={};
  for(const name of nativeFiles){
    const file=path.join(packageRoot,name);await fs.mkdir(path.dirname(file),{recursive:true});
    const content=JSON.stringify({fixtureOnly:true,name});await fs.writeFile(file,content);
    hashes[name]=createHash("sha256").update(content).digest("hex");
  }
  const write=async(name:string,value:unknown)=>{const content=JSON.stringify(value);await fs.writeFile(path.join(directory,name),content);return{path:name,sha256:createHash("sha256").update(content).digest("hex")};};
  const readArtifact=async(ref:{path:string;sha256:string},parse=true)=>{
    if(!ref?.path)throw Error("Missing evidence path/hash");
    const bytes=await fs.readFile(path.join(directory,ref.path));
    if(createHash("sha256").update(bytes).digest("hex")!==ref.sha256)throw Error("Evidence changed");
    return parse?JSON.parse(bytes.toString()):bytes;
  };
  const identity={pid:123,startTicks:"456"};
  const evidence=(mode:string)=>({schemaVersion:2,mode,piVersion:"fixture-only",packageRoot,sessionPath:"fixture-session",sessionSha256:"a".repeat(64),hashes,
    firstTurnRequests:2,requests:mode==="recover"?3:2,
    wire:[{at:1000,frame:{type:"agent_end"}},{at:1001,frame:{type:"auto_retry_start",attempt:1,maxAttempts:1,delayMs:2000}},
      {at:3001,frame:{type:"auto_retry_end",success:mode==="recover"}}],
    backoff:{at:2100,activity:{invocationId:"inv-1"},process:{alive:true,identity},releases:[],concurrentTurnRejected:true,pauseRejected:true},
    stopped:true,stopProof:{at:4002,process:{alive:false,identity}},
    releases:mode==="recover"?[{at:3002,outcome:"completed"},{at:4001,outcome:"completed"}]:[{at:3002,outcome:"failed",alive:false}],
    outcome:mode==="recover"?{value:{handoff:"native-retry-final"}}:{error:"Pi automatic retry failed"},
    ...(mode==="recover"?{adjacentTurn:{handoff:"native-next-turn"}}:{})});
  const log=await write("native-log.json",{fixtureOnly:true});
  const controller={case:"R16",runId:m.binding.runId,variant:"pi-native-retry",status:"verified-isolated",commit:head,
    manifestSha256:sha256(m),payloadSha256:r16.payloadSha256,isolationTestLog:log,
    nativeHarness:{id:"pi",packageRoot,version:"fixture-only",hashes},
    nativeEvidence:{recover:await write("recover.json",evidence("recover")),exhaust:await write("exhaust.json",evidence("exhaust"))}};
  const s09={status:"accepted",acceptanceBasis:"native-protocol-regression",commit:head,conclusion:"Fixture tests functional acceptance only",
    historicalInvestigation:{status:"evidence-incomplete",invocationId:"original-fixture",missing:["Original wire logs"]},
    nativeController:await write("controller.json",controller)};
  const input={s09,manifest:m,head,readArtifact,packageRoot};
  await expect(verifyS09Evidence(input)).resolves.toBeUndefined();
  await expect(verifyS09Evidence({...input,head:"new-source"})).rejects.toThrow(/another source commit/);
  await expect(verifyS09Evidence({...input,s09:{...s09,historicalInvestigation:{status:"accepted"}}})).rejects.toThrow(/historical evidence limitation/);
  await expect(verifyS09Evidence({...input,s09:{...s09,acceptanceBasis:"skip-evidence"}})).rejects.toThrow(/Unknown S09/);
  const unsafe=evidence("exhaust");unsafe.releases[0].at=2100;
  const unsafeController={...controller,nativeEvidence:{...controller.nativeEvidence,exhaust:await write("early-release.json",unsafe)}};
  const unsafeRef=await write("unsafe-controller.json",unsafeController);
  await expect(verifyS09Evidence({...input,s09:{...s09,nativeController:unsafeRef}})).rejects.toThrow(/released before retry/);
  await fs.writeFile(path.join(directory,"recover.json"),"altered");
  await expect(verifyS09Evidence(input)).rejects.toThrow(/Evidence changed/);
});
