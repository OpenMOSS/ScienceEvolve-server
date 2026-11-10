import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import request from "supertest";
import { ProjectFolderStore } from "../src/project-folders.js";
import { createApp } from "../src/app.js";
import { ProjectStorage } from "../src/storage.js";
import { EventHub } from "../src/event-hub.js";
import type { Orchestrator } from "../src/orchestrator.js";
import type { SkillCatalog } from "../src/skill-catalog.js";
import type { ProjectState } from "../src/types.js";

const first = `prj_${"1".repeat(32)}`, second = `prj_${"2".repeat(32)}`, missing = `prj_${"3".repeat(32)}`;
const scratch = path.resolve(import.meta.dirname, "../../.scratch/project-folders-tests");
const roots: string[] = [];
async function fixture() {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "case-")); roots.push(root);
  const exists = vi.fn(async (id: string) => [first, second].includes(id));
  return { root, exists, store: new ProjectFolderStore(root, exists), file: path.join(root, "project-folders.json") };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
afterAll(() => fs.rmdir(scratch));

describe("project folder storage", () => {
  it("starts unclassified and persists names and memberships across store instances", async () => {
    const { store, root, exists } = await fixture();
    expect(await store.list()).toEqual([]);
    const [folder] = await store.create({ name: " 文献研究 " });
    await store.move({ projectIds: [first], folderId: folder.id });
    expect(await new ProjectFolderStore(root, exists).list()).toEqual([{ ...folder, name: "文献研究", projectIds: [first] }]);
  });

  it("moves an entire batch exclusively between folders and back to unclassified", async () => {
    const { store } = await fixture();
    const [a] = await store.create({ name: "理论" });
    const [, b] = await store.create({ name: "实验" });
    await store.move({ projectIds: [first, second], folderId: a.id });
    expect(await store.move({ projectIds: [first], folderId: b.id })).toEqual([
      { ...a, projectIds: [second] }, { ...b, projectIds: [first] }
    ]);
    expect(await store.move({ projectIds: [first, second], folderId: null })).toEqual([a, b]);
  });

  it("renames and deletes a populated folder while preserving other classifications", async () => {
    const { store } = await fixture();
    const [a] = await store.create({ name: "理论" });
    const [, b] = await store.create({ name: "实验" });
    await store.move({ projectIds: [first], folderId: a.id });
    await store.move({ projectIds: [second], folderId: b.id });
    expect((await store.rename(a.id, { name: "理论研究" }))[0]).toMatchObject({ name: "理论研究", projectIds: [first] });
    expect(await store.delete(a.id)).toEqual([{ ...b, projectIds: [second] }]);
  });

  it("rejects missing projects and deleted destinations before committing any part of a batch", async () => {
    const { store, file } = await fixture();
    const [a] = await store.create({ name: "理论" });
    const [, b] = await store.create({ name: "实验" });
    await store.move({ projectIds: [first], folderId: a.id });
    const before = await fs.readFile(file);
    await expect(store.move({ projectIds: [first, missing], folderId: b.id })).rejects.toThrow(`项目不存在：${missing}`);
    expect(await fs.readFile(file)).toEqual(before);
    await store.delete(b.id);
    await expect(store.move({ projectIds: [first], folderId: b.id })).rejects.toThrow("文件夹不存在");
    expect((await store.list())[0].projectIds).toEqual([first]);
  });

  it("serializes concurrent mutations and keeps the queue usable after a rejected operation", async () => {
    const { store } = await fixture();
    await Promise.all([store.create({ name: "理论" }), store.create({ name: "实验" })]);
    const [a, b] = await store.list();
    await Promise.all([store.move({ projectIds: [first], folderId: a.id }), store.move({ projectIds: [second], folderId: b.id })]);
    await expect(store.create({ name: "理论" })).rejects.toThrow("文件夹名称已存在");
    await store.rename(a.id, { name: "物理理论" });
    expect(await store.list()).toEqual([{ ...a, name: "物理理论", projectIds: [first] }, { ...b, projectIds: [second] }]);
  });

  it("preserves the previous file and removes temporary files when atomic replacement fails", async () => {
    const { store, root, file } = await fixture();
    const [a] = await store.create({ name: "理论" });
    const before = await fs.readFile(file);
    const replacement = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("replacement denied"));
    await expect(store.move({ projectIds: [first], folderId: a.id })).rejects.toThrow("replacement denied");
    expect(await fs.readFile(file)).toEqual(before);
    expect(await fs.readdir(root)).toEqual(["project-folders.json"]);
    replacement.mockRestore();
    expect((await store.move({ projectIds: [first], folderId: a.id }))[0].projectIds).toEqual([first]);
  });

  it.each(["{", '{"wrong":[]}', JSON.stringify({ folders: [{ id: `folder_${"a".repeat(32)}`, name: "分类", projectIds: [first, first] }] })])(
    "fails explicitly on corrupt persisted data and never replaces it with an empty catalog: %s", async contents => {
      const { store, file } = await fixture();
      await fs.writeFile(file, contents);
      await expect(store.list()).rejects.toThrow("项目文件夹分类");
      await expect(store.create({ name: "新分类" })).rejects.toThrow("项目文件夹分类");
      expect(await fs.readFile(file, "utf8")).toBe(contents);
    }
  );
});

describe("project folder HTTP APIs", () => {
  async function appFixture() {
    const { root } = await fixture();
    const eventHub = new EventHub(), storage = new ProjectStorage(root, eventHub);
    vi.spyOn(storage, "tryLoadState").mockImplementation(async id => [first, second].includes(id) ? { id } as ProjectState : undefined);
    const app = createApp({ storage, eventHub, orchestrator: {} as Orchestrator, skills: {} as SkillCatalog,
      config: { modelSuggestions: [], maxEventHistory: 100 } });
    return { app, root };
  }

  it("serves create, rename, batch classification, unclassification and deletion through the management app", async () => {
    const { app, root } = await appFixture();
    expect((await request(app).get("/api/project-folders").expect(200)).body).toEqual({ folders: [] });
    const response = await request(app).post("/api/project-folders").send({ name: "物理" }).expect(201);
    const folder = response.body.folders[0];
    await request(app).put("/api/project-folders/assignments").send({ projectIds: [first, second], folderId: folder.id }).expect(200);
    const renamed = await request(app).patch(`/api/project-folders/${folder.id}`).send({ name: "物理研究" }).expect(200);
    expect(renamed.body.folders[0]).toEqual({ ...folder, name: "物理研究", projectIds: [first, second] });
    await request(app).put("/api/project-folders/assignments").send({ projectIds: [second], folderId: null }).expect(200);
    expect((await new ProjectFolderStore(root, async () => true).list())[0].projectIds).toEqual([first]);
    expect((await request(app).delete(`/api/project-folders/${folder.id}`).expect(200)).body).toEqual({ folders: [] });
  });

  it("reports validation, duplicate names and missing projects without partial classification", async () => {
    const { app } = await appFixture();
    await request(app).post("/api/project-folders").send({}).expect(400);
    await request(app).post("/api/project-folders").send({ name: "  " }).expect(400);
    await request(app).post("/api/project-folders").send({ name: "物理", parentId: "nested" }).expect(400);
    const folder = (await request(app).post("/api/project-folders").send({ name: "物理" }).expect(201)).body.folders[0];
    await request(app).post("/api/project-folders").send({ name: " 物理 " }).expect(409);
    await request(app).put("/api/project-folders/assignments").send({ projectIds: [first] }).expect(400);
    await request(app).put("/api/project-folders/assignments").send({ projectIds: [first, missing], folderId: folder.id }).expect(404);
    expect((await request(app).get("/api/project-folders").expect(200)).body.folders[0].projectIds).toEqual([]);
    await request(app).delete(`/api/project-folders/folder_${"f".repeat(32)}`).expect(404);
  });
});
