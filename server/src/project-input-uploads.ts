import { randomBytes } from "node:crypto";
import { createWriteStream, promises as fs, constants as fsConstants, statSync } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import type { Request } from "express";
import { extractOfficeText } from "./recommendation-office-text.js";
import { isValidInputPath } from "./internal/shared/input-path.js";
import type { RecommendationAttachment } from "./internal/shared/configuration-recommendation.js";

export type { RecommendationAttachment } from "./internal/shared/configuration-recommendation.js";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface UploadFile { path: string; source: string; size: number; mtimeMs: number }
const MAX_RECOMMENDATION_TEXT = 120_000;
const MAX_RECOMMENDATION_MEDIA_BYTES = 16 * 1024 * 1024;
const MAX_RECOMMENDATION_MEDIA_FILES = 12;
interface UploadSession {
  lastAccessAt: number;
  files: Map<string, UploadFile>;
  totalBytes: number;
  busy: boolean;
  sealed: boolean;
}

export class ProjectInputUploadError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function validateInputPath(value: unknown, platform: NodeJS.Platform = process.platform): string {
  if (!isValidInputPath(value, platform)) {
    throw new ProjectInputUploadError("无效的文件相对路径");
  }
  return value;
}

export function launchInputFileManager(directory: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const command = platform === "win32" ? "explorer.exe" : platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : undefined;
  if (!command) return Promise.reject(new ProjectInputUploadError("当前系统不支持打开文件管理器，请使用选择文件或文件夹上传。", 501));
  return new Promise((resolve, reject) => {
    const child = spawn(command, [directory], { detached: true, stdio: "ignore", windowsHide: false });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      if (error) reject(error);
      else resolve();
    };
    const failure = () => new ProjectInputUploadError(
      `无法打开系统文件管理器，请确认 ${command} 可用且服务运行在桌面会话中；也可使用选择文件或文件夹上传。`, 503);
    child.once("error", () => finish(failure()));
    child.once("spawn", () => {
      // Explorer can return a nonzero status after handing off to an existing window.
      if (platform === "win32") finish();
      // Some Linux file managers keep xdg-open running until their window closes.
      // Capture immediate launcher failures without keeping the HTTP request open.
      else timer = setTimeout(() => finish(), 1000);
    });
    child.once("close", (code) => finish(code === 0 ? undefined : failure()));
  });
}

export class ProjectInputUploads {
  private readonly root: string;
  private readonly sessions = new Map<string, UploadSession>();

  constructor(storageRoot: string) {
    this.root = path.resolve(storageRoot, ".project-input-uploads");
  }

  private inputDir(id: string): string { return path.join(this.root, id, "user_inputs"); }

  private async validatedInputDir(id: string): Promise<string> {
    const directory = this.inputDir(id);
    const [sessionEntry, inputEntry, stagingRoot, realInputs] = await Promise.all([
      fs.lstat(path.dirname(directory)), fs.lstat(directory), fs.realpath(this.root), fs.realpath(directory)
    ]);
    if (!sessionEntry.isDirectory() || sessionEntry.isSymbolicLink() ||
      !inputEntry.isDirectory() || inputEntry.isSymbolicLink() || !this.isDescendant(stagingRoot, realInputs)) {
      throw new ProjectInputUploadError("临时 user_inputs 必须是上传会话内的普通文件夹");
    }
    return realInputs;
  }

  async create(): Promise<string> {
    await fs.mkdir(this.root, { recursive: true });
    await this.prune();
    const id = randomBytes(24).toString("hex");
    await fs.mkdir(path.join(this.root, id), { recursive: false });
    await fs.mkdir(this.inputDir(id));
    this.sessions.set(id, { lastAccessAt: Date.now(), files: new Map(), totalBytes: 0, busy: false, sealed: false });
    return id;
  }

  private session(id: string): UploadSession {
    if (!/^[a-f0-9]{48}$/.test(id)) throw new ProjectInputUploadError("上传会话无效或已过期", 404);
    let session = this.sessions.get(id);
    if (!session) {
      const directory = statSync(this.inputDir(id), { throwIfNoEntry: false });
      if (directory?.isDirectory() && Date.now() - directory.mtimeMs <= SESSION_TTL_MS) {
        session = { lastAccessAt: Date.now(), files: new Map(), totalBytes: 0, busy: false, sealed: false };
        this.sessions.set(id, session);
      }
    }
    if (!session || Date.now() - session.lastAccessAt > SESSION_TTL_MS) {
      throw new ProjectInputUploadError("上传会话无效或已过期", 404);
    }
    session.lastAccessAt = Date.now();
    return session;
  }

  async put(id: string, relativePath: unknown, request: Request): Promise<void> {
    const session = this.session(id);
    const filePath = validateInputPath(relativePath);
    if (session.busy || session.sealed) throw new ProjectInputUploadError("上传会话正在使用", 409);
    session.busy = true;
    const source = path.join(this.root, id, randomBytes(16).toString("hex"));
    let size = 0;
    try {
      await this.scan(id, session);
      const previous = await this.findFile(id, session, filePath);
      const previousSize = previous?.size ?? 0;
      if (!previous && session.files.size >= MAX_FILES) throw new ProjectInputUploadError("最多上传 1000 个文件", 413);
      await pipeline(request, new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > MAX_FILE_BYTES || session.totalBytes - previousSize + size > MAX_TOTAL_BYTES) {
            callback(new ProjectInputUploadError("文件超过 50 MiB 或本次上传总量超过 200 MiB", 413));
          } else callback(null, chunk);
        }
      }), createWriteStream(source, { flags: "wx", mode: 0o600 }));
      const target = previous?.source ?? path.join(this.inputDir(id), ...filePath.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      const realRoot = await fs.realpath(this.inputDir(id));
      const realParent = await fs.realpath(path.dirname(target));
      if (realParent !== realRoot && !this.isDescendant(realRoot, realParent)) {
        throw new ProjectInputUploadError("文件路径超出 user_inputs");
      }
      if (previous) await fs.rename(source, target);
      else await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
      const storedPath = previous?.path ?? filePath;
      session.files.set(storedPath, { path: storedPath, source: target, size, mtimeMs: (await fs.stat(target)).mtimeMs });
      session.totalBytes += size - previousSize;
    } finally {
      try { await fs.rm(source, { force: true }); }
      finally { session.busy = false; }
    }
  }

  private async scan(id: string, session: UploadSession): Promise<UploadFile[]> {
    const realRoot = await this.validatedInputDir(id);
    const files: UploadFile[] = [];
    let totalBytes = 0;
    const visit = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        validateInputPath(relative);
        const source = path.join(directory, entry.name);
        const stat = await fs.lstat(source);
        if (stat.isSymbolicLink()) throw new ProjectInputUploadError(`user_inputs 不允许链接：${relative}`);
        const resolved = await fs.realpath(source);
        if (!this.isDescendant(realRoot, resolved)) throw new ProjectInputUploadError(`文件路径超出 user_inputs：${relative}`);
        if (stat.isDirectory()) { await visit(source, relative); continue; }
        if (!stat.isFile()) throw new ProjectInputUploadError(`user_inputs 包含不支持的文件类型：${relative}`);
        if (stat.size > MAX_FILE_BYTES) throw new ProjectInputUploadError(`文件 ${relative} 超过 50 MiB`, 413);
        files.push({ path: relative, source, size: stat.size, mtimeMs: stat.mtimeMs });
        totalBytes += stat.size;
        if (files.length > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
          throw new ProjectInputUploadError("user_inputs 最多 1000 个文件、合计 200 MiB", 413);
        }
      }
    };
    await visit(realRoot, "");
    files.sort((a, b) => a.path.localeCompare(b.path));
    session.files = new Map(files.map((file) => [file.path, file]));
    session.totalBytes = totalBytes;
    return files;
  }

  async list(id: string): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
    const session = this.session(id);
    if (session.busy || session.sealed) throw new ProjectInputUploadError("上传会话正在使用", 409);
    session.busy = true;
    try { return (await this.scan(id, session)).map(({ path, size, mtimeMs }) => ({ path, size, mtimeMs })); }
    finally { session.busy = false; }
  }

  private async findFile(id: string, session: UploadSession, filePath: string): Promise<UploadFile | undefined> {
    const exact = session.files.get(filePath);
    if (exact) return exact;
    // Resolve aliases using the actual filesystem, including case-insensitive APFS/NTFS.
    // Keep distinct names on case-sensitive volumes instead of lowercasing every path.
    let source: string;
    try { source = await fs.realpath(path.join(this.inputDir(id), ...filePath.split("/"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return [...session.files.values()].find((file) => file.source === source);
  }

  async removeFile(id: string, relativePath: unknown): Promise<void> {
    const session = this.session(id);
    const filePath = validateInputPath(relativePath);
    if (session.busy || session.sealed) throw new ProjectInputUploadError("上传会话正在使用", 409);
    session.busy = true;
    try {
      await this.scan(id, session);
      const file = await this.findFile(id, session, filePath);
      if (!file) return;
      await fs.rm(file.source);
      session.files.delete(file.path);
      session.totalBytes -= file.size;
    } finally { session.busy = false; }
  }

  async openDirectory(id: string, launch: (directory: string) => Promise<void> = launchInputFileManager): Promise<void> {
    this.session(id);
    const directory = await this.validatedInputDir(id);
    await launch(directory);
  }

  async seal(id: string): Promise<string[]> {
    const session = this.session(id);
    if (session.busy || session.sealed) throw new ProjectInputUploadError("上传会话正在使用", 409);
    session.busy = true;
    try { await this.scan(id, session); }
    finally { session.busy = false; }
    session.sealed = true;
    return [...session.files.keys()];
  }

  unseal(id: string): void {
    this.session(id).sealed = false;
  }

  async recommendationAttachments(id: string): Promise<RecommendationAttachment[]> {
    const session = this.session(id);
    if (session.busy || session.sealed) throw new ProjectInputUploadError("上传会话正在使用", 409);
    session.busy = true;
    try {
      await this.scan(id, session);
      return await this.readRecommendationAttachments(session);
    } finally {
      session.busy = false;
    }
  }

  private async readRecommendationAttachments(session: UploadSession): Promise<RecommendationAttachment[]> {
    const attachments: RecommendationAttachment[] = [];
    let textLength = 0;
    let mediaBytes = 0;
    let mediaFiles = 0;
    for (const file of session.files.values()) {
      const extension = path.extname(file.path).toLowerCase();
      const isMedia = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"].includes(extension);
      if (isMedia) {
        mediaBytes += file.size;
        mediaFiles += 1;
        if (mediaBytes > MAX_RECOMMENDATION_MEDIA_BYTES || mediaFiles > MAX_RECOMMENDATION_MEDIA_FILES) {
          throw new ProjectInputUploadError("配置推荐最多接收 12 个图片/PDF，合计 16 MiB；请减少附件后重试。", 413);
        }
        const buffer = await fs.readFile(file.source);
        const mediaType = extension === ".pdf" ? "application/pdf"
          : extension === ".png" ? "image/png"
            : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg"
              : extension === ".gif" ? "image/gif" : "image/webp";
        const valid = mediaType === "application/pdf" ? buffer.subarray(0, 5).toString() === "%PDF-"
          : mediaType === "image/png" ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : mediaType === "image/jpeg" ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
              : mediaType === "image/gif" ? ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString())
                : buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP";
        if (!valid) throw new ProjectInputUploadError(`附件 ${file.path} 的内容与文件类型不符，无法用于配置推荐。`);
        attachments.push(mediaType === "application/pdf"
          ? { path: file.path, kind: "pdf", mediaType, data: buffer.toString("base64") }
          : { path: file.path, kind: "image", mediaType, data: buffer.toString("base64") });
        continue;
      }
      const office = [".docx", ".pptx", ".xlsx"].includes(extension);
      if (file.size > (office ? 10 * 1024 * 1024 : MAX_RECOMMENDATION_TEXT * 4)) {
        throw new ProjectInputUploadError(`附件 ${file.path} 过大，无法完整送入配置推荐；请缩小文件后重试。`, 413);
      }
      const buffer = await fs.readFile(file.source);
      let content: string;
      try { content = office
        ? extractOfficeText(buffer, extension as ".docx" | ".pptx" | ".xlsx")
        : new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
      catch { throw new ProjectInputUploadError(`附件 ${file.path} 无法提取文字；配置推荐支持 UTF-8 文本、DOCX、XLSX、PPTX、PDF 和常见图片。`); }
      if (content.includes("\u0000")) throw new ProjectInputUploadError(`附件 ${file.path} 是二进制文件，无法用于配置推荐；请提供文本、PDF 或图片。`);
      textLength += content.length;
      if (textLength > MAX_RECOMMENDATION_TEXT) throw new ProjectInputUploadError("配置推荐的附件文本合计超过 12 万字符，请缩小文件后重试。", 413);
      attachments.push({ path: file.path, kind: "text", text: content });
    }
    return attachments;
  }

  async install(id: string, projectDir: string): Promise<void> {
    const session = this.session(id);
    if (!session.sealed) throw new ProjectInputUploadError("上传会话尚未准备好", 409);
    const sourceRoot = await this.validatedInputDir(id);
    const destination = path.join(projectDir, "workspaces", "user_inputs");
    await fs.mkdir(destination, { recursive: true });
    const projectRoot = await fs.realpath(projectDir);
    const inputRoot = await fs.realpath(destination);
    const inputEntry = await fs.lstat(destination);
    if (!inputEntry.isDirectory() || inputEntry.isSymbolicLink() || !this.isDescendant(projectRoot, inputRoot)) {
      throw new ProjectInputUploadError("课题附件目录无效");
    }
    for (const file of session.files.values()) {
      const sourceStat = await fs.lstat(file.source);
      const realSource = await fs.realpath(file.source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== file.size || !this.isDescendant(sourceRoot, realSource)) {
        throw new ProjectInputUploadError(`课题附件已变化：${file.path}`);
      }
      const target = path.join(destination, ...file.path.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      const realParent = await fs.realpath(path.dirname(target));
      if (realParent !== inputRoot && !this.isDescendant(inputRoot, realParent)) {
        throw new ProjectInputUploadError("课题附件路径超出 workspace");
      }
      await fs.copyFile(file.source, target, fsConstants.COPYFILE_EXCL);
    }
  }

  private isDescendant(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  async discard(id: string): Promise<void> {
    if (this.session(id).busy) throw new ProjectInputUploadError("上传会话正在使用", 409);
    this.sessions.delete(id);
    await fs.rm(path.join(this.root, id), { recursive: true, force: true });
  }

  private async prune(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (!session.busy && now - session.lastAccessAt > SESSION_TTL_MS) {
        this.sessions.delete(id);
        await fs.rm(path.join(this.root, id), { recursive: true, force: true });
      }
    }
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || this.sessions.has(entry.name)) continue;
      const directory = path.join(this.root, entry.name);
      const stat = await fs.stat(directory);
      if (now - stat.mtimeMs > SESSION_TTL_MS) {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  }
}
