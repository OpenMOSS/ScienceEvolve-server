import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compileFilesystemAuthority, DescriptorFilesystemBroker, filesystemAuthorityPrompt,
  prepareFilesystemAuthorityMcp, validatePreparedFilesystemMcp, type CompileFilesystemAuthorityRequest
} from "../src/harness-runtime/filesystem-authority.js";
import { windowsExecutable } from "../src/harness-runtime/windows-resident.js";

const roots: string[] = [];
const helperPath = fileURLToPath(new URL(process.platform === "win32"
  ? "../src/harness-runtime/descriptor-broker-windows.py" : "../src/harness-runtime/descriptor-broker-helper.py", import.meta.url));
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe.runIf(process.platform === "linux" || process.platform === "win32")("restricted closing filesystem", () => {
  it.each(["workspace", "compute", "yolo"] as const)("limits %s to exact files through the real broker", async permission => {
    const f = await fixture(permission);
    const authority = await compileFilesystemAuthority(f.request);
    const writer = authority.rootBindings.find(root => root.path === f.worktree)!;
    const reader = authority.rootBindings.find(root => root.path === f.home)!;
    expect(writer.writeFiles).toEqual([f.memoryRelative, "leftover.txt"]);
    expect(Object.isFrozen(writer.writeFiles)).toBe(true);
    expect(Object.isFrozen(writer)).toBe(true);
    expect(authority.rawTools).toBe("forbidden");
    expect(authority.gitCapability).toBe("none");
    expect(authority.writeRoots).toEqual([f.worktree]);
    const broker = await DescriptorFilesystemBroker.open({ authority, helperPath, pythonExecutable: await python() });
    try {
      const before = await broker.read(writer.id, f.memoryRelative);
      expect(before.content.toString()).toBe("original memory");
      await broker.writeAtomic(writer.id, f.memoryRelative, Buffer.from("Agent's own closing memory"));
      expect(await fs.readFile(f.memoryPath, "utf8")).toBe("Agent's own closing memory");
      for (const file of ["business.txt", "leftover.txt/new", "leftover.txt.more", "agent-memory/other/Memory.md", ".scienceevolve/control.json"]) {
        await expect(broker.writeAtomic(writer.id, file, Buffer.from("denied"))).rejects.toThrow();
        await expect(broker.removeFile(writer.id, file)).rejects.toThrow();
      }
      await expect(broker.writeAtomic(reader.id, "outside.txt", Buffer.from("denied"))).rejects.toThrow();
      await expect(broker.removeFile(reader.id, "outside.txt")).rejects.toThrow();
      await expect(broker.makeDirectory(writer.id, "leftover.txt")).rejects.toThrow();
      await expect(broker.makeDirectory(writer.id, "new-directory")).rejects.toThrow();
      expect(await broker.removeFile(writer.id, "leftover.txt")).toEqual({ removed: true });
      expect(await broker.removeFile(writer.id, "leftover.txt")).toEqual({ removed: false });
      await broker.writeAtomic(writer.id, "leftover.txt", Buffer.from([0, 255, 42]));
      expect(await fs.readFile(path.join(f.worktree, "leftover.txt"))).toEqual(Buffer.from([0, 255, 42]));
      expect(await fs.readFile(path.join(f.worktree, "business.txt"), "utf8")).toBe("accepted business");
      expect((await fs.readdir(f.worktree)).some(name => name.startsWith(".openfars-"))).toBe(false);
    } finally { await broker.close(); }
    const prompt = filesystemAuthorityPrompt(authority, { workspacePath: f.worktree, inboxPath: f.memoryPath, memoryPath: f.memoryPath });
    expect(prompt).toContain(JSON.stringify(writer.writeFiles));
    expect(prompt).toContain("only the explicit closing files are writable");
  });

  it("keeps report-bound memory closing limited to the original Agent's sole Memory.md", async () => {
    const f = await fixture();
    f.request.restrictedWorktreeClosing!.scope = {
      kind: "bound-report-memory", reportHeadSha: "a".repeat(40), paths: [f.memoryRelative]
    };
    const authority = await compileFilesystemAuthority(f.request);
    const writer = authority.rootBindings.find(root => root.path === f.worktree)!;
    expect(writer.writeFiles).toEqual([f.memoryRelative]);
    const broker = await DescriptorFilesystemBroker.open({ authority, helperPath, pythonExecutable: await python() });
    try {
      await expect(broker.writeAtomic(writer.id, "leftover.txt", Buffer.from("deny"))).rejects.toThrow();
      await expect(broker.removeFile(writer.id, "leftover.txt")).rejects.toThrow();
      expect(await broker.removeFile(writer.id, f.memoryRelative)).toEqual({ removed: true });
      await broker.writeAtomic(writer.id, f.memoryRelative, Buffer.from("Agent selected final memory"));
    } finally { await broker.close(); }
  });

  it.each([
    { role: "leader" as const }, { role: "final-integration" as const }, { gitEnabled: false },
    { terminalPushObservation: true }, { terminalPushCoordination: true }
  ])("rejects mixed or wrong closing authority %j", async change => {
    const f = await fixture();
    await expect(compileFilesystemAuthority({ ...f.request, ...change })).rejects.toThrow();
  });

  it("rejects another owner's memory, management proposals and overbroad manifests", async () => {
    const f = await fixture();
    await expect(compileFilesystemAuthority({ ...f.request, restrictedWorktreeClosing: {
      ...f.request.restrictedWorktreeClosing!, agentId: "other"
    } })).rejects.toThrow();
    await expect(compileFilesystemAuthority({ ...f.request, managementWriteRoot: f.worktree })).rejects.toThrow();
    for (const paths of [["agent-memory/other/Memory.md"], ["nested"], ["leftover*"], ["../outside.txt"]]) {
      await expect(compileFilesystemAuthority({ ...f.request, restrictedWorktreeClosing: {
        ...f.request.restrictedWorktreeClosing!, scope: { kind: "completed-leftovers", reportHeadSha: "a".repeat(40), paths }
      } })).rejects.toThrow();
    }
  });

  it("does not add file removal to ordinary or receipt-only filesystem authority", async () => {
    const f = await fixture();
    for (const terminalPushObservation of [false, true]) {
      const authority = await compileFilesystemAuthority({ ...f.request, restrictedWorktreeClosing: undefined, terminalPushObservation });
      const writer = authority.rootBindings.find(root => root.path === f.worktree)!;
      const broker = await DescriptorFilesystemBroker.open({ authority, helperPath, pythonExecutable: await python() });
      try { await expect(broker.removeFile(writer.id, "leftover.txt")).rejects.toThrow(); }
      finally { await broker.close(); }
    }
    expect(await fs.readFile(path.join(f.worktree, "leftover.txt"), "utf8")).toBe("Agent decides whether to keep");
  });

  it.each(["source", "compiled"] as const)("carries exact files in private config and enforces them through actual %s MCP tools", async mode => {
    const f = await fixture();
    const authority = await compileFilesystemAuthority(f.request);
    let bridgePath: string | undefined;
    if (mode === "compiled") {
      // Exercise the standalone emitted bridge and its reviewed byte pin;
      // this does not rebuild or replace any deployed server artifacts.
      const ts = await import("typescript");
      const source = await fs.readFile(new URL("../src/harness-runtime/descriptor-broker-mcp.ts", import.meta.url), "utf8");
      const compiled = ts.transpileModule(source, { fileName: "descriptor-broker-mcp.ts", compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, sourceMap: true
      } });
      bridgePath = path.join(f.runtime, "descriptor-broker-mcp.js");
      await fs.writeFile(bridgePath, compiled.outputText, { mode: 0o600 });
    }
    const prepared = await prepareFilesystemAuthorityMcp({ authority, executionRuntimePath: f.runtime, pythonExecutable: await python(), bridgePath });
    await validatePreparedFilesystemMcp(prepared, authority, f.runtime);
    const writer = authority.rootBindings.find(root => root.path === f.worktree)!;
    const config = JSON.parse(await fs.readFile(prepared.configPath, "utf8"));
    expect(config.roots.find((root: { id: string }) => root.id === writer.id).writeFiles).toEqual(writer.writeFiles);
    const client = rpc(prepared.row.command, prepared.row.args);
    try {
      const listed = await client.request({ method: "tools/list" });
      expect(listed.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
        "authority_matrix", "list_directory", "read_file", "remove_file", "write_file"
      ]);
      const call = (name: string, args: Record<string, unknown>) => client.request({ method: "tools/call", params: { name, arguments: args } });
      expect((await call("write_file", { rootId: writer.id, path: f.memoryRelative, content: "native tool memory" })).result.isError).not.toBe(true);
      expect(await fs.readFile(f.memoryPath, "utf8")).toBe("native tool memory");
      for (const [name, args] of [
        ["write_file", { rootId: writer.id, path: "business.txt", content: "deny", writeFiles: ["business.txt"] }],
        ["remove_file", { rootId: writer.id, path: "business.txt" }],
        ["make_directory", { rootId: writer.id, path: "new" }],
        ["git_stage", { paths: [f.memoryRelative] }], ["git_commit", { message: "deny" }]
      ] as const) expect((await call(name, args)).result.isError).toBe(true);
      expect((await call("remove_file", { rootId: writer.id, path: "leftover.txt" })).result.isError).not.toBe(true);
      await expect(fs.access(path.join(f.worktree, "leftover.txt"))).rejects.toThrow();
      expect(await fs.readFile(path.join(f.worktree, "business.txt"), "utf8")).toBe("accepted business");
      const alteredAuthority = { ...authority, rootBindings: authority.rootBindings.map(root => root.writeFiles
        ? { ...root, writeFiles: [...root.writeFiles, "business.txt"] } : root) };
      await expect(validatePreparedFilesystemMcp(prepared, alteredAuthority, f.runtime)).rejects.toThrow();
    } finally { await client.close(); }
  }, 20_000);

  it.each([null, [], ["../file"], [".git/config"], ["x", "x"], ["x", "x/y"], ["x*"], ["x:ads"], ["x\\y"]])(
    "refuses malformed manifests inside the helper, independent of the TypeScript wrapper: %j", async writeFiles => {
      const f = await fixture();
      const client = rpc(await python(), ["-I", "-B", helperPath]);
      try {
        const response = await client.request({ action: "initialize", roots: [{ id: "fixed", path: f.worktree, write: true, writeFiles }] });
        expect(response.ok).toBe(false);
        expect((await client.request({ action: "write", rootId: "fixed", relativePath: "business.txt", contentBase64: "eA==" })).ok).toBe(false);
      } finally { await client.close(); }
    });

  it("rejects mixed writable roots and cannot extend an initialized helper's manifest", async () => {
    const f = await fixture();
    const client = rpc(await python(), ["-I", "-B", helperPath]);
    try {
      const root = { id: "fixed", path: f.worktree, write: true, writeFiles: ["leftover.txt"] };
      expect((await client.request({ action: "initialize", roots: [root, { id: "wide", path: f.home, write: true }] })).ok).toBe(false);
      expect((await client.request({ action: "initialize", roots: [{ ...root, write: false }] })).ok).toBe(false);
      expect((await client.request({ action: "initialize", roots: [root] })).ok).toBe(true);
      expect((await client.request({ action: "initialize", roots: [{ ...root, writeFiles: ["business.txt"] }] })).ok).toBe(false);
      expect((await client.request({ action: "write", rootId: "fixed", relativePath: "business.txt", contentBase64: "eA==", writeFiles: ["business.txt"] })).ok).toBe(false);
      expect((await client.request({ action: "remove", rootId: "fixed", relativePath: "business.txt" })).ok).toBe(false);
      expect(await fs.readFile(path.join(f.worktree, "business.txt"), "utf8")).toBe("accepted business");
    } finally { await client.close(); }
  });

  it.runIf(process.platform === "linux").each(["symlink", "hardlink", "directory", "parent-symlink"] as const)(
    "rechecks %s aliases at each write/removal after compilation", async alias => {
      const f = await fixture();
      const authority = await compileFilesystemAuthority(f.request);
      const writer = authority.rootBindings.find(root => root.path === f.worktree)!;
      const broker = await DescriptorFilesystemBroker.open({ authority, helperPath, pythonExecutable: await python() });
      try {
        const external = path.join(f.home, "external.txt");
        await fs.writeFile(external, "outside unchanged");
        const target = path.join(f.worktree, "leftover.txt");
        let relative = "leftover.txt";
        if (alias === "parent-symlink") {
          await fs.rm(path.dirname(f.memoryPath), { recursive: true });
          await fs.symlink(f.home, path.dirname(f.memoryPath));
          relative = f.memoryRelative;
        } else {
          await fs.unlink(target);
          if (alias === "symlink") await fs.symlink(external, target);
          else if (alias === "hardlink") await fs.link(external, target);
          else await fs.mkdir(target);
        }
        await expect(broker.writeAtomic(writer.id, relative, Buffer.from("denied"))).rejects.toThrow();
        await expect(broker.removeFile(writer.id, relative)).rejects.toThrow();
        expect(await fs.readFile(external, "utf8")).toBe("outside unchanged");
      } finally { await broker.close(); }
    });
});

async function fixture(permission: "workspace" | "compute" | "yolo" = "workspace") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-closing-files-"));
  roots.push(root);
  const home = path.join(root, "home"), worktree = path.join(home, "worktrees", "original"), runtime = path.join(root, "runtime");
  const memoryRelative = "agent-memory/writer/Memory.md", memoryPath = path.join(worktree, memoryRelative);
  await fs.mkdir(path.dirname(memoryPath), { recursive: true });
  await fs.mkdir(path.join(worktree, "nested"));
  await fs.mkdir(runtime);
  await fs.writeFile(memoryPath, "original memory");
  await fs.writeFile(path.join(worktree, "leftover.txt"), "Agent decides whether to keep");
  await fs.writeFile(path.join(worktree, "business.txt"), "accepted business");
  const request: CompileFilesystemAuthorityRequest = {
    permission, role: "delivery", gitEnabled: true, serviceUserRoot: home, executionWorktree: worktree,
    ownedMemoryPath: memoryPath, protectedRoots: [runtime], restrictedWorktreeClosing: {
      agentId: "writer", scope: { kind: "completed-leftovers", reportHeadSha: "a".repeat(40), paths: ["leftover.txt", memoryRelative] }
    }
  };
  return { root, home, worktree, runtime, memoryRelative, memoryPath, request };
}

async function python() { return process.platform === "win32" ? windowsExecutable("python.exe") : "/usr/bin/python3"; }

function rpc(command: string, args: readonly string[]) {
  const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let id = 0, stderr = "";
  child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-8192); });
  lines.on("line", line => { const value = JSON.parse(line); pending.get(value.id)?.resolve(value); pending.delete(value.id); });
  child.on("error", error => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); });
  child.on("close", () => { for (const waiter of pending.values()) waiter.reject(new Error(stderr || "fixture subprocess closed")); pending.clear(); lines.close(); });
  return {
    async request(value: Record<string, unknown>): Promise<any> {
      const nextId = ++id;
      const response = new Promise((resolve, reject) => pending.set(nextId, { resolve, reject }));
      child.stdin.write(`${JSON.stringify({ ...value, id: nextId })}\n`);
      return response;
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      child.stdin.end();
      const timeout = setTimeout(() => child.kill(), 2000);
      try { await closed; } finally { clearTimeout(timeout); }
    }
  };
}
