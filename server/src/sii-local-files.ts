import { promises as fs } from "node:fs";
import path from "node:path";
import type { FilesystemAuthority } from "./harness-runtime/filesystem-authority.js";
import { isWithin } from "./harness-runtime/invocation-inputs.js";

/** Apply the existing invocation authority to local CLI I/O, never to research decisions. */
export class SiiLocalFiles {
  constructor(readonly cwd: string, readonly authority: FilesystemAuthority) {}

  async assertPath(value: string, mode: "read" | "write", recursive = false): Promise<void> {
    if (!value || value.includes("\0") || value.startsWith("~")) throw new Error("Use an explicit local file path");
    if (value.split(/[\\/]/u).some(part => part === "." || part === "..")) {
      throw new Error("SII local paths must be normalized without traversal");
    }
    const target = path.resolve(this.cwd, value);
    const roots = mode === "write" ? this.authority.writeRoots : this.authority.readRoots;
    // Native yolo tools retain their Harness/OS contract. This business MCP
    // still validates its trusted local roots, aliases and protected state.
    // Its current assigned worktree may live outside the service user's home.
    const localRoots = this.authority.rawTools === "trusted-yolo"
      ? [...roots, this.authority.executionWorktree].filter(Boolean) : roots;
    let ancestor = target;
    const missing: string[] = [];
    let info;
    for (;;) {
      try { info = await fs.lstat(ancestor); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || mode === "read" || path.dirname(ancestor) === ancestor) throw error;
        missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
      }
    }
    const realAncestor = await fs.realpath(ancestor);
    const physical = path.join(realAncestor, ...missing);
    if (!localRoots.some(root => isWithin(target, root) && isWithin(physical, root)) ||
        this.authority.protectedRoots.some(root => isWithin(physical, root))) {
      throw new Error(`SII local ${mode} path is outside this invocation's file scope`);
    }
    if (realAncestor !== ancestor || info.isSymbolicLink() || info.isFile() && info.nlink !== 1) {
      throw new Error("SII local files cannot use symlink or hardlink aliases");
    }
    if (recursive && !missing.length && info.isDirectory()) {
      // SCP may traverse existing directory entries in either direction.
      for (const entry of await fs.readdir(target)) await this.assertPath(path.join(target, entry), mode, true);
    }
  }

  async assertCommand(args: string[]): Promise<void> {
    if (args.includes("--help") || args.includes("--version")) return;
    const notebook = args.indexOf("notebook");
    const action = notebook >= 0 ? args[notebook + 1] : undefined;
    if (action === "scp") {
      const values: string[] = [];
      let download = false;
      for (let index = notebook + 2; index < args.length; index++) {
        const arg = args[index]!;
        if (["--download", "-d"].includes(arg)) { download = true; continue; }
        if (["--recursive", "-r", "--ignore-target-cache"].includes(arg)) continue;
        if (/^-[rd]+$/.test(arg)) { download ||= arg.includes("d"); continue; }
        if (["--account", "--timeout", "-t"].includes(arg)) { index++; continue; }
        if (/^--(?:account|timeout)=/.test(arg)) continue;
        if (arg.startsWith("-")) throw new Error("Unrecognized SCP option; use notebook scp --help");
        values.push(arg);
      }
      if (values.length !== 3) throw new Error("SCP requires notebook, source and destination");
      await this.assertPath(values[download ? 2 : 1]!, download ? "write" : "read", true);
      return;
    }
    const readOptions = new Set(["--pubkey", "--public-key-file", "--post-start-script"]);
    const writeOptions = new Set<string>();
    if (action === "exec") writeOptions.add("--download");
    if (args.includes("env")) { writeOptions.add("--output"); writeOptions.add("-o"); }
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      const equal = arg.indexOf("=");
      const flag = equal < 0 ? arg : arg.slice(0, equal);
      const mode = readOptions.has(flag) ? "read" : writeOptions.has(flag) ? "write" : undefined;
      if (!mode) continue;
      const value = equal < 0 ? args[++index] : arg.slice(equal + 1);
      if (!value) throw new Error(`Provide a local file path for ${flag}`);
      await this.assertPath(value, mode, flag === "--download");
    }
    const batch = args.indexOf("batch");
    if (batch >= 0) {
      const config = args[batch + 1];
      if (!config || config.startsWith("-")) throw new Error("Provide a local batch configuration path");
      await this.assertPath(config, "read");
    }
  }
}
