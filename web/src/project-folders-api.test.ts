import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectFolder, deleteProjectFolder, getProjectFolders, moveProjectsToFolder, renameProjectFolder } from "./api";

const id = `folder_${"a".repeat(32)}`, projectId = `prj_${"1".repeat(32)}`;
const folders = [{ id, name: "文献", projectIds: [projectId] }];
afterEach(() => vi.unstubAllGlobals());

describe("project folder API client", () => {
  it("sends explicit destinations including null for unclassification and reads persisted folders", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ folders }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    expect(await getProjectFolders()).toEqual(folders);
    await createProjectFolder("文献");
    await renameProjectFolder(id, "证据");
    await moveProjectsToFolder([projectId], id);
    await moveProjectsToFolder([projectId], null);
    await deleteProjectFolder(id);
    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      "./api/project-folders", "./api/project-folders", `./api/project-folders/${id}`,
      "./api/project-folders/assignments", "./api/project-folders/assignments", `./api/project-folders/${id}`
    ]);
    expect(fetch).toHaveBeenNthCalledWith(5, "./api/project-folders/assignments", expect.objectContaining({ method: "PUT", body: JSON.stringify({ projectIds: [projectId], folderId: null }) }));
  });

  it.each([{}, { folders: [{ id, name: "文献" }] }, { folders: [folders[0], { ...folders[0], id: `folder_${"b".repeat(32)}`, name: "实验" }] }])(
    "rejects incomplete or conflicting classification responses: %j", async value => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } })));
      await expect(getProjectFolders()).rejects.toThrow("项目文件夹响应");
    }
  );

  it("propagates server failures instead of replacing them with an empty catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "分类文件不可写" }), { status: 500, headers: { "Content-Type": "application/json" } })));
    await expect(moveProjectsToFolder([projectId], id)).rejects.toThrow("分类文件不可写");
  });
});
