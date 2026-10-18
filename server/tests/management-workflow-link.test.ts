import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureExactDirectorySymlink } from "../src/collaboration-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "management-workflow-link-")); roots.push(root);
  const canonical = path.join(root, "canonical-project", "workflow");
  const original = path.join(root, "original-project", "workflow");
  const workspace = path.join(root, "original-project", "runtime", "retained-agent-workspace");
  await Promise.all([canonical, original, workspace].map((directory) => fs.mkdir(directory, { recursive: true })));
  for (const directory of [canonical, original]) await fs.writeFile(path.join(directory, "definition.json"), '{"revision":2}\n');
  const note = path.join(workspace, "Agent-memory.md"); await fs.writeFile(note, "Original Agent memory and unfinished work\n");
  return { root, canonical, original, workspace, note, link: path.join(workspace, "workflow") };
}

/** A controlled virtual bind preserves distinct realpath spellings and the
 * same real directory's stat. Real original bind behavior is additionally
 * verified against the production helper in the acceptance artifact. */
function bindOriginalDirectory(canonical: string, original: string, kind = "directory", differentDevice = false) {
  const realpath = fs.realpath.bind(fs); const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "realpath").mockImplementation(((file: string, options?: unknown) =>
    file === original ? Promise.resolve(original) : realpath(file, options as never)) as typeof fs.realpath);
  vi.spyOn(fs, "lstat").mockImplementation(((file: string, options?: unknown) => {
    if (file !== original) return lstat(file, options as never);
    return lstat(canonical, options as never).then((info) => {
      if (kind === "directory" && !differentDevice) return info;
      const adjusted = Object.assign(Object.create(Object.getPrototypeOf(info)), info);
      if (differentDevice) adjusted.dev = typeof info.dev === "bigint" ? info.dev + 1n : info.dev + 1;
      if (kind === "file") adjusted.isDirectory = () => false;
      if (kind === "symlink") adjusted.isSymbolicLink = () => true;
      return adjusted;
    });
  }) as typeof fs.lstat);
}

describe("retained management workflow directory links", () => {
  it("creates the initial workflow link without changing Agent files or authoritative inputs", async () => {
    const f = await fixture();
    await ensureExactDirectorySymlink(f.canonical, f.link);
    expect(await fs.readlink(f.link)).toBe(f.canonical);
    expect(await fs.readFile(f.note, "utf8")).toBe("Original Agent memory and unfinished work\n");
    expect(await fs.readFile(path.join(f.link, "definition.json"), "utf8")).toBe('{"revision":2}\n');
  });

  it.each([false, true])("retains an existing correct workflow link without rewriting it (relative: %s)", async (relative) => {
    const f = await fixture();
    const target = relative ? path.relative(f.workspace, f.canonical) : f.canonical;
    await fs.symlink(target, f.link, "dir");
    const before = await fs.lstat(f.link);
    await ensureExactDirectorySymlink(f.canonical, f.link);
    expect(await fs.readlink(f.link)).toBe(target);
    expect((await fs.lstat(f.link)).ino).toBe(before.ino);
    expect(await fs.readFile(f.note, "utf8")).toBe("Original Agent memory and unfinished work\n");
  });

  it("accepts the same verified workflow directory through the original registered bind without rewriting the link", async () => {
    const f = await fixture(); await fs.symlink(f.canonical, f.link, "dir");
    const before = await fs.lstat(f.link); bindOriginalDirectory(f.canonical, f.original);
    expect(await fs.realpath(f.link)).not.toBe(await fs.realpath(f.original));
    await ensureExactDirectorySymlink(f.original, f.link, [f.canonical, f.original]);
    expect(await fs.readlink(f.link)).toBe(f.canonical);
    expect((await fs.lstat(f.link)).ino).toBe(before.ino);
    expect(await fs.readFile(f.note, "utf8")).toBe("Original Agent memory and unfinished work\n");
  });

  it("rejects a same-inode spelling outside the verified project mapping", async () => {
    const f = await fixture(); await fs.symlink(f.canonical, f.link, "dir"); bindOriginalDirectory(f.canonical, f.original);
    await expect(ensureExactDirectorySymlink(f.original, f.link)).rejects.toThrow("mismatched workflow link");
    await expect(ensureExactDirectorySymlink(f.original, f.link, [f.original])).rejects.toThrow("mismatched workflow link");
    await expect(ensureExactDirectorySymlink(f.original, f.link, [f.canonical])).rejects.toThrow("mismatched workflow link");
    expect(await fs.readlink(f.link)).toBe(f.canonical);
  });

  it("rejects registered targets that have matching contents but are different directories", async () => {
    const f = await fixture(); await fs.symlink(f.canonical, f.link, "dir");
    expect(await fs.readFile(path.join(f.canonical, "definition.json"))).toEqual(await fs.readFile(path.join(f.original, "definition.json")));
    await expect(ensureExactDirectorySymlink(f.original, f.link, [f.canonical, f.original])).rejects.toThrow("mismatched workflow link");
    expect(await fs.readlink(f.link)).toBe(f.canonical);
  });

  it.each(["file", "symlink", "different-device"])("rejects a verified spelling whose actual directory identity changed to %s", async (kind) => {
    const f = await fixture(); await fs.symlink(f.canonical, f.link, "dir");
    bindOriginalDirectory(f.canonical, f.original, kind === "different-device" ? "directory" : kind, kind === "different-device");
    await expect(ensureExactDirectorySymlink(f.original, f.link, [f.canonical, f.original])).rejects.toThrow("mismatched workflow link");
    expect(await fs.readlink(f.link)).toBe(f.canonical);
  });

  it("rejects a retained workspace directory replacing its workflow link and preserves its contents", async () => {
    const f = await fixture(); await fs.mkdir(f.link); await fs.writeFile(path.join(f.link, "Agent-note.txt"), "Retained work");
    await expect(ensureExactDirectorySymlink(f.canonical, f.link)).rejects.toThrow("mismatched workflow link");
    expect(await fs.readFile(path.join(f.link, "Agent-note.txt"), "utf8")).toBe("Retained work");
  });

  it("rejects an existing link to a regular file even when both resolved spellings match", async () => {
    const f = await fixture(); const file = path.join(f.root, "unexpected-workflow-file");
    await fs.writeFile(file, "Retained contents"); await fs.symlink(file, f.link);
    await expect(ensureExactDirectorySymlink(file, f.link)).rejects.toThrow("mismatched workflow link");
    expect(await fs.readlink(f.link)).toBe(file);
    expect(await fs.readFile(file, "utf8")).toBe("Retained contents");
  });
});
