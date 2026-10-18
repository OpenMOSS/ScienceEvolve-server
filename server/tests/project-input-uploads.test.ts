import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import type { Request } from "express";
import { ProjectInputUploads, validateInputPath } from "../src/project-input-uploads.js";

const roots: string[] = [];
function officeZip(name: string, xml: string): Buffer {
  const filename = Buffer.from(name);
  const content = Buffer.from(xml);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const directory = Buffer.concat([central, filename]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(local.length + filename.length + content.length, 16);
  return Buffer.concat([local, filename, content, directory, end]);
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("new project inputs", () => {
  it("rejects a temporary user_inputs folder replaced by an external link", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-input-root-"));
    roots.push(root);
    const uploads = new ProjectInputUploads(root);
    const id = await uploads.create();
    const directory = path.join(root, ".project-input-uploads", id, "user_inputs");
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "private.txt"), "outside input authority");
    await fs.rm(directory, { recursive: true });
    await fs.symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
    await expect(uploads.list(id)).rejects.toThrow("普通文件夹");
    await expect(uploads.recommendationAttachments(id)).rejects.toThrow("普通文件夹");
    await expect(uploads.openDirectory(id, async () => { throw new Error("unexpected launcher call"); }))
      .rejects.toThrow("普通文件夹");
  });

  it("includes files placed directly in the temporary user_inputs folder", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-inputs-"));
    roots.push(root);
    const uploads = new ProjectInputUploads(root);
    const id = await uploads.create();
    const directory = path.join(root, ".project-input-uploads", id, "user_inputs");
    let opened = "";
    await uploads.openDirectory(id, async (target) => { opened = target; });
    expect(opened).toBe(await fs.realpath(directory));
    await fs.mkdir(path.join(directory, "references"));
    await fs.writeFile(path.join(directory, "references", "notes.txt"), "来自资源管理器的资料");
    const restartedUploads = new ProjectInputUploads(root);
    expect(await restartedUploads.list(id)).toEqual([expect.objectContaining({ path: "references/notes.txt", size: Buffer.byteLength("来自资源管理器的资料") })]);
    expect(await uploads.recommendationAttachments(id)).toEqual([{
      path: "references/notes.txt", kind: "text", text: "来自资源管理器的资料"
    }]);
    expect(await uploads.seal(id)).toEqual(["references/notes.txt"]);
    const project = path.join(root, "projects", "prj_00000000000000000000000000000000");
    await fs.mkdir(project, { recursive: true });
    await uploads.install(id, project);
    expect(await fs.readFile(path.join(project, "workspaces", "user_inputs", "references", "notes.txt"), "utf8"))
      .toBe("来自资源管理器的资料");
  });

  it("reads complete UTF-8 text, image and PDF bytes for the configuration advisor", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-inputs-"));
    roots.push(root);
    const uploads = new ProjectInputUploads(root);
    const id = await uploads.create();
    await uploads.put(id, "data/notes.txt", Readable.from([Buffer.from("实验样本 42")]) as Request);
    await uploads.put(id, "figures/rig.png", Readable.from([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2])]) as Request);
    await uploads.put(id, "references/paper.pdf", Readable.from([Buffer.from("%PDF-1.7 example")]) as Request);
    expect(await uploads.recommendationAttachments(id)).toEqual([
      { path: "data/notes.txt", kind: "text", text: "实验样本 42" },
      { path: "figures/rig.png", kind: "image", mediaType: "image/png", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]).toString("base64") },
      { path: "references/paper.pdf", kind: "pdf", mediaType: "application/pdf", data: Buffer.from("%PDF-1.7 example").toString("base64") }
    ]);
  });

  it("rejects unsupported binary files for recommendation instead of silently omitting them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-inputs-"));
    roots.push(root);
    const uploads = new ProjectInputUploads(root);
    const id = await uploads.create();
    await uploads.put(id, "book.docx", Readable.from([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0xff])]) as Request);
    await expect(uploads.recommendationAttachments(id)).rejects.toThrow(/无法提取文字/);
  });

  it("extracts Word document text for recommendation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-inputs-"));
    roots.push(root);
    const uploads = new ProjectInputUploads(root);
    const id = await uploads.create();
    const document = officeZip("word/document.xml", '<w:document><w:p><w:r><w:t>实验计划与结果</w:t></w:r></w:p></w:document>');
    await uploads.put(id, "references/proposal.docx", Readable.from([document]) as Request);
    expect(await uploads.recommendationAttachments(id)).toEqual([{
      path: "references/proposal.docx", kind: "text", text: "word/document.xml\n实验计划与结果"
    }]);
  });

  it("extracts slide and spreadsheet text for recommendation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-inputs-"));
    roots.push(root);
    const uploads = new ProjectInputUploads(root);
    const id = await uploads.create();
    await uploads.put(id, "slides.pptx", Readable.from([officeZip("ppt/slides/slide1.xml",
      '<p:sld><a:p><a:r><a:t>实验装置示意图</a:t></a:r></a:p></p:sld>')]) as Request);
    await uploads.put(id, "samples.xlsx", Readable.from([officeZip("xl/worksheets/sheet1.xml",
      '<worksheet><row><c r="A1" t="inlineStr"><is><t>样本数</t></is></c><c r="B1"><v>42</v></c></row></worksheet>')]) as Request);
    const attachments = await uploads.recommendationAttachments(id);
    expect(attachments.find((item) => item.path === "slides.pptx")).toMatchObject({ kind: "text", text: expect.stringContaining("实验装置示意图") });
    expect(attachments.find((item) => item.path === "samples.xlsx")).toMatchObject({ kind: "text", text: expect.stringContaining("A1: 样本数\nB1: 42") });
  });

  it("preserves folder paths and image bytes in the shared workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-inputs-"));
    roots.push(root);
    const uploads = new ProjectInputUploads(root);
    const id = await uploads.create();
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0x80]);
    await uploads.put(id, "references/figure.png", Readable.from([image]) as Request);
    await uploads.put(id, "notes.txt", Readable.from([Buffer.from("研究笔记")]) as Request);
    expect(await uploads.seal(id)).toEqual(["notes.txt", "references/figure.png"]);
    const project = path.join(root, "projects", "prj_00000000000000000000000000000000");
    await uploads.install(id, project);
    expect(await fs.readFile(path.join(project, "workspaces", "user_inputs", "references", "figure.png"))).toEqual(image);
    expect(await fs.readFile(path.join(project, "workspaces", "user_inputs", "notes.txt"), "utf8")).toBe("研究笔记");
    await uploads.discard(id);
  });

  it("rejects traversal paths and replaces a repeated upload only after it completes", async () => {
    expect(() => validateInputPath("../outside.txt")).toThrow();
    expect(() => validateInputPath("folder\\outside.txt", "win32")).toThrow();
    expect(() => validateInputPath("CON.png", "win32")).toThrow();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-inputs-"));
    roots.push(root);
    const uploads = new ProjectInputUploads(root);
    const id = await uploads.create();
    await uploads.put(id, "photo.jpg", Readable.from([Buffer.from([1, 2, 3])]) as Request);
    await uploads.put(id, "photo.jpg", Readable.from([Buffer.from([4])]) as Request);
    expect(await fs.readFile(path.join(root, ".project-input-uploads", id, "user_inputs", "photo.jpg"))).toEqual(Buffer.from([4]));
    const interrupted = Readable.from((async function* () {
      yield Buffer.from([5, 6]);
      throw new Error("upload interrupted");
    })());
    await expect(uploads.put(id, "photo.jpg", interrupted as Request)).rejects.toThrow("upload interrupted");
    expect(await fs.readFile(path.join(root, ".project-input-uploads", id, "user_inputs", "photo.jpg"))).toEqual(Buffer.from([4]));
    expect(await uploads.list(id)).toEqual([expect.objectContaining({ path: "photo.jpg", size: 1 })]);
  });

  it("uses the filesystem's case sensitivity for replacement and deletion", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-inputs-"));
    roots.push(root);
    const uploads = new ProjectInputUploads(root);
    const id = await uploads.create();
    await uploads.put(id, "Report.txt", Readable.from([Buffer.from("original")]) as Request);
    const alias = path.join(root, ".project-input-uploads", id, "user_inputs", "report.txt");
    const caseInsensitive = await fs.stat(alias).then(() => true, () => false);
    await uploads.put(id, "report.txt", Readable.from([Buffer.from("replacement")]) as Request);
    const names = (await uploads.list(id)).map(file => file.path);
    expect(names.sort()).toEqual(caseInsensitive ? ["Report.txt"] : ["Report.txt", "report.txt"]);
    expect(await fs.readFile(alias, "utf8")).toBe("replacement");
    await uploads.removeFile(id, "report.txt");
    expect((await uploads.list(id)).map(file => file.path)).toEqual(caseInsensitive ? [] : ["Report.txt"]);
  });

  it.runIf(process.platform !== "win32")("uploads, installs and removes native POSIX filenames", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-inputs-"));
    roots.push(root);
    const uploads = new ProjectInputUploads(root);
    const id = await uploads.create();
    const filename = "资料/CON:notes?.txt";
    await uploads.put(id, filename, Readable.from([Buffer.from("native names")]) as Request);
    expect(await uploads.seal(id)).toEqual([filename]);
    const project = path.join(root, "project");
    await uploads.install(id, project);
    expect(await fs.readFile(path.join(project, "workspaces", "user_inputs", ...filename.split("/")), "utf8")).toBe("native names");
    uploads.unseal(id);
    await uploads.removeFile(id, filename);
    expect(await uploads.list(id)).toEqual([]);
  });
});

describe("input path validation across platforms", () => {
  it.each(["win32", "darwin", "linux"] as const)("rejects traversal, absolute paths and NUL on %s", (platform) => {
    for (const invalid of ["", "/outside.txt", "../outside.txt", "folder/../outside.txt", "folder/./notes.txt", "folder//notes.txt", "notes\0.txt"]) {
      expect(() => validateInputPath(invalid, platform)).toThrow();
    }
    expect(validateInputPath("资料/notes &+#%.txt", platform)).toBe("资料/notes &+#%.txt");
  });

  it.each(["darwin", "linux"] as const)("allows POSIX names on %s while rejecting them on Windows", (platform) => {
    for (const filename of ["CON.png", "report:2026.txt", "notes?.txt", "data*.csv", "trailing.", "trailing ", "back\\slash.txt"]) {
      expect(validateInputPath(filename, platform)).toBe(filename);
      expect(() => validateInputPath(filename, "win32")).toThrow();
    }
  });
});
