import { promises as fs } from "node:fs";
import path from "node:path";
import { Router, type Express } from "express";
import { z } from "zod";
import { batchProjectIdsSchema } from "./validation.js";
import { newId } from "./utils.js";

const folderIdSchema = z.string().regex(/^folder_[a-f0-9]{32}$/);
const folderNameSchema = z.string().trim().min(1, "请输入文件夹名称").max(80, "文件夹名称最多 80 个字符")
  .refine(name => !/[\u0000-\u001f\u007f]/.test(name), "文件夹名称不能包含控制字符");
const nameInputSchema = z.object({ name: folderNameSchema }).strict();
const moveInputSchema = batchProjectIdsSchema.extend({ folderId: folderIdSchema.nullable() }).strict();
const folderSchema = z.object({
  id: folderIdSchema,
  name: folderNameSchema,
  projectIds: z.array(z.string().regex(/^prj_[a-f0-9]{32}$/))
}).strict();
const documentSchema = z.object({ folders: z.array(folderSchema) }).strict().superRefine((document, context) => {
  const ids = new Set<string>(), names = new Set<string>(), projects = new Set<string>();
  for (const [index, folder] of document.folders.entries()) {
    if (ids.has(folder.id) || names.has(folder.name.toLowerCase())) {
      context.addIssue({ code: "custom", path: ["folders", index], message: "文件夹 ID 或名称重复" });
    }
    ids.add(folder.id); names.add(folder.name.toLowerCase());
    for (const projectId of folder.projectIds) {
      if (projects.has(projectId)) context.addIssue({ code: "custom", path: ["folders", index, "projectIds"], message: `项目重复分类：${projectId}` });
      projects.add(projectId);
    }
  }
});

export type ProjectFolder = z.infer<typeof folderSchema>;

class ProjectFolderError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Project-list organization is stored separately from execution checkpoints. */
export class ProjectFolderStore {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(private readonly root: string, private readonly projectExists: (projectId: string) => Promise<boolean>) {
    this.file = path.join(root, "project-folders.json");
  }

  async list(): Promise<ProjectFolder[]> {
    await this.mutationTail;
    return this.read();
  }

  async create(input: unknown): Promise<ProjectFolder[]> {
    const { name } = nameInputSchema.parse(input);
    return this.mutate(async folders => {
      this.assertAvailableName(folders, name);
      folders.push({ id: newId("folder"), name, projectIds: [] });
    });
  }

  async rename(folderId: string, input: unknown): Promise<ProjectFolder[]> {
    folderIdSchema.parse(folderId);
    const { name } = nameInputSchema.parse(input);
    return this.mutate(async folders => {
      const folder = this.requireFolder(folders, folderId);
      this.assertAvailableName(folders, name, folderId);
      folder.name = name;
    });
  }

  async delete(folderId: string): Promise<ProjectFolder[]> {
    folderIdSchema.parse(folderId);
    return this.mutate(async folders => {
      this.requireFolder(folders, folderId);
      folders.splice(folders.findIndex(folder => folder.id === folderId), 1);
    });
  }

  async move(input: unknown): Promise<ProjectFolder[]> {
    const { projectIds, folderId } = moveInputSchema.parse(input);
    return this.mutate(async folders => {
      const target = folderId === null ? undefined : this.requireFolder(folders, folderId);
      // Validate the entire selection before changing any membership.
      for (const projectId of projectIds) {
        if (!await this.projectExists(projectId)) throw new ProjectFolderError(404, `项目不存在：${projectId}`);
      }
      const selected = new Set(projectIds);
      for (const folder of folders) folder.projectIds = folder.projectIds.filter(id => !selected.has(id));
      if (target) target.projectIds.push(...projectIds);
    });
  }

  private requireFolder(folders: ProjectFolder[], folderId: string): ProjectFolder {
    const folder = folders.find(item => item.id === folderId);
    if (!folder) throw new ProjectFolderError(404, "文件夹不存在，请刷新后重试");
    return folder;
  }

  private assertAvailableName(folders: ProjectFolder[], name: string, exceptId?: string): void {
    if (folders.some(folder => folder.id !== exceptId && folder.name.toLowerCase() === name.toLowerCase())) {
      throw new ProjectFolderError(409, "文件夹名称已存在");
    }
  }

  private async read(): Promise<ProjectFolder[]> {
    let text: string;
    try { text = await fs.readFile(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch (error) { throw new Error(`项目文件夹分类文件不是有效 JSON：${this.file}`, { cause: error }); }
    const result = documentSchema.safeParse(value);
    if (!result.success) throw new Error(`项目文件夹分类数据无效：${this.file}：${result.error.message}`);
    return result.data.folders;
  }

  private mutate(change: (folders: ProjectFolder[]) => Promise<void>): Promise<ProjectFolder[]> {
    const operation = this.mutationTail.then(async () => {
      const folders = await this.read();
      await change(folders);
      await fs.mkdir(this.root, { recursive: true });
      const temporary = `${this.file}.${process.pid}.${newId("tmp")}`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify({ folders }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await fs.rename(temporary, this.file);
      } finally { await fs.rm(temporary, { force: true }); }
      return folders;
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export function registerProjectFolderRoutes(app: Express, store: ProjectFolderStore): void {
  const router = Router();
  router.get("/", async (_request, response, next) => {
    try { response.setHeader("Cache-Control", "no-store"); response.json({ folders: await store.list() }); }
    catch (error) { next(error); }
  });
  router.post("/", async (request, response, next) => {
    try { response.status(201).json({ folders: await store.create(request.body) }); }
    catch (error) { next(error); }
  });
  router.patch("/:folderId", async (request, response, next) => {
    try { response.json({ folders: await store.rename(request.params.folderId, request.body) }); }
    catch (error) { next(error); }
  });
  router.delete("/:folderId", async (request, response, next) => {
    try { response.json({ folders: await store.delete(request.params.folderId) }); }
    catch (error) { next(error); }
  });
  router.put("/assignments", async (request, response, next) => {
    try { response.json({ folders: await store.move(request.body) }); }
    catch (error) { next(error); }
  });
  router.use((error: unknown, _request: import("express").Request, response: import("express").Response, next: import("express").NextFunction) => {
    if (error instanceof ProjectFolderError) response.status(error.status).json({ error: error.message });
    else next(error);
  });
  app.use("/api/project-folders", router);
}
