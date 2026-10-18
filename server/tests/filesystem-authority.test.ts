import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  DescriptorFilesystemBroker,
  compileFilesystemAuthority,
  filesystemAuthorityPrompt,
  type FilesystemAuthority
} from "../src/harness-runtime/filesystem-authority.js";

const roots: string[] = [];
const helperPath = fileURLToPath(new URL(
  "../src/harness-runtime/descriptor-broker-helper.py",
  import.meta.url
));
const pythonExecutable = "/usr/bin/python3";
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {
    recursive: true,
    force: true
  })));
});

describe.runIf(process.platform === "linux")("FilesystemAuthority", () => {
  it("reads large files as bounded pages with exact bytes, EOF and optional snapshot consistency", async () => {
    const fixture = await authorityFixture();
    const authority = await compile(fixture, "workspace");
    const broker = await openBroker(authority);
    const data = Buffer.from("实验 α bounded workflow state\n".repeat(5000));
    await fs.writeFile(path.join(fixture.execution, "large.json"), data);
    const rootId = binding(authority, fixture.execution).id;
    try {
      await expect(broker.read(rootId, "large.json", 40000)).rejects.toThrow(/exceeds maxBytes.*offset=0/);
      const pages: Buffer[] = [];
      let offset = 0;
      let version: string | undefined;
      do {
        const page = await broker.readPage(rootId, "large.json", offset, 4096, version);
        expect(page.totalBytes).toBe(data.length);
        expect(page.bytes).toBeLessThanOrEqual(4096);
        expect(page.content).toEqual(data.subarray(offset, page.nextOffset));
        pages.push(page.content);
        offset = page.nextOffset;
        version = page.version;
        if (page.eof) break;
      } while (offset < data.length);
      expect(Buffer.concat(pages)).toEqual(data);
      expect(await broker.readPage(rootId, "large.json", data.length, 4096, version)).toMatchObject({ bytes: 0, nextOffset: data.length, eof: true });
      await fs.writeFile(path.join(fixture.execution, "large.json"), Buffer.from(data));
      await expect(broker.readPage(rootId, "large.json", 0, 4096, version)).rejects.toThrow(/version changed/);
    } finally { await broker.close(); }
  });

  it("keeps paged reads within pinned roots and refuses invalid offsets and page limits", async () => {
    const fixture = await authorityFixture();
    const authority = await compile(fixture, "workspace");
    const broker = await openBroker(authority);
    const rootId = binding(authority, fixture.execution).id;
    await fs.writeFile(path.join(fixture.root, "outside.txt"), "private outside");
    await fs.symlink(path.join(fixture.root, "outside.txt"), path.join(fixture.execution, "alias.txt"));
    try {
      await expect(broker.readPage(rootId, "../outside.txt")).rejects.toThrow();
      await expect(broker.readPage(rootId, "alias.txt")).rejects.toThrow();
      for (const [offset, limit] of [[-1, 1], [0.5, 1], [0, 0], [0, 4194305], [Number.MAX_SAFE_INTEGER + 1, 1]]) {
        await expect(broker.readPage(rootId, "nested/file.txt", offset, limit)).rejects.toThrow(/Invalid.*read page/);
      }
      await expect(broker.readPage(rootId, "agent-memory/writer/Memory.md", 999)).rejects.toThrow(/invalid read page/);
    } finally { await broker.close(); }
  });

  it.each(["workspace", "compute", "yolo"] as const)("terminal push receipt retains memory reads and denies %s business writes through the actual descriptor broker", async (permission) => {
    const fixture = await authorityFixture();
    const memoryBefore = await fs.readFile(fixture.memory);
    const authority = await compileFilesystemAuthority({ permission, role: "delivery", gitEnabled: true,
      terminalPushObservation: true, serviceUserRoot: fixture.serviceRoot, executionWorktree: fixture.execution,
      ownedMemoryPath: fixture.memory, projectWorktreeRoot: fixture.worktreeRoot,
      projectWorktrees: [fixture.execution, fixture.peer], protectedRoots: [fixture.protectedRoot] });
    expect(authority.writeRoots).toEqual([]);
    expect(authority.gitCapability).toBe("none");
    expect(authority.rawTools).toBe("forbidden");
    expect(authority.rootBindings.every((root) => !root.write)).toBe(true);
    const broker = await openBroker(authority);
    try {
      const rootId = binding(authority, fixture.execution).id;
      const relativeMemory = path.relative(fixture.execution, fixture.memory);
      expect((await broker.read(rootId, relativeMemory)).content).toEqual(memoryBefore);
      await expect(broker.writeAtomic(rootId, "receipt-business.txt", Buffer.from("denied"))).rejects.toThrow(/read-only/);
      await expect(broker.writeAtomic(rootId, relativeMemory, Buffer.from("overwrite"))).rejects.toThrow(/read-only/);
      await expect(broker.makeDirectory(rootId, "new-business")).rejects.toThrow(/read-only/);
      expect(await fs.readFile(fixture.memory)).toEqual(memoryBefore);
      await expect(fs.access(path.join(fixture.execution, "receipt-business.txt"))).rejects.toThrow();
    } finally { await broker.close(); }
  });

  it("compiles workspace, compute, yolo and leader authority without optimistic overlap", async () => {
    const fixture = await authorityFixture();
    const workspace = await compile(fixture, "workspace");
    expect(workspace.writeRoots).toEqual([fixture.execution]);
    expect(workspace.gitCapability).toBe("execution");
    expect(workspace.rawTools).toBe("forbidden");

    const compute = await compile(fixture, "compute");
    expect(compute.writeRoots).toEqual([fixture.execution, fixture.peer]);
    expect(compute.gitCapability).toBe("project-service");
    expect(compute.writeRoots).not.toContain(fixture.otherProject);

    const yolo = await compile(fixture, "yolo");
    expect(yolo.writeRoots).toEqual([fixture.serviceRoot]);
    expect(yolo.rawTools).toBe("trusted-yolo");

    const leader = await compileFilesystemAuthority({
      permission: "workspace",
      role: "leader",
      gitEnabled: true,
      serviceUserRoot: fixture.serviceRoot,
      projectWorktreeRoot: fixture.worktreeRoot,
      protectedRoots: [fixture.protectedRoot]
    });
    expect(leader.writeRoots).toEqual([]);
    expect(leader.gitCapability).toBe("none");
  });

  it("reads broadly but limits workspace writes to the execution descriptor", async () => {
    const fixture = await authorityFixture();
    const authority = await compile(fixture, "workspace");
    const broker = await openBroker(authority);
    try {
      const readRoot = binding(authority, fixture.serviceRoot).id;
      const writeRoot = binding(authority, fixture.execution).id;
      await fs.writeFile(path.join(fixture.serviceRoot, "outside-readable.txt"), "read marker");
      const read = await broker.read(readRoot, "outside-readable.txt");
      expect(read.content.toString("utf8")).toBe("read marker");

      await broker.makeDirectory(writeRoot, "created/deep");
      await expect(broker.listDirectory(writeRoot, "created")).resolves.toMatchObject({
        entries: [{ name: "deep", type: "directory" }],
        offset: 0,
        hasMore: false
      });
      await broker.writeAtomic(writeRoot, "created/deep/new.txt", Buffer.from("new parent write"));
      expect(await fs.readFile(path.join(fixture.execution, "created/deep/new.txt"), "utf8"))
        .toBe("new parent write");

      await broker.writeAtomic(writeRoot, "nested/result.txt", Buffer.from("owned write"));
      expect(await fs.readFile(path.join(fixture.execution, "nested/result.txt"), "utf8"))
        .toBe("owned write");
      await expect(broker.writeAtomic(readRoot, "outside-write.txt", Buffer.from("deny")))
        .rejects.toThrow(/read-only/);
      await expect(fs.access(path.join(fixture.serviceRoot, "outside-write.txt"))).rejects.toThrow();
    } finally {
      await broker.close();
    }
  });

  it("allows a Leader to author only the current proposal, with no business Git or file authority", async () => {
    const fixture = await authorityFixture();
    const proposal = path.join(fixture.execution, ".scienceevolve", "management", "inv-proposal", "proposal");
    await fs.mkdir(proposal, { recursive: true });
    const reference = ".scienceevolve/workflow-current.json";
    await fs.writeFile(path.join(fixture.execution, reference), "{\"baseVersion\":{\"revision\":3}}\n");
    const authority = await compileFilesystemAuthority({ permission: "workspace", role: "leader", gitEnabled: true,
      serviceUserRoot: fixture.serviceRoot, executionWorktree: fixture.execution, managementWriteRoot: proposal,
      projectWorktreeRoot: fixture.worktreeRoot, protectedRoots: [fixture.protectedRoot] });
    expect(authority.writeRoots).toEqual([proposal]);
    expect(authority.gitCapability).toBe("none");
    expect(authority.rawTools).toBe("forbidden");
    const broker = await openBroker(authority);
    try {
      await broker.writeAtomic(binding(authority, proposal).id, "workflow.json", Buffer.from("{}"));
      expect((await broker.read(binding(authority, fixture.execution).id, reference)).content.toString("utf8")).toContain('"revision":3');
      await expect(broker.writeAtomic(binding(authority, fixture.execution).id, reference, Buffer.from("{}")))
        .rejects.toThrow(/read-only/);
      await expect(broker.writeAtomic(binding(authority, fixture.serviceRoot).id, "business.txt", Buffer.from("deny")))
        .rejects.toThrow(/read-only/);
    } finally { await broker.close(); }
    await expect(compileFilesystemAuthority({ permission: "workspace", role: "leader", gitEnabled: true,
      serviceUserRoot: fixture.serviceRoot, executionWorktree: fixture.execution, managementWriteRoot: fixture.execution,
      protectedRoots: [fixture.protectedRoot] })).rejects.toThrow(/limited/);
  });

  it.each(["legacy", "external"] as const)("reads %s management snapshots outside the service home without granting business writes", async location => {
    const fixture = await authorityFixture();
    const home = path.join(fixture.root, "separate-home");
    const snapshot = location === "legacy" ? path.join(fixture.execution, ".scienceevolve", "management", "inv-outside")
      : path.join(fixture.root, "project", "agent-inputs", "main", "management", "inv-outside");
    const proposal = path.join(snapshot, "proposal");
    await Promise.all([fs.mkdir(home), fs.mkdir(proposal, { recursive: true })]);
    const inbox = path.join(snapshot, "inv-outside-Inbox.md");
    await fs.writeFile(inbox, "current scoped assignment");
    const authority = await compileFilesystemAuthority({ permission: "workspace", role: "leader", gitEnabled: true,
      serviceUserRoot: home, executionWorktree: fixture.execution, managementWriteRoot: proposal,
      inputReadRoots: [snapshot], protectedRoots: [fixture.protectedRoot] });
    const broker = await openBroker(authority);
    try {
      const readRoot = binding(authority, snapshot).id;
      expect((await broker.read(readRoot, "inv-outside-Inbox.md")).content.toString()).toBe("current scoped assignment");
      await expect(broker.writeAtomic(binding(authority, fixture.execution).id, "business.txt", Buffer.from("deny")))
        .rejects.toThrow(/read-only/);
      expect(authority.writeRoots).toEqual([proposal]);
      expect(filesystemAuthorityPrompt(authority, { workspacePath: fixture.execution, inboxPath: inbox,
        memoryPath: path.join(snapshot, "Memory.md"), workflowAuthoringPath: path.join(proposal, "workflow.json") }))
        .toContain(`Invocation Inbox: rootId="${readRoot}", path="inv-outside-Inbox.md"`);
    } finally { await broker.close(); }
  });

  it("fails closed on traversal, absolute, symlink, hardlink and shared .git aliases", async () => {
    const fixture = await authorityFixture();
    const authority = await compile(fixture, "workspace");
    const broker = await openBroker(authority);
    const writeRoot = binding(authority, fixture.execution).id;
    try {
      await expect(broker.writeAtomic(writeRoot, "../escape.txt", Buffer.from("deny")))
        .rejects.toThrow(/invalid opaque root or relative path/);
      await expect(broker.writeAtomic(writeRoot, "/absolute.txt", Buffer.from("deny")))
        .rejects.toThrow(/invalid opaque root or relative path/);
      await expect(broker.writeAtomic(writeRoot, ".git/config", Buffer.from("deny")))
        .rejects.toThrow(/invalid opaque root or relative path/);

      const outside = path.join(fixture.serviceRoot, "outside-target.txt");
      await fs.writeFile(outside, "outside original");
      await fs.symlink(outside, path.join(fixture.execution, "nested", "symlink.txt"));
      await expect(broker.writeAtomic(writeRoot, "nested/symlink.txt", Buffer.from("deny")))
        .rejects.toThrow(/refused|loop|symbolic|unaliased/i);
      await expect(broker.listDirectory(writeRoot, "nested/symlink.txt"))
        .rejects.toThrow(/refused|loop|symbolic|directory/i);
      await expect(broker.makeDirectory(writeRoot, "nested/symlink.txt/child"))
        .rejects.toThrow(/refused|loop|symbolic|directory/i);
      expect(await fs.readFile(outside, "utf8")).toBe("outside original");

      await fs.link(outside, path.join(fixture.execution, "nested", "hardlink.txt"));
      await expect(broker.writeAtomic(writeRoot, "nested/hardlink.txt", Buffer.from("deny")))
        .rejects.toThrow(/unaliased/);
      expect(await fs.readFile(outside, "utf8")).toBe("outside original");
    } finally {
      await broker.close();
    }
  });

  it("holds the authorized root descriptor across an ancestor pathname swap", async () => {
    const fixture = await authorityFixture();
    const authority = await compile(fixture, "workspace");
    const broker = await openBroker(authority);
    const writeRoot = binding(authority, fixture.execution).id;
    const moved = `${fixture.execution}-moved`;
    const attacker = path.join(fixture.serviceRoot, "attacker");
    await fs.mkdir(attacker);
    try {
      await fs.rename(fixture.execution, moved);
      await fs.symlink(attacker, fixture.execution, "dir");
      await broker.writeAtomic(writeRoot, "nested/after-swap.txt", Buffer.from("anchored"));
      expect(await fs.readFile(path.join(moved, "nested/after-swap.txt"), "utf8")).toBe("anchored");
      await expect(fs.access(path.join(attacker, "nested/after-swap.txt"))).rejects.toThrow();
    } finally {
      await broker.close();
      await fs.rm(fixture.execution, { force: true });
      await fs.rename(moved, fixture.execution);
    }
  });

  it("rejects a FIFO without blocking before the regular-file check", async () => {
    const fixture = await authorityFixture();
    const authority = await compile(fixture, "workspace");
    const broker = await openBroker(authority);
    const readRoot = binding(authority, fixture.serviceRoot).id;
    const fifo = path.join(fixture.serviceRoot, "blocking.fifo");
    await execFileAsync("/usr/bin/mkfifo", [fifo]);
    try {
      await expect(Promise.race([
        broker.read(readRoot, "blocking.fifo"),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("FIFO read blocked")),
          1_000
        ))
      ])).rejects.toThrow(/regular file/);
    } finally {
      await broker.close();
    }
  });

  it("advertises and exercises the kernel NO_XDEV primitive", async () => {
    const fixture = await authorityFixture();
    const authority = await compile(fixture, "workspace");
    const broker = await openBroker(authority);
    try {
      await expect(broker.matrix()).resolves.toMatchObject({
        primitive: "openat2",
        resolve: ["BENEATH", "NO_SYMLINKS", "NO_MAGICLINKS", "NO_XDEV"]
      });
    } finally {
      await broker.close();
    }
  });

  it("rejects compute registrations outside the current project and protected overlap", async () => {
    const fixture = await authorityFixture();
    await expect(compileFilesystemAuthority({
      permission: "compute",
      role: "delivery",
      gitEnabled: true,
      serviceUserRoot: fixture.serviceRoot,
      executionWorktree: fixture.execution,
      ownedMemoryPath: fixture.memory,
      projectWorktreeRoot: fixture.worktreeRoot,
      projectWorktrees: [fixture.execution, fixture.otherProject],
      protectedRoots: [fixture.protectedRoot]
    })).rejects.toThrow(/outside the current project's worktree root/);

    await expect(compileFilesystemAuthority({
      permission: "workspace",
      role: "delivery",
      gitEnabled: true,
      serviceUserRoot: fixture.serviceRoot,
      executionWorktree: fixture.protectedRoot,
      ownedMemoryPath: path.join(fixture.protectedRoot, "Memory.md"),
      projectWorktreeRoot: fixture.worktreeRoot,
      projectWorktrees: [fixture.execution],
      protectedRoots: [fixture.protectedRoot]
    })).rejects.toThrow(/overlaps a protected/);
  });
});

async function authorityFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-authority-"));
  roots.push(root);
  const serviceRoot = path.join(root, "service-user");
  const worktreeRoot = path.join(serviceRoot, "project-worktrees");
  const execution = path.join(worktreeRoot, "execution");
  const peer = path.join(worktreeRoot, "peer");
  const otherProject = path.join(serviceRoot, "other-project", "worktree");
  const protectedRoot = path.join(serviceRoot, "openfars-state");
  await Promise.all([
    fs.mkdir(path.join(execution, "nested"), { recursive: true }),
    fs.mkdir(peer, { recursive: true }),
    fs.mkdir(otherProject, { recursive: true }),
    fs.mkdir(protectedRoot, { recursive: true })
  ]);
  const memory = path.join(execution, "agent-memory", "writer", "Memory.md");
  await fs.mkdir(path.dirname(memory), { recursive: true });
  await fs.writeFile(memory, "memory");
  await fs.writeFile(path.join(protectedRoot, "Memory.md"), "protected");
  return { root, serviceRoot, worktreeRoot, execution, peer, otherProject, protectedRoot, memory };
}

async function compile(
  fixture: Awaited<ReturnType<typeof authorityFixture>>,
  permission: "workspace" | "compute" | "yolo"
) {
  return compileFilesystemAuthority({
    permission,
    role: "delivery",
    gitEnabled: true,
    serviceUserRoot: fixture.serviceRoot,
    executionWorktree: fixture.execution,
    ownedMemoryPath: fixture.memory,
    projectWorktreeRoot: fixture.worktreeRoot,
    projectWorktrees: [fixture.execution, fixture.peer],
    protectedRoots: [fixture.protectedRoot]
  });
}

async function openBroker(authority: FilesystemAuthority) {
  return DescriptorFilesystemBroker.open({ authority, helperPath, pythonExecutable });
}

function binding(authority: FilesystemAuthority, root: string) {
  const found = authority.rootBindings.find((item) => item.path === root);
  if (!found) throw new Error(`missing root binding for ${root}`);
  return found;
}
