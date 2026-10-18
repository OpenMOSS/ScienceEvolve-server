import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

export interface WorkspaceFileStamp { path: string; size: number; modifiedAt: string }
export interface WorkspaceCheckpoint {
  id: string;
  agent: string;
  invocationId: string;
  createdAt: string;
  reason: string;
  status: "unverified_partial_output" | "no_output";
  fileCount: number;
  incomplete: boolean;
}
export interface WorkspaceManifest extends WorkspaceCheckpoint {
  files: Array<WorkspaceFileStamp & { sha256?: string; error?: string }>;
}

// Dependency caches are not research deliverables. Never traverse symlinks,
// hidden runtime directories or credentials when indexing recoverable output.
const EXCLUDED = new Set(["node_modules", "__pycache__", "venv", "Memory.md"]);
const MAX_FILES = 2_000;
const MAX_DIRECTORIES = 2_000;
const MAX_HASH_BYTES = 100 * 1024 * 1024;

export async function scanWorkspace(root: string): Promise<{ files: WorkspaceFileStamp[]; incomplete: boolean }> {
  const realRoot = await fs.realpath(root);
  const queue = [""];
  const files: WorkspaceFileStamp[] = [];
  let incomplete = false;
  for (let index = 0; index < queue.length; index++) {
    if (files.length >= MAX_FILES) { incomplete = true; break; }
    const directory = queue[index];
    let entries;
    try {
      const realDirectory = await fs.realpath(path.join(root, directory));
      const fromRoot = path.relative(realRoot, realDirectory);
      if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) { incomplete = true; continue; }
      entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
    } catch {
      incomplete = true;
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || EXCLUDED.has(entry.name) || entry.isSymbolicLink()) continue;
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (queue.length < MAX_DIRECTORIES) queue.push(relative);
        else incomplete = true;
      } else if (entry.isFile()) {
        if (files.length >= MAX_FILES) { incomplete = true; break; }
        try {
          const stat = await fs.lstat(path.join(root, relative));
          if (stat.isFile()) files.push({ path: relative, size: stat.size, modifiedAt: stat.mtime.toISOString() });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          incomplete = true;
        }
      }
    }
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), incomplete };
}

/** An immutable metadata manifest, not a claim that workspace bytes are frozen. */
export async function buildWorkspaceManifest(
  root: string,
  metadata: Pick<WorkspaceCheckpoint, "id" | "agent" | "invocationId" | "reason">,
  baseline?: WorkspaceFileStamp[]
): Promise<WorkspaceManifest> {
  const scanned = await scanWorkspace(root);
  const previous = new Map(baseline?.map((file) => [file.path, file]));
  const files: WorkspaceManifest["files"] = [];
  let remainingBytes = MAX_HASH_BYTES;
  let incomplete = scanned.incomplete;
  for (const file of scanned.files) {
    const before = previous.get(file.path);
    if (before?.size === file.size && before.modifiedAt === file.modifiedAt) continue;
    if (file.size > remainingBytes) {
      files.push({ ...file, error: "hash_budget_exceeded" });
      incomplete = true;
      continue;
    }
    remainingBytes -= file.size;
    try {
      const candidate = await fs.realpath(path.join(root, file.path));
      const relative = path.relative(await fs.realpath(root), candidate);
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("outside_workspace");
      const hash = createHash("sha256");
      if (file.size) {
        for await (const chunk of createReadStream(candidate, { start: 0, end: file.size - 1 })) hash.update(chunk);
      }
      const after = await fs.stat(candidate);
      if (after.size !== file.size || after.mtime.toISOString() !== file.modifiedAt) throw new Error("file_changed_during_checkpoint");
      files.push({ ...file, sha256: hash.digest("hex") });
    } catch {
      files.push({ ...file, error: "file_unavailable_or_changed" });
      incomplete = true;
    }
  }
  return {
    ...metadata, createdAt: new Date().toISOString(),
    status: files.length ? "unverified_partial_output" : "no_output",
    fileCount: files.length, incomplete, files
  };
}
