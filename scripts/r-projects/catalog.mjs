import { createHash } from "node:crypto";

export const SERVICE_URL = "http://127.0.0.1:4310";
export const PROJECT_SKILL_NAME = "r-acceptance-contract";
export const PROJECT_MCP_NAME = "r-project-checks";

// Fixed business contracts are deliberately independent of the runtime binding.
// Some cases share the prescribed base graph; topology uniqueness is not proof.
export const cases = [
  { code: "R01", title: "Memory actual tool delivery", input: { rounds: [[1, 2, 3], [1, 2, 3]] }, expected: { sum: 6 }, business: "Each of the two formal Loop arrivals independently sums [1,2,3] to 6. Both implementer and checker stage and commit agent-memory/<agent>/Memory.md plus their own round evidence using the real git_stage/git_commit tools. Inspect the merged PR tree before accepting delivery." },
  { code: "R02", title: "records without code or user artifacts", input: { statement: "2+3=5" }, expected: { sum: 5 }, noArtifacts: true, business: "Independently verify 2+3=5 on each formal arrival. Write factual review records and Memory, and deliver them through Git. Create no source files, empty commits or user artifacts. Call the provided verify_file tool on the review record." },
  { code: "R03", title: "missing finish in original session", input: { celsius: [0, 100] }, expected: { fahrenheit: [32, 212] }, faults: ["missing-finish-once"], business: "Convert C to F using C*9/5+32. The isolated missing-finish variant omits finish_task only on implementer's first invocation. Save a random marker and the original invocation/session/branch. On supplement, quote the marker and original tool receipts and do only missing closing work; do not repeat conversion." },
  { code: "R04", title: "first branch preparation recovery", input: { values: [4, 5, 6] }, expected: { sum: 15 }, faults: ["owned-pending-file", "registered-unopened-preparation"], business: "Sum [4,5,6] to 15. Two isolated variants separately exercise normal closing detection of an owned pending file and an already registered next execution whose first preparation failed before native opened. Original Agent must close its owned file in its retained session, delivering required work or removing its disposable diagnostic. Next arrival waits, retains its original base and is neither duplicated nor opened concurrently. Do not clear a worktree." },
  { code: "R05", title: "shared Worker FIFO in sibling groups", input: { left: [1, 2], right: [3, 4] }, expected: { left: 3, right: 7, total: 10 }, topology: "siblings", business: "Request both G_left and G_right in the parent plan. shared_worker computes the current scope's sum (left=3, right=7) separately on each formal Loop arrival. Preserve two group requests and their arrival order. Parent review combines the two synchronized results into 10, only after both groups complete." },
  { code: "R06", title: "shared Leader in parent and siblings", input: { left: [[1, 1], [2, 2]], right: [[3, 3], [4, 4]] }, expected: { rows: 4 }, topology: "shared-leader", business: "The parent and both child groups use shared_leader. Each child processes its two fixed rows on each formal round; parent review confirms four distinct rows in total, without counting repeat-round evidence as new data. Retain management requests through mutual exclusion and observe the current scope on every Leader wake." },
  { code: "R07", title: "three actual group levels", input: { values: [2, 3] }, expected: { sum: 5 }, topology: "three-level", business: "G_leaf computes 2+3=5; G_middle verifies and hands off 5; G_parent verifies and hands off 5. Save separate GroupRun, routing and completion evidence for all three levels. An error escalates from the actual current scope to its immediate Leader." },
  { code: "R08", title: "Worker Leader Worker transition", input: { values: [2, 3] }, expected: { sum: 5 }, topology: "role-return", business: "coordinator first acts as root Worker and verifies 5, routes to G_parent, then coordinates G_parent as Leader. G_parent returns to coordinator as root Worker, who writes a distinct after-group verification and routes to Main. Its ordinary sessionPersistence is false; scope-specific tools and instructions must follow Worker→Leader→Worker." },
  { code: "R09", title: "Main second wake after accepted edit", input: { labels: [" Alpha ", "BETA", "gamma"] }, expected: { normalized: ["alpha", "beta", "gamma"] }, business: "Each formal round trims whitespace and lowercases Alpha/BETA/gamma. Main edits once when the Loop target is 1. On its later wake, accepted-action and revision context means it coordinates only. The separate no-change proposal variant must be rejected without revision change; it is not a failure of the tool." },
  { code: "R10", title: "ordinary and group weak-route ownership", input: { values: [1, 2, 3, 4] }, expected: { sum: 10, decision: "pass" }, topology: "decisions", business: "Use sum=10 to choose pass/reject on actual weak branches. After Main's accepted edits, child_gate selects its own route; parent_gate is selected by its current group Leader; G_child selects via its own Leader and G_child_parent selects via its parent Leader. Record the exact route receipt and owner for each decision; rejecting business evidence must not be re-labelled a pass." },
  { code: "R11", title: "existing gateway recovery", input: { values: [2, 3] }, expected: { sum: 5 }, faults: ["gateway-error-once", "gateway-unavailable"], business: "Verify [2,3]→5 twice. One isolated channel variant returns a recoverable error once; another stays unavailable and preserves the paused scene for escalation. Reuse existing recovery, same model and original task. Keep both original error and subsequent result; do not build a new recovery loop." },
  { code: "R12", title: "merged PR with lost response", input: { values: [1, 2, 3] }, expected: { sum: 6 }, faults: ["merge-response-lost"], business: "Verify [1,2,3]→6 twice. Drop only this project's first selected merge response after provider acceptance. The Agent observes the timeout and chooses get_pr or replay of the same operation. Retain the merged PR identity, original head and sync receipt; never create a replacement PR or duplicate merge to hide the timeout." },
  { code: "R13", title: "old merged PR and newer push", input: { values: [3, 7] }, expected: { sum: 10 }, business: "Only implementer on its first formal arrival performs the A/B sequence; other roles verify the resulting actual receipts. Deliver business commit A proving 3+7=10 and merge its PR. In the same assigned execution branch, explicitly make a separate diagnostic commit B and push it. Query the old PR and original push: preserve A's immutable merge/journal while observing B as a different head. Agent decides B's legal delivery and records the actual receipts; do not claim B was in A's PR." },
  { code: "R14", title: "partial report association recovery", input: { values: [10, null, 20] }, expected: { missing: 1, sum: 30 }, faults: ["partial-report-linkage"], business: "Count one missing value and sum known values to 30 on each round. Isolated controlled completion retains a valid business report but lacks delivery association. The original Agent inspects its own push/PR receipts and supplements that linkage from its retained session. Preserve business report bytes; never fill DB fields directly." },
  { code: "R15", title: "new resources and immutable definitions", input: { values: [4, 5, 6] }, expected: { sum: 15 }, topology: "resources", business: "Main adds the precisely specified new Skill and MCP and assigns them to implementer/checker. Workers actually invoke the new sum_values tool with [4,5,6], yielding 15. Preserve old resource hashes; omission retains old items. Separate invalid proposals changing source/config or explicitly deleting old definitions must fail atomically. Accepted new resources become immutable too; changing Loop, references or JSON formatting must not alter definition content." },
  { code: "R16", title: "native retry boundary and running UI", input: { rows: [" 1 ", "2", "3 "] }, expected: { count: 3, sum: 6 }, topology: "three-level", faults: ["pi-native-retry"], business: "Trim and parse the three rows, obtaining count=3 and sum=6 on each formal round. The independent observer captures the actual three-level running UI: expandable Agent invocation counts, draggable modal nodes, and directed selected-edge animation. The isolated native Pi probe records retry frames, session/lease/stop evidence. Workers do not claim browser observations or invoke protocol injection themselves." }
];

export const faultPlans = {
  "missing-finish-once": { boundary: "R03 explicitly bound first implementer invocation and initial model inputId only", trigger: "reject finish_task explicitly for this initial model turn, return a persisted random marker, and let the existing next supplement accept finish_task; scripts/r-projects/arm-fault.mjs --case R03", evidence: ["first handoff without a finish receipt after real Git delivery", "original random marker/session/branch", "same-session supplement receipts without repeated business"], ready: false },
  "owned-pending-file": { boundary: "R04 exact first implementer execution/epoch/invocation and initial model inputId only", trigger: "arm-fault.mjs --case R04; after real merge/sync append one file request to the tool return; Agent writes evidence/pending-owned.json with its file tool and leaves it for normal closing", evidence: ["issued request plus separately observed pending file hash", "actual Agent file-tool trace", "original-session supplement before next opened", "Agent cleanup/delivery and clean branch transition"], ready: false },
  "registered-unopened-preparation": { boundary: "R04 explicitly observed queued implementer arrival only; bind its actual execution/invocation after reservation", trigger: "scripts/r-projects/arm-r04-preparation.mjs selects that queued arrival; fail once after saved base/reservation, before sessionBegin/native opened, through ordinary recovery without DB edits", evidence: ["one arrival/execution", "saved activation base", "unopened failure and Leader-authorized preparation from the same base"], ready: false },
  "gateway-error-once": { boundary: "R11 observed first queued implementer arrival, actual epoch/invocation/initial inputId and locked gateway/model/Harness/protocol only", trigger: "arm-r11.mjs --variant gateway-error-once; first model POST attempt returns one synthetic 503 before upstream dispatch; existing proxy/native recovery owns retries", evidence: ["route binding", "exclusive injection receipt and actual transport trace", "existing retry success same model"], ready: false },
  "gateway-unavailable": { boundary: "R11 independent project, same queued-arrival and exact initial model-turn route binding", trigger: "arm-r11.mjs --variant gateway-unavailable; every eligible attempt on the bound initial route returns synthetic 503, including existing retries; other turns/routes are unaffected", evidence: ["bounded existing retry", "original session/branch and stopped owner preserved", "hierarchical escalation"], ready: false },
  "merge-response-lost": { boundary: "R12 explicitly bound native invocation, execution, epoch and own selected PR/operation only", trigger: "after the Agent-requested merge and local sync succeed, withhold exactly one control-tool return; scripts/r-projects/arm-r12.mjs requires accepted creation and current-turn evidence", evidence: ["finalized operation and provider merge/sync receipt", "Agent-visible timeout in tool trace", "Agent query/replay and sync; no duplicate write"], ready: false },
  "partial-report-linkage": { boundary: "R14 explicitly bound first implementer execution/epoch/invocation only", trigger: "after confirmed native stop, omit one report head at normal report persistence while preserving actual output and merged delivery; scripts/r-projects/arm-fault.mjs --case R14; no DB edit", evidence: ["report hash before and after repair", "original merged delivery and native stop receipts", "same-session association repair without repeated business"], ready: false },
  "pi-native-retry": { boundary: "R16 dedicated local native fixture process; current manifest/payload/commit and installed Pi bytes", trigger: "verify-r16-native.mjs --input <run-directory> --output <new-evidence-directory> runs installed Pi against a private localhost provider for recover and exhaust", evidence: ["full native RPC frames", "held authority during 2000ms backoff", "exact process stop proof and adjacent-turn isolation", "hashed current package and isolation log"], ready: false }
};

const common = "Read the current invocation role, scope, arrival/Loop facts, allocated Git target and predecessor handoff on every wake. Work only in the assigned execution workspace; do not switch branches yourself. Agents do business and Git/PR work; the system supplies tools and runtime guarantees. Use the actual tools, inspect errors and record real receipts. Each required invocation, including Main's own management task, calls finish_task or preserves its already accepted receipt. Authorized roles separately route and complete groups/project. A receipt or orchestration decision does not end the native turn; return a normal final response after the required actions. Git-enabled work always includes agent-memory/<agent>/Memory.md in the actual committed tree, even with no source change. A memory mirror, process exit or old PR does not prove current delivery. Missing closing steps use original-session supplement, not repeated business. Protect runtime/control files and never publish Memory as a user artifact.";
const skill = { files: { "SKILL.md": "---\nname: r-acceptance-contract\ndescription: Verify the fixed R-case input in the current formal scope and arrival.\n---\n" + common + "\nWrite the current round's evidence only. Check the actual source/tool return and handoff; do not count future or duplicate files as graph iterations.\n" } };
const service = (source) => ({ files: { "server.cjs": source }, command: "node", entrypoint: "server.cjs", args: [], envFrom: {} });
const mcpPrelude = `const {McpServer}=require('@modelcontextprotocol/sdk/server/mcp.js');
const {StdioServerTransport}=require('@modelcontextprotocol/sdk/server/stdio.js');
const {z}=require('zod');
const server=new McpServer({name:'r-checks',version:'1.0.0'});\n`;
const mcpEnd = "\nserver.connect(new StdioServerTransport()).catch(e=>{process.stderr.write(String(e));process.exitCode=1;});\n";
export const newResources = {
  skillDefinitions: { "r15-new-sum": { files: { "SKILL.md": "---\nname: r15-new-sum\ndescription: Verify the current R15 sum using the newly accepted project MCP.\n---\nCall sum_values with values [4,5,6]. Check sum=15 and record the actual return in this arrival's evidence. Deliver Memory and evidence through Git.\n" } } },
  mcpDefinitions: { "r15-new-sum": service(mcpPrelude + "server.registerTool('sum_values',{description:'Sum finite numeric input',inputSchema:{values:z.array(z.number().finite()).min(1).max(100)}},async({values})=>({content:[{type:'text',text:JSON.stringify({sum:values.reduce((a,b)=>a+b,0)})}]}));" + mcpEnd) },
  assignTo: ["implementer", "checker"]
};

const edge = (target, kind = "strong") => ({ target, kind });
const worker = (nodeId, agentId) => ({ kind: "agent", nodeId, agentId });
const child = (nodeId, groupId) => ({ kind: "collaboration", nodeId, groupId });
function leaf(id, parentGroupId, leaderAgentId, implementer = "implementer", checker = "checker", packager = "packager") {
  return { id, parentGroupId, leaderAgentId, decisionBy: "main", allowLeaderReconfiguration: false,
    workflow: { nodes: [worker(id+"_impl", implementer), worker(id+"_check", checker), worker(id+"_pack", packager)],
      input: { source: "input", edges: [{ target: id+"_impl", kind: "parallel" }] },
      routes: { [id+"_impl"]: [edge(id+"_check")], [id+"_check"]: [edge(id+"_impl")], [id+"_pack"]: [edge("finish")] },
      loops: [{ id: id+"_rounds", from: id+"_check", to: id+"_impl", maxIterations: 1, exitTo: id+"_pack" }] } };
}
function parent(id, childIds, leaderAgentId, review = "parent_review", parentGroupId) {
  const nodes = childIds.map((name) => child(id+"_"+name, name));
  const reviewNode = id+"_review";
  return { id, ...(parentGroupId ? { parentGroupId } : {}), leaderAgentId, decisionBy: "main", allowLeaderReconfiguration: false,
    workflow: { nodes: [...nodes, worker(reviewNode, review)],
      input: { source: "input", edges: nodes.map(({ nodeId }) => ({ target: nodeId, kind: "parallel" })) },
      routes: { ...Object.fromEntries(nodes.map(({ nodeId }) => [nodeId, [edge(reviewNode)]])), [reviewNode]: [edge("finish")] }, loops: [] } };
}
function graphFor(spec) {
  let groups;
  if (["siblings", "shared-leader"].includes(spec.topology)) {
    const sharedLeader = spec.topology === "shared-leader";
    groups = [parent("G_parent", ["G_left", "G_right"], sharedLeader ? "shared_leader" : "parent_leader"),
      leaf("G_left", "G_parent", sharedLeader ? "shared_leader" : "left_leader", sharedLeader ? "left_worker" : "shared_worker", "left_checker", "left_packager"),
      leaf("G_right", "G_parent", sharedLeader ? "shared_leader" : "right_leader", sharedLeader ? "right_worker" : "shared_worker", "right_checker", "right_packager")];
  } else if (spec.topology === "three-level") {
    groups = [parent("G_parent", ["G_middle"], "parent_leader"), parent("G_middle", ["G_leaf"], "middle_leader", "middle_review", "G_parent"), leaf("G_leaf", "G_middle", "leaf_leader")];
  } else {
    groups = [parent("G_parent", ["G_child"], spec.topology === "role-return" ? "coordinator" : "parent_leader"), leaf("G_child", "G_parent", "child_leader")];
  }
  const edits = [];
  if (spec.topology === "decisions") {
    const p = groups[0], c = groups[1];
    c.workflow.nodes.push(worker("child_gate", "child_gate"), worker("child_accept", "accept_worker"), worker("child_reject", "reject_worker"));
    c.workflow.routes.G_child_pack = [edge("child_gate")];
    c.workflow.routes.child_gate = [edge("child_accept", "weak"), edge("child_reject", "weak")];
    c.workflow.routes.child_accept = c.workflow.routes.child_reject = [edge("finish")];
    p.workflow.nodes.push(worker("parent_gate", "parent_gate"), worker("parent_reject", "reject_worker"), child("parent_second_child", "G_child_parent"));
    p.workflow.routes.G_parent_G_child = [edge("parent_gate", "weak"), edge("parent_reject", "weak")];
    p.workflow.routes.parent_gate = [edge("parent_second_child", "weak"), edge("parent_reject", "weak")];
    p.workflow.routes.parent_second_child = [edge("G_parent_review", "weak"), edge("parent_reject", "weak")];
    p.workflow.routes.parent_reject = [edge("finish")];
    groups.push(leaf("G_child_parent", "G_parent", "second_leader"));
    groups[2].decisionBy = "agent";
    edits.push({ kind: "agent-decision", agentId: "child_gate", before: "main", after: "agent" },
      { kind: "agent-decision", agentId: "parent_gate", before: "agent", after: "main" },
      { kind: "group-decision", groupId: "G_child", before: "main", after: "agent" },
      { kind: "group-decision", groupId: "G_child_parent", before: "agent", after: "main" });
  }
  for (const g of groups) for (const loop of g.workflow.loops) edits.unshift({ kind: "loop", groupId: g.id, loopId: loop.id, before: 1, after: 2 });
  const rootAgentIds = spec.topology === "role-return" ? ["main", "coordinator"] : ["main"];
  const names = [...new Set([...rootAgentIds, ...groups.flatMap((g) => [g.leaderAgentId, ...g.workflow.nodes.filter((n) => n.kind === "agent").map((n) => n.agentId)])])];
  const routes = spec.topology === "role-return"
    ? { main: [edge("coordinator", "weak")], coordinator: [edge("G_parent", "weak"), edge("main", "weak")], G_parent: [edge("coordinator")] }
    : { main: [edge("G_parent", "weak")], G_parent: [edge("main")] };
  return { names, edits, orchestration: { schemaVersion: 3,
    agents: names.map((name) => ({ name, template: name === "main" ? "main" : "general", description: `${spec.code} ${name}` })),
    collaborations: groups.map((g) => ({ id: g.id, displayName: g.id, memberAgentIds: [], renamePolicy: "editable" })),
    scopedWorkflow: { schemaVersion: 1, rootAgentIds, groups }, input: { source: "input", target: "main" }, routes,
    decisionPlans: Object.fromEntries([...rootAgentIds, "G_parent"].map((name) => [name, name === "coordinator" ? "First root Worker arrival routes to G_parent; after that group's actual completion, second root Worker arrival routes to Main. In Leader role use current group controls only." : "Use current scope's formal route owner and actual predecessor handoff; wait for missing predecessors."])),
    allowMainReconfiguration: true, allowUserIntervention: true,
    termination: { agent: "main", condition: "All assigned groups completed with two formal Loop rounds, synchronized Git trees containing required records, exact fixed results and real closing receipts. Unverified fault/UI coverage is reported separately.", decisionBy: "main", automatic: false },
    resultFormat: spec.noArtifacts ? { presets: [], custom: "", none: true } : { presets: ["代码"], custom: "Publish the verified business result JSON and requested business source only. Exclude Memory, workflow and internal acceptance logs." }
  } };
}

function scopeResults(spec) {
  return spec.code === "R05" ? { G_left: { sum: 3 }, G_right: { sum: 7 }, G_parent: spec.expected }
    : spec.code === "R06" ? { G_left: { rows: 2 }, G_right: { rows: 2 }, G_parent: { rows: 4 } } : null;
}
function checks(spec) {
  const expected = scopeResults(spec);
  return service(mcpPrelude + `const fs=require('node:fs/promises'),path=require('node:path');
const equal=require('node:util').isDeepStrictEqual;
const fixed=${JSON.stringify(spec.expected)},scopes=${JSON.stringify(expected)};
server.registerTool('run_node',{description:'Run a self-contained current-workspace Node assertion and return its actual exit status.',inputSchema:{file:z.string().min(1)}},async({file})=>{
 const root=await fs.realpath(process.env.SCIENCEEVOLVE_WORKSPACE),target=await fs.realpath(path.resolve(root,file));
 if(!target.startsWith(root+path.sep)||!target.endsWith('.mjs'))throw Error('entrypoint must be an assigned-workspace .mjs file');
 const result=await new Promise(resolve=>{
  const child=require('node:child_process').spawn(process.execPath,[target],{cwd:root,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},10000);
  child.stdout.on('data',v=>{stdout=(stdout+v).slice(-20000);});
  child.stderr.on('data',v=>{stderr=(stderr+v).slice(-10000);});
  child.on('error',error=>{clearTimeout(timer);resolve({file,exitCode:null,error:String(error)});});
  child.on('close',(exitCode,signal)=>{clearTimeout(timer);resolve({file,exitCode,signal,stdout,stderr,timedOut});});
 });
 return {content:[{type:'text',text:JSON.stringify(result)}],isError:result.exitCode!==0};
});
server.registerTool('verify_file',{description:'Check a current-arrival JSON record against the fixed scenario result. sourceGroup checks a partial sibling contribution, never the final aggregate.',inputSchema:{file:z.string().min(1),group:z.string(),round:z.number().int().min(1).max(2),sourceGroup:z.string().optional()}},async({file,group,round,sourceGroup})=>{
 const root=await fs.realpath(process.env.SCIENCEEVOLVE_WORKSPACE);
 const target=await fs.realpath(path.resolve(root,file));
 if(!target.startsWith(root+path.sep))throw Error('file outside assigned workspace');
 if((await fs.stat(target)).size>100000)throw Error('record too large');
 const record=JSON.parse(await fs.readFile(target,'utf8'));
 if(sourceGroup&&(group!=='G_parent'||!scopes||!['G_left','G_right'].includes(sourceGroup)))throw Error('partial contribution outside sibling review');
 const expected=scopes?scopes[sourceGroup||group]:fixed;
 const partial=!!sourceGroup;
 const pass=!!expected&&record.round===round&&record.group===group&&equal(record.result,expected)&&
  (partial?record.partial===true&&record.sourceGroup===sourceGroup:record.partial!==true);
 return {content:[{type:'text',text:JSON.stringify({file,group,round,sourceGroup,coverage:partial?'contribution':'scope-result',expected,actual:record.result,exitCode:pass?0:1})}],isError:!pass};
});` + mcpEnd);
}
function resources(spec) {
  const definitions = { skillDefinitions: { [PROJECT_SKILL_NAME]: skill }, mcpDefinitions: { [PROJECT_MCP_NAME]: checks(spec) } };
  if (spec.code === "R15") {
    definitions.skillDefinitions["r15-protected-old"] = { files: { "SKILL.md": "# Protected definition\nThis original definition is immutable.\n" } };
    definitions.mcpDefinitions["r15-protected-old"] = service(mcpPrelude + "server.registerTool('ping',{description:'Protected original tool',inputSchema:{}},async()=>({content:[{type:'text',text:'protected-old'}]}));" + mcpEnd);
  }
  return definitions;
}
function instructions(spec, name, graph) {
  const groups = graph.orchestration.scopedWorkflow.groups;
  const led = groups.filter((g) => g.leaderAgentId === name).map((g) => g.id);
  const jobs = groups.flatMap((g) => g.workflow.nodes.filter((n) => n.kind === "agent" && n.agentId === name).map((n) => ({ group: g.id, node: n.nodeId })));
  const scopedResults = scopeResults(spec);
  const resultContract = scopedResults
    ? `Expected record.result by scope: ${JSON.stringify(scopedResults)}. Select only the value for the current group; the scope mapping itself is not a record.result.`
    : `Expected record.result in every group: ${JSON.stringify(spec.expected)}.`;
  let role;
  if (name === "main") {
    role = `Read the actual workflow document with its baseHash before proposing changes. Authorized changes only: ${JSON.stringify(graph.edits)}. Apply each target only if it still equals before; if already after, preserve it. Change ALL named child Loops, not just the first. If all requested targets/resources already match, coordinate from the current handoff without apply_workflow; accepted prior rationale is history. Preserve IDs, unrelated fields and immutable resource contents. A successful apply_workflow tool return stages this invocation's sole orchestration decision. Preserve or supply the required finish_task for your own Main management task, then return a normal final response to end the native turn so the atomic commit can occur; do not poll for the accepted revision or call route_to_agent/request_user/complete_project in that same invocation. The following autonomous Main wake receives the accepted revision; inspect it and route then. Do no Worker business. First route ${spec.topology === "role-return" ? "coordinator" : "G_parent"}; on return inspect actual group delivery and use project completion authority.`;
    if (spec.code === "R15") role += ` Add these exact previously absent definitions and append their references for the listed Agents (skills project:r15-new-sum; MCP {name:r15-new-sum,project:r15-new-sum}), preserving existing references: ${JSON.stringify(newResources)}. Existing definitions, including your own earlier additions, are immutable; omission preserves them, explicit null/deletion or changed content/config is rejected. Negative proposals belong only to their separately registered variant.`;
  } else if (led.length && !jobs.length && name !== "coordinator") {
    role = `Leader for scopes ${led.join(", ")}; act only for the current scope. Assign every current direct member/child explicitly, with fixed input, owned paths, formal round and immediate Git target. In sibling scenarios request BOTH children in one plan; retain queued requests while shared identity or management is busy. On a planning wake, submit direct assignments and finish_task promptly to release management so children can run. On a later completion wake, inspect actual child completion and synchronized results before using your own group routing/completion tools. Never hold a management invocation open while waiting for its blocked business scope. Do not edit Worker files or complete another group.`;
  } else if (name === "coordinator") {
    role = "Use the current role: first root Worker verifies 5 and writes evidence/root/coordinator/<arrival>-before.json, then routes G_parent; as G_parent Leader coordinate only, submit assignments and finish the planning invocation so children can run, then assess completion on a later management wake; after its completion return to root Worker, verify 5 again, write a separate <arrival>-after.json with current tools and route Main. Never carry Leader-only restrictions into the returning Worker invocation.";
  } else {
    role = `Your possible formal nodes are ${JSON.stringify(jobs)}. Own only evidence/<current-group>/${name}/<current-arrival>-round-<N>.json and agent-memory/${name}/Memory.md; N comes from the formal Loop/arrival, never guessed from files. Each record contains group, round, input, result, invocation and actual upstream commit/tool references. Call r-project-checks.verify_file on it, preserve the real returned exitCode and deliver the file and Memory with your Git tools. `;
    if (/impl|worker/.test(name) && !["accept_worker", "reject_worker"].includes(name)) role += spec.noArtifacts ? "This is review-only: no source file or empty commit. " : `You may write only src/<current-group>/${name}.mjs for the current business computation. Include Node assertions against the fixed result and call r-project-checks.run_node on that exact file; preserve its actual command, stdout, stderr and exitCode. Execute only the current round, never pre-create later evidence. `;
    if (/check/.test(name)) role += "Independently recompute from fixed inputs and inspect the current implementer's actual committed result; do not merely copy its claimed pass. ";
    if (/pack/.test(name)) role += "Require the formal finite Loop exit before packaging; cite both real rounds, tool returns and commits. Own also package/<current-group>/result.json. ";
    if (/review/.test(name)) {
      role += "Own also package/<current-group>/result.json. Publish only the requested verified business result after all direct children have synchronized; do not publish internal evidence. ";
      if (["R05", "R06"].includes(spec.code)) role += "Each child completion creates its own review arrival; there is no implicit join. If a sibling is unfinished, verify ONLY the current synchronized contribution, set partial=true and sourceGroup=G_left or G_right in your evidence, call verify_file with that sourceGroup, deliver your record and finish this invocation promptly. Do not wait in a live Worker turn for another child's Leader: that management scope is blocked by your active parent turn. On the later review arrival, inspect both synchronized child deliveries and produce the final aggregate with partial=false (omit sourceGroup in the final verify_file call). The parent Leader requires that final aggregate and both completed children before group completion. ";
    }
    if (/gate|accept|reject/.test(name)) role += "Verify sum=10 and use only the current authorized weak-route owner. Reject remains a failure requiring escalation. ";
    if (spec.code === "R04" && name === "implementer") role += "Only when your real github_merge_pr return includes acceptancePendingFile, use your assigned file tool to create its exact new evidence/pending-owned.json content once, preserving any existing file. Leave this disposable diagnostic uncommitted through the initial handoff and call finish_task normally. The existing original-task closing supplement must inspect it; decide whether to deliver required work or remove your own disposable file, without repeating successful business/PR work. Never create it without that exact returned request or recreate it on later turns. ";
    if (spec.code === "R15") role += "When assigned project:r15-new-sum, actually invoke r15-new-sum.sum_values([4,5,6]) and record its return. Do not use an old tool as proof that Main created the new one. ";
  }
  return `${common}\n${spec.code}: ${spec.business}\nFixed input: ${JSON.stringify(spec.input)}; project expected: ${JSON.stringify(spec.expected)}. ${resultContract}\n${role}\nFaults are disabled unless a separately registered project-local controller is armed for this exact case, execution and variant. Ordinary execution must not invent fault injection. Resource definitions are read-only; escalation follows Worker→current Leader→Main.`;
}

export function assertBinding(binding) {
  if (!binding || !/^[a-z0-9][a-z0-9-]{2,39}$/.test(binding.runId ?? "")) throw Error("Explicit unique runId required");
  if (!/^gwy_[a-f0-9]{32}$/.test(binding.gatewayId ?? "") || !/^gha_[a-f0-9]{32}$/.test(binding.githubAccountId ?? "")) throw Error("Explicit configured gateway/GitHub IDs required");
  if (!binding.model?.trim() || !binding.harness?.trim() || !binding.observedAt || !binding.evidencePath) throw Error("Runtime model, Harness and observed configuration evidence required");
}
export function sha256(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function buildPayload(spec, binding) {
  assertBinding(binding);
  const graph = graphFor(spec), defs = resources(spec);
  const agents = Object.fromEntries(graph.names.map((name) => [name, {
    model: binding.model, harness: binding.harness, gatewayId: binding.gatewayId,
    permission: "workspace", webSearch: false,
    sessionPersistence: !(spec.code === "R03" && name === "implementer" || spec.code === "R08" && name === "coordinator"),
    decisionBy: spec.code === "R10" && name === "child_gate" ? "main" : name === "main" ? "main" : "agent",
    skills: [`project:${PROJECT_SKILL_NAME}`], autoSkills: [],
    mcpServers: name !== "main" && graph.orchestration.scopedWorkflow.groups.some((g) => g.workflow.nodes.some((n) => n.kind === "agent" && n.agentId === name)) || name === "coordinator" ? [{ name: PROJECT_MCP_NAME, project: PROJECT_MCP_NAME }] : [],
    instructions: instructions(spec, name, graph)
  }]));
  return { title: `OpenFARS ${spec.code} ${binding.runId}: ${spec.title}`,
    requirement: `${spec.code}: ${spec.business}\nFixed input=${JSON.stringify(spec.input)}; expected=${JSON.stringify(spec.expected)}.\nMain must apply all authorized changes before routing; initial Loop upper bounds are 1 and accepted targets are 2.\n${common}\nArtifact policy: ${spec.noArtifacts ? "none=true; internal review records only" : "only verified business result JSON and requested business code"}.\nFault variants=${JSON.stringify((spec.faults ?? []).map((id) => ({ id, ...faultPlans[id] })))}. No controller armed means fault coverage is unverified.`,
    agents, ...defs, orchestration: graph.orchestration,
    git: { enabled: true, provider: "github", accountId: binding.githubAccountId, repositoryName: `openfars-${binding.runId}-${spec.code.toLowerCase()}`, repositoryVisibility: "private" } };
}
export function buildManifest(binding) {
  assertBinding(binding);
  return { schemaVersion: 2, serviceUrl: SERVICE_URL, binding: structuredClone(binding),
    batches: { foundation: ["R01", "R02", "R04", "R09", "R15"], coordination: ["R05", "R06", "R07", "R08", "R10"], controlled: ["R03", "R11", "R12", "R13", "R14", "R16"] },
    cases: cases.map((spec) => {
      const payload = buildPayload(spec, binding);
      return { ...spec, payload, payloadSha256: sha256(payload), mainEdits: graphFor(spec).edits,
        resourceAdditions: spec.code === "R15" ? structuredClone(newResources) : null,
        resourceHashes: { skills: Object.fromEntries(Object.entries(payload.skillDefinitions).map(([k,v]) => [k,sha256(v)])), mcps: Object.fromEntries(Object.entries(payload.mcpDefinitions).map(([k,v]) => [k,sha256(v)])) },
        launchReady: false,
        pending: ["S09 current native protocol regression acceptance", "all final checks and service version proof", "fresh runtime route verification", ...(spec.faults ?? []).map((id) => `isolated controller evidence: ${id}`), ...(spec.code === "R16" ? ["browser observer available"] : [])]
      };
    }) };
}

// Used by offline parser checks only. Live Main must read its own fresh document,
// preserve baseHash, submit apply_workflow itself and inspect the real receipt.
export function applyPlannedEdits(document, entry) {
  for (const edit of entry.mainEdits) {
    if (edit.kind === "loop") document.orchestration.scopedWorkflow.groups.find((g) => g.id === edit.groupId).workflow.loops.find((l) => l.id === edit.loopId).maxIterations = edit.after;
    if (edit.kind === "group-decision") document.orchestration.scopedWorkflow.groups.find((g) => g.id === edit.groupId).decisionBy = edit.after;
    if (edit.kind === "agent-decision") document.agents[edit.agentId].decisionBy = edit.after;
  }
  if (entry.resourceAdditions) {
    Object.assign(document.skillDefinitions, structuredClone(entry.resourceAdditions.skillDefinitions));
    Object.assign(document.mcpDefinitions, structuredClone(entry.resourceAdditions.mcpDefinitions));
    for (const name of entry.resourceAdditions.assignTo) {
      document.agents[name].skills.push("project:r15-new-sum");
      document.agents[name].mcpServers.push({ name: "r15-new-sum", project: "r15-new-sum" });
    }
  }
  return document;
}
