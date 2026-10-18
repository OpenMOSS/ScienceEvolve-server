import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

async function json(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2)+"\n", { mode: 0o600 });
  await fs.rename(temporary, file);
}
export function summarize(project) {
  const activities = project.runtime?.activities ?? [];
  const failure = project.failureSummary;
  return {
    projectId: project.id, status: project.status, phase: project.phase,
    workflowRevision: project.workflowRevision, eventSeq: project.eventSeq,
    observation: project.status === "completed" ? "completed-needs-evidence-review"
      : project.status === "paused" ? "paused" : activities.length ? "executing" : "waiting-or-idle",
    activities, groups: project.scopedGroupRuns ?? [], management: project.scopedManagementTurns ?? [],
    executions: project.scopedExecutions ?? [],
    // FIFO and Loop counters are the persisted per-arrival facts, not filenames
    // or the configured upper bound. Native open/stop comes from events below.
    arrivals: project.scopedArrivals ?? [],
    loops: [
      ...(project.orchestration?.loops ?? []).map((loop) => ({ scope: "root", ...loop })),
      ...(project.orchestration?.scopedWorkflow?.groups ?? []).flatMap((g) => (g.workflow.loops ?? []).map((loop) => ({ scope: g.id, ...loop })))
    ],
    rootLoopIterations: project.loopIterations ?? {},
    routeReceipts: project.collaboration?.routeOutbox ?? [],
    failureSummary: failure, lastError: project.lastError ?? null,
    acceptance: "unverified"
  };
}
export function allTerminal(rows) {
  return rows.length > 0 && rows.every((r) => ["completed", "failed", "cancelled", "canceled"].includes(r.status));
}

// Harness frames are nested inside agent.trace, whose outer level can remain
// informational even when the actual tool call failed. Preserve the original
// frame, including invocation/call identity, without treating a model turn's
// completion as proof that the native resident process has stopped.
export function eventEvidence(events) {
  return {
    errors: events.filter((event) => event.level === "error" ||
      /failed|error/.test(String(event.data?.sourceType ?? event.type)) ||
      /failed|error/.test(String(event.data?.event?.kind ?? "")) || event.data?.event?.tool?.isError === true),
    native: events.filter((event) =>
      /native.*(opened|stopped)|native_started/.test(String(event.data?.sourceType ?? event.type)) ||
      event.data?.event?.kind === "lifecycle" || event.data?.event?.kind === "user.message" ||
      /Resident turn authority released/.test(event.message ?? ""))
  };
}

export async function collectEvents(api, projectId, lastSeq, savedSeq = 0) {
  if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) throw Error("Project did not expose an event sequence");
  if (lastSeq < savedSeq) throw Error("Project event sequence moved backwards");
  let before = lastSeq+1;
  const events = new Map();
  const gaps = [];
  while (before > savedSeq+1) {
    const page = await api(`/projects/${projectId}/events/history?before=${before}&limit=1000`);
    if (!Array.isArray(page.events)) throw Error("Malformed event history page");
    let oldest = before;
    for (const event of page.events) {
      if (!Number.isSafeInteger(event.seq) || event.seq >= before || event.seq < 1) throw Error("Invalid event history ordering");
      oldest = Math.min(oldest, event.seq);
      if (event.seq > savedSeq) events.set(event.seq, event);
    }
    if (oldest <= savedSeq+1) break;
    if (!page.hasMore) {
      if (oldest > savedSeq+1) gaps.push({ after: savedSeq, before: oldest, reason: "history ended before the saved cursor" });
      break;
    }
    if (oldest === before) throw Error("Event pagination made no progress");
    before = oldest;
  }
  const ordered = [...events.values()].sort((a,b) => a.seq-b.seq);
  for (let i=1; i<ordered.length; i++) if (ordered[i].seq !== ordered[i-1].seq+1) gaps.push({ after: ordered[i-1].seq, before: ordered[i].seq, reason: "event sequence gap" });
  if (ordered.length && ordered.at(-1).seq < lastSeq) gaps.push({ after: ordered.at(-1).seq, before: lastSeq+1, reason: "snapshot event tail missing" });
  return { events: ordered, gaps };
}

export async function collectTrees(project, allowedProjectDirectory) {
  if (!allowedProjectDirectory) return { status: "unverified", reason: "No local project directory configured" };
  const root = await fs.realpath(allowedProjectDirectory);
  const safePath = async (candidate) => {
    const actual = await fs.realpath(candidate);
    if (actual !== root && !actual.startsWith(root+path.sep)) throw Error("Git path is outside the registered project directory");
    return actual;
  };
  const git = async (directory, args) => (await exec("git", ["-C", directory, ...args], {
    encoding: "utf8", maxBuffer: 8*1024*1024, timeout: 20_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
  })).stdout;
  const repository = project.git?.repository?.localPath;
  if (!repository) return { status: "unverified", reason: "Repository not initialized" };
  const repo = await safePath(repository);
  const heads = new Set([
    ...(project.scopedPullRequests ?? []), ...(project.pullRequests ?? [])
  ].flatMap((p) => [p.headSha, p.mergeCommitSha]).concat((project.scopedAgentReports ?? []).map((r) => r.headSha)).filter(Boolean));
  const trees = [];
  for (const sha of heads) {
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw Error("Invalid recorded commit SHA");
    try {
      await git(repo, ["rev-parse", "--verify", `${sha}^{commit}`]);
      const tree = await git(repo, ["ls-tree", "-r", "--full-tree", "-z", sha]);
      trees.push({ sha, entries: tree.split("\0").filter(Boolean).map((line) => {
        const [header, ...name] = line.split("\t");
        const [mode, type, object] = header.split(" ");
        return { mode, type, object, path: name.join("\t") };
      }) });
    } catch (error) { trees.push({ sha, error: error.message }); }
  }
  const worktrees = [];
  for (const directory of new Set((project.scopedExecutions ?? []).map((e) => e.worktreePath))) {
    try {
      const real = await safePath(directory);
      const [head, branch, status] = await Promise.all([git(real,["rev-parse","HEAD"]),git(real,["symbolic-ref","--short","HEAD"]),git(real,["status","--porcelain=v1","--untracked-files=normal"])]);
      worktrees.push({ directory, head: head.trim(), branch: branch.trim(), status });
    } catch (error) { worktrees.push({ directory, error: error.message }); }
  }
  return { status: trees.some((t) => t.error) || worktrees.some((w) => w.error) ? "partial" : heads.size ? "observed" : "pending-delivery", trees, worktrees };
}

export async function captureProject(api, registration, output, localProjectDirectory) {
  if (!/^R(?:0[1-9]|1[0-6])$/.test(registration.code) || !/^prj_[a-f0-9]{32}$/.test(registration.projectId)) throw Error("Invalid R registration");
  const directory = path.join(output, registration.code);
  await fs.mkdir(directory, { recursive: true });
  const at = new Date().toISOString();
  const previous = JSON.parse(await fs.readFile(path.join(directory,"cursor.json"),"utf8").catch((error) => {
    if (error.code === "ENOENT") return '{"seq":0}'; throw error;
  }));
  const { project } = await api(`/projects/${registration.projectId}?view=state`);
  if (project?.id !== registration.projectId) throw Error("State belongs to another project");
  await json(path.join(directory, `state-${project.eventSeq}-${Date.now()}.json`), { at, project });
  const history = await collectEvents(api, project.id, project.eventSeq, previous.seq);
  const evidence = eventEvidence(history.events);
  if (history.events.length || history.gaps.length) {
    await json(path.join(directory, `events-${previous.seq+1}-${project.eventSeq}.json`), history);
    if (evidence.errors.length) await json(path.join(directory, `errors-${previous.seq+1}-${project.eventSeq}.json`), { at, errors: evidence.errors });
  }
  // Advance only after the raw batch is safely stored. Missing data remains an
  // explicit gap, not manufactured lifecycle evidence.
  await json(path.join(directory,"cursor.json"), { seq: history.gaps.length ? previous.seq : project.eventSeq, lastObservedSeq: project.eventSeq });
  let trees;
  try { trees = await collectTrees(project, localProjectDirectory); }
  catch (error) { trees = { status: "unverified", reason: error.message }; }
  await json(path.join(directory, `git-${project.eventSeq}.json`), { at, trees, pullRequests: [...(project.scopedPullRequests ?? []), ...(project.pullRequests ?? [])], reports: project.scopedAgentReports ?? [], merges: project.scopedAgentMerges ?? [], finalMerges: project.scopedGroupFinalMerges ?? [] });
  const row = { code: registration.code, at, ...summarize(project), nativeEvents: evidence.native, eventGaps: history.gaps, gitObservation: trees.status };
  await fs.appendFile(path.join(output,"monitor.jsonl"),JSON.stringify(row)+"\n", { mode: 0o600 });
  return row;
}

async function main() {
  const args = process.argv.slice(2), value = (flag) => args[args.indexOf(flag)+1];
  if (!args.includes("--input")) throw Error("Usage: monitor.mjs --input <stable-run-directory> [--once] [--local-projects-root path] [--timeout-ms 1800000]");
  const directory = path.resolve(value("--input"));
  const launch = JSON.parse(await fs.readFile(path.join(directory,"launch-result.json"),"utf8"));
  const registrations = launch.results.filter((r) => r.projectId);
  if (!registrations.length) throw Error("No registered R projects to monitor");
  const base = launch.base.replace(/\/$/, ""), once = args.includes("--once");
  const timeoutMs = Number(args.includes("--timeout-ms") ? value("--timeout-ms") : 1_800_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error("Invalid monitor duration");
  const api = async (route) => {
    const response = await fetch(`${base}/api${route}`, { signal: AbortSignal.timeout(30_000) });
    const raw = await response.text();
    if (!response.ok) throw Error(`GET ${route}: HTTP ${response.status}: ${raw}`);
    return JSON.parse(raw);
  };
  const started = Date.now();
  for (;;) {
    const rows = [];
    for (const registration of registrations) {
      try {
        const local = args.includes("--local-projects-root") ? path.join(path.resolve(value("--local-projects-root")), registration.projectId) : undefined;
        rows.push(await captureProject(api, registration, directory, local));
      } catch (error) {
        const failure = { at: new Date().toISOString(), code: registration.code, projectId: registration.projectId, observation: "monitor-error", error: error.message, acceptance: "unverified" };
        await fs.appendFile(path.join(directory,"monitor-errors.jsonl"),JSON.stringify(failure)+"\n", { mode: 0o600 });
        rows.push(failure);
      }
    }
    const done = allTerminal(rows);
    await json(path.join(directory,"monitor-summary.json"), { at: new Date().toISOString(), rows, allTerminal: done, acceptance: "unverified", timedOut: Date.now()-started >= timeoutMs });
    console.log(JSON.stringify(rows.map(({ code, status, observation, eventSeq, error }) => ({ code, status, observation, eventSeq, error }))));
    if (once || done || Date.now()-started >= timeoutMs) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
