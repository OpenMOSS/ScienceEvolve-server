import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const stoppedStatuses = new Set(["interrupted", "paused", "failed", "cancelled", "canceled", "stopped"]);

export function projectSnapshot(project) {
  if (!project || typeof project.id !== "string" || typeof project.status !== "string" ||
      typeof project.phase !== "string" || !Number.isSafeInteger(project.eventSeq)) {
    throw new Error("Project state is missing its identity, status, phase or event sequence");
  }
  return {
    projectId: project.id, title: project.title, status: project.status, phase: project.phase,
    currentAgent: project.currentAgent ?? null, eventSeq: project.eventSeq,
    updatedAt: project.updatedAt, lastError: project.lastError ?? null,
    intervention: project.userIntervention?.status ?? null,
    activeActivities: project.runtime?.activities.length,
    artifacts: project.artifacts?.length ?? 0
  };
}

export function transitionNotification(previous, current) {
  const kind = current.observationError ? "monitor-error"
    : current.status === "completed" ? "completed"
    : stoppedStatuses.has(current.status) || current.phase === "user-intervention-required" || current.intervention === "pending" ||
      current.lastError && current.activeActivities === 0
      ? "stopped" : "running";
  const priorKind = previous && (previous.observationError ? "monitor-error"
    : previous.status === "completed" ? "completed"
    : stoppedStatuses.has(previous.status) || previous.phase === "user-intervention-required" || previous.intervention === "pending" ||
      previous.lastError && previous.activeActivities === 0
      ? "stopped" : "running");
  if (kind === "running") return priorKind === "monitor-error" ? "observation-restored"
    : priorKind && priorKind !== "running" ? "resumed" : undefined;
  return kind !== priorKind || current.status !== previous?.status || current.phase !== previous?.phase ||
    current.lastError !== previous?.lastError || current.observationError !== previous?.observationError
    ? kind : undefined;
}

export async function monitorOnce({ baseUrl, projectIds, previous = {}, request = fetch }) {
  const results = await Promise.allSettled(projectIds.map(async projectId => {
    const response = await request(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}?view=state`, {
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`Project state HTTP ${response.status}`);
    const { project } = await response.json();
    if (project?.id !== projectId) throw new Error("Project endpoint returned a different project");
    return projectSnapshot(project);
  }));
  const projects = Object.fromEntries(results.map((result, index) => [projectIds[index], result.status === "fulfilled"
    ? result.value : { projectId: projectIds[index], observationError: result.reason instanceof Error ? result.reason.message : String(result.reason) }]));
  const notifications = Object.values(projects).flatMap(project => {
    const kind = transitionNotification(previous[project.projectId], project);
    return kind ? [{ at: new Date().toISOString(), kind, ...project }] : [];
  });
  return { at: new Date().toISOString(), projects, notifications,
    allCompleted: projectIds.length > 0 && Object.values(projects).every(project => project.status === "completed") };
}

async function main() {
  const args = process.argv.slice(2), projectIds = [];
  let baseUrl = "http://127.0.0.1:4310", output, interval = 15, once = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--once") { once = true; continue; }
    if (!["--project", "--base-url", "--output", "--interval-seconds"].includes(arg) || !args[index + 1])
      throw new Error("Usage: monitor-projects.mjs --project <id> [--project <id>] --output <directory> [--base-url <url>] [--interval-seconds 15] [--once]");
    const value = args[++index];
    if (arg === "--project") projectIds.push(value);
    else if (arg === "--base-url") baseUrl = value.replace(/\/$/, "");
    else if (arg === "--output") output = path.resolve(value);
    else interval = Number(value);
  }
  if (!output || !projectIds.length || new Set(projectIds).size !== projectIds.length ||
      projectIds.some(id => !/^prj_[a-f0-9]{32}$/.test(id)) || !Number.isFinite(interval) || interval < 1)
    throw new Error("A notification directory, unique project IDs and a positive polling interval are required");
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Monitor URL must be an HTTP service URL without credentials, query or fragment");
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(path.join(output, "status.json"), "utf8")).projects; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (;;) {
    const snapshot = await monitorOnce({ baseUrl, projectIds, previous });
    const temporary = path.join(output, `status.${process.pid}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(temporary, path.join(output, "status.json"));
    for (const notification of snapshot.notifications) {
      const line = JSON.stringify(notification);
      await fs.appendFile(path.join(output, "notifications.jsonl"), line + "\n", { mode: 0o600 });
      console.log(line);
    }
    const changed = JSON.stringify(Object.values(previous).map(p => [p.projectId, p.status, p.phase, p.currentAgent])) !==
      JSON.stringify(Object.values(snapshot.projects).map(p => [p.projectId, p.status, p.phase, p.currentAgent]));
    if (changed || once) console.log(JSON.stringify({ at: snapshot.at, kind: "status", projects: snapshot.projects }));
    previous = snapshot.projects;
    if (once || snapshot.allCompleted) return;
    await new Promise(resolve => setTimeout(resolve, interval * 1000));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
