import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { GitHubRepositoryManager } from "../src/github-repository-management.js";
import { GitHubRepositoryManagementError } from "../src/github-repository-management-types.js";
import { createApp } from "../src/app.js";
import { EventHub } from "../src/event-hub.js";
import { ProjectStorage } from "../src/storage.js";
import type { GitHubAccountRecord, GitHubAccountStore } from "../src/github-accounts.js";
import type { ProjectState } from "../src/types.js";
import type { Orchestrator } from "../src/orchestrator.js";
import type { SkillCatalog } from "../src/skill-catalog.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-repository-deletion-")); roots.push(root);
  const account: GitHubAccountRecord = { id: `gha_${"a".repeat(32)}`, login: "alice", providerUserId: 7,
    status: "ready", scopes: ["repo", "delete_repo"], isDefault: true, createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z" };
  const projects = ["A", "B"].map((name, index) => ({ id: `prj_${String(index + 1).repeat(32)}`, title: name, status: "completed",
    git: { enabled: true, account: { id: account.id, login: account.login, providerUserId: account.providerUserId },
      repository: { owner: "alice", name, htmlUrl: `https://github.com/alice/${name}`, defaultBranch: "main", private: true, localPath: "repository" } }
  } as ProjectState));
  const accounts = { get: vi.fn(async () => account),
    inspectRepositoryForDeletion: vi.fn(async (_id: string, owner: string, name: string) => ({ providerId: name === "A" ? 101 : 102, owner, name })),
    deleteRepository: vi.fn(async () => undefined),
    startRepositoryDeletionAuthorization: vi.fn(async () => ({ authorizationUrl: "https://github.com/login/oauth/authorize?scope=repo+delete_repo", expiresAt: "2026-10-25T01:00:00.000Z" })) };
  let now = new Date("2026-10-25T00:00:00.000Z");
  const manager = new GitHubRepositoryManager(root, accounts as unknown as GitHubAccountStore, async () => projects, () => now);
  const selections = projects.map(project => ({ projectId: project.id, owner: "alice", name: project.git!.repository!.name }));
  const eventHub = new EventHub(), storage = new ProjectStorage(root, eventHub);
  vi.spyOn(storage, "listStates").mockImplementation(async () => projects);
  const app = createApp({ orchestrator: {} as Orchestrator, storage, eventHub, skills: {} as SkillCatalog,
    githubAccounts: accounts as unknown as GitHubAccountStore, config: { modelSuggestions: [], maxEventHistory: 100 } });
  return { root, account, projects, accounts, manager, selections, app,
    setNow: (value: string) => { now = new Date(value); } };
}

describe("account-bound repository deletion", () => {
  it("previews first and deletes each confirmed repository once across concurrent retries and a restart", async () => {
    const f = await setup(), originalProjects = structuredClone(f.projects);
    const preview = await f.manager.preview(f.account.id, { repositories: f.selections });
    expect(preview.repositories.map(item => item.status)).toEqual(["ready", "ready"]);
    expect(f.accounts.deleteRepository).not.toHaveBeenCalled();
    await expect(f.manager.delete(f.account.id, { previewId: preview.previewId, confirmationText: "删除" })).rejects.toThrow();
    const input = { previewId: preview.previewId, confirmationText: preview.confirmationText };
    const [first, replay] = await Promise.all([f.manager.delete(f.account.id, input), f.manager.delete(f.account.id, input)]);
    expect(first).toEqual(replay);
    expect(first.repositories.map(item => item.status)).toEqual(["deleted", "deleted"]);
    expect(f.accounts.deleteRepository).toHaveBeenCalledTimes(2);
    const restarted = new GitHubRepositoryManager(f.root, f.accounts as unknown as GitHubAccountStore, async () => f.projects);
    expect(await restarted.delete(f.account.id, input)).toEqual(first);
    expect(f.accounts.deleteRepository).toHaveBeenCalledTimes(2);
    expect(f.projects).toEqual(originalProjects);
    expect(await fs.readdir(f.root)).not.toContain("projects");
  });

  it("blocks active shared repositories and preserves partial failures", async () => {
    const f = await setup(); f.projects[1]!.status = "running";
    const preview = await f.manager.preview(f.account.id, { repositories: f.selections });
    expect(preview.repositories.map(item => item.status)).toEqual(["ready", "failed"]);
    expect(preview.repositories[1]!.error).toContain("未结束");
    const result = await f.manager.delete(f.account.id, { previewId: preview.previewId, confirmationText: "永久删除" });
    expect(result.repositories.map(item => item.status)).toEqual(["deleted", "failed"]);
    expect(f.accounts.deleteRepository).toHaveBeenCalledOnce();
    const shared = await setup();
    shared.projects.push({ ...shared.projects[0]!, id: `prj_${"f".repeat(32)}`, status: "paused" });
    const blocked = await shared.manager.preview(shared.account.id, { repositories: [shared.selections[0]] });
    expect(blocked.repositories[0]!.status).toBe("failed");
    expect(shared.accounts.inspectRepositoryForDeletion).not.toHaveBeenCalled();
  });

  it("rejects cross-account/changed bindings, rechecks running state at confirmation and excludes unlinked repositories", async () => {
    const f = await setup();
    const preview = await f.manager.preview(f.account.id, { repositories: f.selections });
    f.projects[0]!.status = "running";
    f.projects[1]!.git!.repository!.name = "another-repository";
    const result = await f.manager.delete(f.account.id, { previewId: preview.previewId, confirmationText: "永久删除" });
    expect(result.repositories.map(item => item.status)).toEqual(["failed", "failed"]);
    expect(f.accounts.deleteRepository).not.toHaveBeenCalled();
    const foreign = await f.manager.preview(`gha_${"b".repeat(32)}`, { repositories: f.selections });
    expect(foreign.repositories.every(item => item.status === "failed")).toBe(true);
  });

  it("keeps an uncertain DELETE as unknown and never automatically submits it again", async () => {
    const f = await setup();
    f.accounts.deleteRepository.mockRejectedValueOnce(new GitHubRepositoryManagementError(502, "结果待核对", "github_repository_deletion_uncertain"));
    const preview = await f.manager.preview(f.account.id, { repositories: f.selections });
    const input = { previewId: preview.previewId, confirmationText: "永久删除" };
    const result = await f.manager.delete(f.account.id, input);
    expect(result.repositories.map(item => item.status)).toEqual(["unconfirmed", "deleted"]);
    expect(await f.manager.delete(f.account.id, input)).toEqual(result);
    expect(f.accounts.deleteRepository).toHaveBeenCalledTimes(2);
  });

  it("does not replay an interrupted in-flight DELETE and can finish the remaining selections", async () => {
    const f = await setup();
    const preview = await f.manager.preview(f.account.id, { repositories: f.selections });
    preview.repositories[0]!.status = "deleting";
    await fs.writeFile(path.join(f.root, ".github-repository-deletions", `${preview.previewId}.json`), JSON.stringify(preview));
    const result = await f.manager.delete(f.account.id, { previewId: preview.previewId, confirmationText: "永久删除" });
    expect(result.repositories.map(item => item.status)).toEqual(["unconfirmed", "deleted"]);
    expect(f.accounts.deleteRepository).toHaveBeenCalledOnce();
  });

  it("expires unconfirmed previews and rejects missing scopes without sending DELETE", async () => {
    const f = await setup();
    const preview = await f.manager.preview(f.account.id, { repositories: f.selections });
    f.setNow("2026-10-25T00:16:00.000Z");
    await expect(f.manager.delete(f.account.id, { previewId: preview.previewId, confirmationText: "永久删除" })).rejects.toMatchObject({ status: 410 });
    f.account.scopes = ["repo"];
    await expect(f.manager.preview(f.account.id, { repositories: f.selections })).rejects.toMatchObject({ status: 403 });
    expect(f.accounts.deleteRepository).not.toHaveBeenCalled();
  });

  it("serves strict preview/confirm HTTP endpoints with account binding, partial results and no secrets", async () => {
    const f = await setup(), base = `/api/github/accounts/${f.account.id}`;
    const response = await request(f.app).post(`${base}/repositories/delete-preview`).send({ repositories: f.selections }).expect(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    const input = { previewId: response.body.previewId, confirmationText: "永久删除" };
    await request(f.app).post(`${base}/repositories/delete-batch`).send({ ...input, confirmationText: "" }).expect(400);
    expect(f.accounts.deleteRepository).not.toHaveBeenCalled();
    await request(f.app).post(`/api/github/accounts/gha_${"b".repeat(32)}/repositories/delete-batch`).send(input).expect(409);
    const result = await request(f.app).post(`${base}/repositories/delete-batch`).send(input).expect(200);
    expect(result.body.repositories.map((item: any) => item.status)).toEqual(["deleted", "deleted"]);
    await request(f.app).post(`${base}/repositories/delete-batch`).send(input).expect(200);
    expect(f.accounts.deleteRepository).toHaveBeenCalledTimes(2);
    await request(f.app).post(`${base}/repositories/delete-preview`).send({ repositories: [f.selections[0], f.selections[0]] }).expect(400);
    await request(f.app).post(`${base}/repository-deletion-authorization`).send({}).expect(200);
    expect(f.accounts.startRepositoryDeletionAuthorization).toHaveBeenCalledWith(f.account.id, undefined);
    f.accounts.startRepositoryDeletionAuthorization.mockRejectedValueOnce(new Error("GitHub OAuth 尚未配置"));
    await request(f.app).post(`${base}/repository-deletion-authorization`).send({}).expect(503);
    expect(JSON.stringify(result.body)).not.toMatch(/token|secret|credential/i);
  });
});
