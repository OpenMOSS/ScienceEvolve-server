import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { GitHubAccountStore } from "./github-accounts.js";
import type { ProjectState } from "./types.js";
import { GitHubRepositoryManagementError } from "./github-repository-management-types.js";
import { redactTrace } from "./utils.js";
import { GitHubAuthorizationError } from "./collaboration-git/errors.js";

const accountIdSchema = z.string().regex(/^gha_[a-f0-9]{32}$/i);
const selectionSchema = z.object({ projectId: z.string().regex(/^prj_[a-f0-9]{32}$/),
  owner: z.string().min(1).max(100), name: z.string().min(1).max(100) }).strict();
const previewSchema = z.object({ repositories: z.array(selectionSchema).min(1).max(100)
  .refine(items => new Set(items.map(item => `${item.owner}/${item.name}`.toLowerCase())).size === items.length,
    "同一批次不能重复选择同一个仓库") }).strict();
const deleteSchema = z.object({ previewId: z.string().regex(/^[a-f0-9]{48}$/), confirmationText: z.literal("永久删除") }).strict();
type Selection = z.infer<typeof selectionSchema>;
export interface RepositoryDeletionItem extends Selection {
  providerId?: number;
  status: "ready" | "deleting" | "deleted" | "failed" | "unconfirmed";
  error?: string;
}
export interface RepositoryDeletionPreview {
  previewId: string; accountId: string; accountProviderId: number; accountLogin: string;
  expiresAt: string; confirmationText: "永久删除"; repositories: RepositoryDeletionItem[];
}
const sameRepository = (project: ProjectState, item: Selection) =>
  project.git?.repository?.owner.toLowerCase() === item.owner.toLowerCase() &&
  project.git.repository.name.toLowerCase() === item.name.toLowerCase();

/** Only repositories already bound to this application's projects are eligible.
 * Preview and execution are separate; credentials never enter the receipt. */
export class GitHubRepositoryManager {
  private readonly inFlight = new Map<string, Promise<RepositoryDeletionPreview>>();
  constructor(private readonly root: string, private readonly accounts: GitHubAccountStore,
    private readonly projects: () => Promise<ProjectState[]>, private readonly now: () => Date = () => new Date()) {}

  async preview(accountId: string, body: unknown): Promise<RepositoryDeletionPreview> {
    accountIdSchema.parse(accountId);
    const input = previewSchema.parse(body), account = await this.accounts.get(accountId);
    if (!account) throw new GitHubRepositoryManagementError(404, "GitHub 账号不存在");
    if (account.status !== "ready" || !account.scopes.includes("delete_repo"))
      throw new GitHubRepositoryManagementError(403, "请先为所选账号授权 delete_repo 仓库删除权限");
    const projects = await this.projects(), repositories: RepositoryDeletionItem[] = [];
    for (const item of input.repositories) {
      try {
        this.assertBinding(projects, accountId, item);
        const identity = await this.accounts.inspectRepositoryForDeletion(accountId, item.owner, item.name);
        repositories.push({ ...item, ...identity, status: "ready" });
      } catch (error) { repositories.push({ ...item, status: "failed", error: this.message(error) }); }
    }
    const preview: RepositoryDeletionPreview = { previewId: randomBytes(24).toString("hex"), accountId,
      accountProviderId: account.providerUserId, accountLogin: account.login,
      expiresAt: new Date(this.now().getTime() + 15 * 60_000).toISOString(), confirmationText: "永久删除", repositories };
    await this.write(preview); return structuredClone(preview);
  }

  async delete(accountId: string, body: unknown): Promise<RepositoryDeletionPreview> {
    accountIdSchema.parse(accountId);
    const input = deleteSchema.parse(body), key = `${accountId}/${input.previewId}`;
    const existing = this.inFlight.get(key); if (existing) return existing;
    const result = this.execute(accountId, input.previewId);
    this.inFlight.set(key, result);
    try { return await result; } finally { this.inFlight.delete(key); }
  }
  private async execute(accountId: string, previewId: string) {
    let preview: RepositoryDeletionPreview;
    try { preview = JSON.parse(await fs.readFile(this.file(previewId), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new GitHubRepositoryManagementError(404, "删除预览不存在，请重新选择仓库");
      throw error;
    }
    if (preview.accountId !== accountId) throw new GitHubRepositoryManagementError(409, "删除预览不属于当前账号");
    if (preview.repositories.some(item => item.status === "ready") && Date.parse(preview.expiresAt) <= this.now().getTime())
      throw new GitHubRepositoryManagementError(410, "删除预览已过期，请重新核对仓库");
    const account = await this.accounts.get(accountId);
    if (!account || account.providerUserId !== preview.accountProviderId)
      throw new GitHubRepositoryManagementError(409, "GitHub 账号身份已变化，请重新授权并生成预览");
    for (const item of preview.repositories) {
      if (item.status === "deleting") {
        item.status = "unconfirmed"; item.error = "服务中断前已发出删除请求，结果待核对；不会自动重试删除";
        await this.write(preview);
      }
      if (item.status !== "ready") continue;
      try {
        this.assertBinding(await this.projects(), accountId, item);
        item.status = "deleting"; await this.write(preview);
        await this.accounts.deleteRepository(accountId, { providerId: item.providerId!, owner: item.owner, name: item.name });
        item.status = "deleted";
      } catch (error) {
        const uncertain = error instanceof GitHubRepositoryManagementError
          ? error.code === "github_repository_deletion_uncertain" : !(error instanceof GitHubAuthorizationError) && item.status === "deleting";
        item.status = uncertain ? "unconfirmed" : "failed"; item.error = this.message(error);
      }
      await this.write(preview);
    }
    return structuredClone(preview);
  }
  private assertBinding(projects: ProjectState[], accountId: string, item: Selection) {
    const project = projects.find(project => project.id === item.projectId);
    if (!project || project.git?.account?.id !== accountId || !sameRepository(project, item))
      throw new GitHubRepositoryManagementError(409, "项目与账号或仓库的关联已变化，请刷新后重新选择");
    if (projects.some(project => sameRepository(project, item) && !["completed", "failed", "cancelled"].includes(project.status)))
      throw new GitHubRepositoryManagementError(409, "此仓库仍关联未结束的项目，请先结束相关项目再删除仓库");
  }
  private message(error: unknown) { return redactTrace(error instanceof Error ? error.message : "GitHub 仓库操作失败"); }
  private file(previewId: string) { return path.join(this.root, ".github-repository-deletions", `${previewId}.json`); }
  private async write(preview: RepositoryDeletionPreview) {
    const file = this.file(preview.previewId), temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      await fs.writeFile(temporary, JSON.stringify(preview), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
}

export function registerGitHubRepositoryManagementRoutes(app: Express, accounts: GitHubAccountStore, manager: GitHubRepositoryManager) {
  const handle = (run: (request: Request, response: Response) => Promise<unknown>) => async (request: Request, response: Response, next: NextFunction) => {
    response.setHeader("Cache-Control", "no-store, private");
    try { await run(request, response); }
    catch (error) {
      if (error instanceof GitHubRepositoryManagementError) {
        response.status(error.status).json({ error: redactTrace(error.message), code: error.code }); return;
      }
      if (error instanceof Error && error.message.startsWith("GitHub OAuth 尚未配置")) {
        response.status(503).json({ error: redactTrace(error.message) }); return;
      }
      next(error);
    }
  };
  app.post("/api/github/accounts/:accountId/repository-deletion-authorization", handle(async (request, response) => {
    const accountId = accountIdSchema.parse(request.params.accountId);
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    response.json(await accounts.startRepositoryDeletionAuthorization(accountId, origin));
  }));
  app.post("/api/github/accounts/:accountId/repositories/delete-preview", handle(async (request, response) => {
    response.json(await manager.preview(accountIdSchema.parse(request.params.accountId), request.body));
  }));
  app.post("/api/github/accounts/:accountId/repositories/delete-batch", handle(async (request, response) => {
    response.json(await manager.delete(accountIdSchema.parse(request.params.accountId), request.body));
  }));
}
