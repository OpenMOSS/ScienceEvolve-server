import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { ProjectStorage } from "../src/storage.js";
import { EventHub } from "../src/event-hub.js";
import { createApp, type AppDependencies } from "../src/app.js";
import type { ArtifactRecord, ProjectState } from "../src/types.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture(schemaVersion = 3) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-git-artifact-read-")); roots.push(root);
  const storage = new ProjectStorage(root, new EventHub());
  const id = `prj_${"a".repeat(32)}`;
  const projectRoot = storage.projectDir(id);
  const repository = path.join(projectRoot, "repository");
  await fs.mkdir(repository, { recursive: true });
  const git = async (...args: string[]) => (await exec("git", args, { cwd: repository })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.test");
  const state = { id, agents: { writer: {} }, orchestration: { schemaVersion },
    git: { enabled: true, repository: { localPath: repository } }, artifacts: [], executions: [], pullRequests: [] } as unknown as ProjectState;
  vi.spyOn(storage, "loadState").mockResolvedValue(state);
  const publish = async (content: string, version: number) => {
    await fs.writeFile(path.join(repository, "report.md"), content);
    await git("add", "report.md"); await git("commit", "-m", `Publication ${version}`);
    const commitSha = await git("rev-parse", "HEAD");
    const executionId = `execution-${version}`, pullRequestId = `pr-${version}`;
    const worktreePath = schemaVersion === 3 ? path.join(projectRoot, "git-worktrees", "agents", "writer") : path.join(projectRoot, "git-worktrees", executionId);
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(path.join(worktreePath, "report.md"), "unaccepted mutable bytes");
    state.executions!.push({ id: executionId, agentId: "writer", ownershipEpoch: version, status: "succeeded", worktreePath } as never);
    state.pullRequests!.push({ id: pullRequestId, ownerExecutionId: executionId, status: "merged", headSha: commitSha, base: "main" } as never);
    const artifact: ArtifactRecord = { id: `artifact-${version}`, agent: "writer", path: "report.md", title: "Research report", kind: "markdown", description: "Accepted output",
      size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex"), updatedAt: `2026-10-13T12:00:0${version}.000Z`,
      gitSource: { executionId, ownershipEpoch: version, worktreePath, commitSha, pullRequestId, acceptedBase: "main" } };
    state.artifacts!.push(artifact);
    return artifact;
  };
  const app = createApp({ storage, orchestrator: { getProject: async () => state }, skills: {}, eventHub: {},
    config: { modelSuggestions: [], maxEventHistory: 10 } } as unknown as AppDependencies);
  return { storage, state, publish, app, projectRoot, repository, git };
}

describe("accepted Git artifact reads", () => {
  it("browses unpublished Git workspace files in one directory while preserving exact publication reads", async () => {
    const f = await fixture(), accepted = await f.publish("# Accepted result\n", 1);
    const worktree = accepted.gitSource!.worktreePath;
    await fs.rm(worktree, { recursive: true });
    await f.git("worktree", "add", "-b", "writer-working", worktree);
    await fs.writeFile(path.join(worktree, "report.md"), "# Work in progress\n");
    await fs.mkdir(path.join(worktree, "results"));
    await fs.writeFile(path.join(worktree, "results/metrics.json"), '{"score":0.75}');
    await fs.mkdir(path.join(f.projectRoot, "workspaces"));
    await fs.writeFile(path.join(f.projectRoot, "workspaces/input.txt"), "shared input");
    const root = await request(f.app).get(`/api/projects/${f.state.id}/artifacts`).query({ view: "directory", scope: "project" }).expect(200);
    expect(root.body.entries.map((item: any) => item.name)).toEqual(["results", "input.txt", "report.md"]);
    const report = root.body.entries.find((item: any) => item.path === "report.md");
    expect(report.variants).toHaveLength(3);
    const working = report.variants.find((item: any) => item.workspaceLabel === "工作区 · writer");
    expect(working.workspaceId).toMatch(/^worktree_[a-f0-9]{24}$/);
    const live = await request(f.app).get(`/api/projects/${f.state.id}/artifacts/content`).query({ path: working.path, workspaceId: working.workspaceId }).expect(200);
    expect(live.text).toBe("# Work in progress\n");
    const published = await request(f.app).get(`/api/projects/${f.state.id}/artifacts/content`).query({ agent: "writer", path: accepted.path,
      artifactId: accepted.id, commitSha: accepted.gitSource!.commitSha }).expect(200);
    expect(published.text).toBe("# Accepted result\n");
    const results = await request(f.app).get(`/api/projects/${f.state.id}/artifacts`).query({ view: "directory", scope: "project", directory: "results" }).expect(200);
    expect(results.body.entries[0]).toMatchObject({ path: "results/metrics.json", workspaceId: working.workspaceId });
    const search = await request(f.app).get(`/api/projects/${f.state.id}/artifacts`).query({ scope: "project", q: "metrics" }).expect(200);
    expect(search.body.artifacts).toHaveLength(1);
    expect(search.body.artifacts[0].workspaceId).toBe(working.workspaceId);
    await request(f.app).get(`/api/projects/${f.state.id}/artifacts/content`).query({ path: working.path, workspaceId: working.workspaceId, artifactId: accepted.id }).expect(400);
  });

  it("shows live files even when no Git publication is accepted, without treating them as published evidence", async () => {
    const f = await fixture(), accepted = await f.publish("# Pending publication\n", 1);
    f.state.pullRequests![0].status = "open";
    expect(await f.storage.listArtifactSummary(f.state.id)).toMatchObject({ total: 0 });
    const summary = await request(f.app).get(`/api/projects/${f.state.id}/artifacts`).query({ view: "summary", scope: "project" }).expect(200);
    expect(summary.body.total).toBe(1);
    const directory = await request(f.app).get(`/api/projects/${f.state.id}/artifacts`).query({ view: "directory", scope: "project" }).expect(200);
    expect(directory.body.entries[0]).toMatchObject({ path: "report.md", workspaceId: "repository" });
    await expect(f.storage.resolvePublishedArtifactRecord(f.state.id, accepted)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("excludes hidden paths, links and foreign workspace roots from unified browsing", async () => {
    const f = await fixture(); await f.publish("# Visible\n", 1);
    const outside = path.join(path.dirname(f.projectRoot), "private.txt");
    await fs.writeFile(outside, "outside project secret");
    await fs.writeFile(path.join(f.repository, ".secret"), "hidden");
    await fs.symlink(outside, path.join(f.repository, "leak.md"));
    await fs.link(outside, path.join(f.repository, "hard-link.md"));
    await fs.symlink(path.dirname(outside), path.join(f.repository, "linked-directory"));
    const catalog = await f.storage.listArtifactPage(f.state.id, { scope: "project" });
    expect(catalog.artifacts.map(item => item.path)).toEqual(["report.md"]);
    for (const filename of [".git/config", ".secret", "leak.md", "hard-link.md", "linked-directory/private.txt"])
      await expect(f.storage.resolveBrowserWorkspaceFile(f.state.id, "repository", filename)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(f.storage.resolveBrowserWorkspaceFile(f.state.id, "worktree_000000000000000000000000", "private.txt")).rejects.toMatchObject({ code: "ENOENT" });
    await request(f.app).get(`/api/projects/${f.state.id}/artifacts/content`).query({ path: "../private.txt", workspaceId: "repository" }).expect(400);
  });

  it("browses the normal shared workspace without requiring any Agent filter", async () => {
    const f = await fixture(); f.state.git!.enabled = false;
    await fs.mkdir(path.join(f.projectRoot, "workspaces/results"), { recursive: true });
    await fs.writeFile(path.join(f.projectRoot, "workspaces/results/data.csv"), "x,y\n1,2\n");
    const root = await request(f.app).get(`/api/projects/${f.state.id}/artifacts`).query({ view: "directory", scope: "project" }).expect(200);
    expect(root.body.entries).toMatchObject([{ type: "directory", path: "results" }]);
    const directory = await request(f.app).get(`/api/projects/${f.state.id}/artifacts`).query({ view: "directory", scope: "project", directory: "results", limit: 1 }).expect(200);
    expect(directory.body.entries).toMatchObject([{ path: "results/data.csv", workspaceId: "shared" }]);
    const content = await request(f.app).get(`/api/projects/${f.state.id}/artifacts/content`).query({ path: "results/data.csv", workspaceId: "shared" }).expect(200);
    expect(content.text).toBe("x,y\n1,2\n");
  });
  it.each([2, 3])("keeps schema %i publications visible after execution worktrees are removed", async schema => {
    const f = await fixture(schema), artifact = await f.publish("# Accepted research\n", 1);
    await fs.rm(artifact.gitSource!.worktreePath, { recursive: true });
    expect(await f.storage.listArtifactSummary(f.state.id)).toMatchObject({ groups: { writer: 1 }, total: 1 });
    const source = await f.storage.resolvePublishedArtifactRecord(f.state.id, artifact);
    expect(source.sourcePath.startsWith(path.join(f.projectRoot, "runtime", "git-artifacts") + path.sep)).toBe(true);
    expect(await fs.readFile(source.sourcePath, "utf8")).toBe("# Accepted research\n");
    expect((await f.storage.listArtifactDirectory(f.state.id, "writer")).entries[0]).toMatchObject({ id: artifact.id, commitSha: artifact.gitSource!.commitSha });
  });

  it("reads and verifies the selected publication when multiple commits publish the same path", async () => {
    const f = await fixture(), old = await f.publish("# Original result\n", 1), latest = await f.publish("# Revised result\n", 2);
    f.state.artifacts!.reverse();
    expect((await f.storage.listArtifactDirectory(f.state.id, "writer")).entries[0]?.id).toBe(latest.id);
    for (const [artifact, expected] of [[old, "# Original result\n"], [latest, "# Revised result\n"]] as const) {
      const response = await request(f.app).get(`/api/projects/${f.state.id}/artifacts/content`).query({ agent: "writer", path: artifact.path,
        artifactId: artifact.id, commitSha: artifact.gitSource!.commitSha }).expect(200);
      expect(response.text).toBe(expected);
    }
    // Match the resolver's last-record rule when two publications share a timestamp.
    latest.updatedAt = old.updatedAt;
    const unbound = await request(f.app).get(`/api/projects/${f.state.id}/artifacts/content`).query({ agent: "writer", path: "report.md" }).expect(200);
    expect(unbound.text).toBe("# Original result\n");
  });

  it("uses the accepted Git object identity for historical publications without SHA-256", async () => {
    const f = await fixture(), artifact = await f.publish("# Historical result\n", 1);
    delete artifact.sha256;
    const source = await f.storage.resolvePublishedArtifactRecord(f.state.id, artifact);
    expect(await fs.readFile(source.sourcePath, "utf8")).toBe("# Historical result\n");
  });

  it("does not expose mutable worktree files or publications without accepted merge facts", async () => {
    const f = await fixture(), artifact = await f.publish("# Accepted result\n", 1);
    f.state.pullRequests![0]!.status = "open";
    expect(await f.storage.listArtifactSummary(f.state.id)).toMatchObject({ total: 0 });
    await expect(f.storage.resolvePublishedArtifactRecord(f.state.id, artifact)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
