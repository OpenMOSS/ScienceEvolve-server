import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { mediaTypeFor, safeProjectRelativePath } from "./utils.js";
import type { ArtifactDirectoryEntry, ArtifactDirectoryPage, ArtifactFileVariant, ArtifactListItem, ProjectState } from "./types.js";

interface WorkspaceSource { id: string; label: string; root: string; producer: string }
const visible = (name: string) => name.split("/").every(part => part.length > 0 && !part.startsWith("."));
const absent = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
function missing(message: string): never { throw Object.assign(new Error(message), { code: "ENOENT" }); }

/** A user's live project file browser. Publication/evidence resolvers remain
 * separate: seeing a worktree file does not publish it or satisfy a Git gate. */
export class ProjectFileBrowser {
  constructor(private readonly projectRoot: string, private readonly state: ProjectState,
    private readonly published: () => Promise<ArtifactListItem[]>) {}

  private async sources(): Promise<WorkspaceSource[]> {
    const projectRoot = await fs.realpath(this.projectRoot), result: WorkspaceSource[] = [];
    const add = async (relative: string, label: string, producer: string, git = false) => {
      const root = path.join(projectRoot, relative);
      try {
        const stats = await fs.lstat(root);
        if (!stats.isDirectory() || stats.isSymbolicLink() || await fs.realpath(root) !== root) return;
        if (git) {
          const metadata = await fs.lstat(path.join(root, ".git"));
          if (metadata.isSymbolicLink() || !(metadata.isDirectory() || metadata.isFile())) return;
        }
        const id = relative === "workspaces" ? "shared" : relative === "repository" ? "repository"
          : `worktree_${createHash("sha256").update(relative).digest("hex").slice(0, 24)}`;
        result.push({ id, label, root, producer });
      } catch (error) { if (!absent(error)) throw error; }
    };
    if (this.state.git?.enabled) await add("repository", "项目文件", "shared", true);
    await add("workspaces", "共享工作区", "shared");
    if (this.state.git?.enabled) {
      const worktrees = path.join(projectRoot, "git-worktrees");
      try {
        if (await fs.realpath(worktrees) !== worktrees) return result;
        for (const entry of (await fs.readdir(worktrees, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.isDirectory() || !visible(entry.name)) continue;
          if (["agents", "groups"].includes(entry.name)) {
            const container = path.join(worktrees, entry.name);
            if (await fs.realpath(container) !== container) continue;
            for (const child of (await fs.readdir(container, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
              if (child.isDirectory() && visible(child.name))
                await add(path.join("git-worktrees", entry.name, child.name), `工作区 · ${child.name}`, entry.name === "agents" ? child.name : "shared", true);
            }
          } else await add(path.join("git-worktrees", entry.name), `工作区 · ${entry.name}`, "shared", true);
        }
      } catch (error) { if (!absent(error)) throw error; }
    }
    return result;
  }

  private relative(value: string, directory = false): string {
    if (directory && !value.trim()) return "";
    const relative = safeProjectRelativePath(value);
    if (!visible(relative)) missing("Project file is hidden");
    return relative;
  }

  private async inspect(source: WorkspaceSource, relative: string) {
    const candidate = relative ? path.join(source.root, relative) : source.root;
    if (candidate !== source.root && !candidate.startsWith(`${source.root}${path.sep}`)) missing("Project file escaped its workspace source");
    const stats = await fs.lstat(candidate);
    // Reject intermediate symlinks as well as the final entry, and hard links.
    if (stats.isSymbolicLink() || await fs.realpath(candidate) !== candidate || (stats.isFile() && stats.nlink !== 1))
      missing("Project file is not a regular canonical workspace entry");
    return { candidate, stats };
  }

  private file(source: WorkspaceSource, relative: string, stats: { size: number; mtimeMs: number }): ArtifactFileVariant {
    return { id: `workspace:${source.id}:${relative}`, path: relative, producer: source.producer, origin: "workspace",
      size: stats.size, updatedAt: new Date(stats.mtimeMs).toISOString(), mediaType: mediaTypeFor(relative),
      workspaceId: source.id, workspaceLabel: source.label };
  }

  private combine(files: ArtifactFileVariant[]): ArtifactListItem[] {
    const byPath = new Map<string, ArtifactFileVariant[]>();
    for (const file of files) {
      const variants = byPath.get(file.path) ?? [];
      if (!variants.some(item => item.id === file.id)) variants.push(file);
      byPath.set(file.path, variants);
    }
    return [...byPath.values()].map(variants => ({ ...variants[0]!, ...(variants.length > 1 ? { variants } : {}) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async catalog(): Promise<ArtifactListItem[]> {
    const files: ArtifactFileVariant[] = [];
    for (const source of await this.sources()) {
      const directories = [""];
      for (let cursor = 0; cursor < directories.length; cursor++) {
        const relative = directories[cursor]!;
        try {
          const { candidate, stats } = await this.inspect(source, relative);
          if (!stats.isDirectory()) continue;
          for (const entry of await fs.readdir(candidate, { withFileTypes: true })) {
            if (!visible(entry.name) || !(entry.isDirectory() || entry.isFile())) continue;
            const child = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) directories.push(child);
            else {
              try { const { stats: fileStats } = await this.inspect(source, child); if (fileStats.isFile()) files.push(this.file(source, child, fileStats)); }
              catch (error) { if (!absent(error)) throw error; }
            }
          }
        } catch (error) { if (!absent(error)) throw error; }
      }
    }
    if (this.state.git?.enabled) files.push(...(await this.published()).map(file => ({ ...file, workspaceLabel: "已发布版本" })));
    return this.combine(files);
  }

  async directory(requested: string, options: { offset?: number; limit?: number } = {}): Promise<ArtifactDirectoryPage> {
    const directory = this.relative(requested, true), directories = new Map<string, ArtifactDirectoryEntry>();
    const files: ArtifactFileVariant[] = [];
    let found = !directory;
    for (const source of await this.sources()) {
      try {
        const { candidate, stats } = await this.inspect(source, directory);
        if (!stats.isDirectory()) continue;
        found = true;
        for (const entry of await fs.readdir(candidate, { withFileTypes: true })) {
          if (!visible(entry.name) || !(entry.isDirectory() || entry.isFile())) continue;
          const relative = directory ? `${directory}/${entry.name}` : entry.name;
          try {
            const { stats: child } = await this.inspect(source, relative);
            if (child.isDirectory()) directories.set(entry.name, { type: "directory", name: entry.name, path: relative, producer: "shared", origin: "workspace" });
            else if (child.isFile()) files.push(this.file(source, relative, child));
          } catch (error) { if (!absent(error)) throw error; }
        }
      } catch (error) { if (!absent(error)) throw error; }
    }
    if (this.state.git?.enabled) {
      const prefix = directory ? `${directory}/` : "";
      for (const file of await this.published()) {
        if (!file.path.startsWith(prefix)) continue;
        const remainder = file.path.slice(prefix.length), slash = remainder.indexOf("/");
        if (!remainder) continue;
        found = true;
        if (slash < 0) files.push({ ...file, workspaceLabel: "已发布版本" });
        else {
          const name = remainder.slice(0, slash);
          directories.set(name, { type: "directory", name, path: `${prefix}${name}`, producer: "shared", origin: "workspace" });
        }
      }
    }
    if (!found) missing("Project file directory not found");
    const entries: ArtifactDirectoryEntry[] = [...[...directories.values()].sort((a, b) => a.name.localeCompare(b.name)), ...this.combine(files)
      .map(file => ({ ...file, type: "file" as const, name: path.posix.basename(file.path), ...(file.gitSource ? { commitSha: file.gitSource.commitSha } : {}) }))];
    const offset = Math.max(0, options.offset ?? 0), limit = Math.min(200, Math.max(1, options.limit ?? 50));
    return { agent: "shared", directory, parent: directory ? (directory.includes("/") ? path.posix.dirname(directory) : "") : undefined,
      entries: entries.slice(offset, offset + limit), offset, limit, total: entries.length, hasMore: offset + limit < entries.length };
  }

  async resolve(workspaceId: string, requested: string) {
    const source = (await this.sources()).find(item => item.id === workspaceId);
    if (!source) missing("Project workspace source not found");
    const relativePath = this.relative(requested), { candidate, stats } = await this.inspect(source, relativePath);
    if (!stats.isFile()) missing("Project workspace file not found");
    return { sourcePath: candidate, relativePath, size: stats.size, mediaType: mediaTypeFor(relativePath), mtimeMs: stats.mtimeMs };
  }
}
