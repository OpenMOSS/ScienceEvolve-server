import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { protectWindowsRuntimeFile, windowsExecutable, windowsRuntimeFileIsPrivate } from "../src/harness-runtime/windows-resident.js";

const execute = promisify(execFile);
describe.runIf(process.platform === "win32")("Windows durable resident publication", () => {
  it("waits for a transient no-delete-sharing reader before replacing the private launch claim", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-windows-publication-"));
    try {
      const file = path.join(root, "claim.json");
      await fs.writeFile(file, '{"status":"launching"}');
      await protectWindowsRuntimeFile(file);
      const source = path.join(root, "locker.cs");
      const locker = path.join(root, "locker.exe");
      await fs.writeFile(source, `using System; using System.IO; using System.Threading;
public static class Locker { public static void Main(string[] args) {
  using (var input = new FileStream(args[0], FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
    Console.WriteLine("locked"); Console.Out.Flush(); Thread.Sleep(700);
  }
}}`);
      const compiler = path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
      await execute(compiler, ["/nologo", "/target:exe", `/out:${locker}`, source], { windowsHide: true });
      const reader = spawn(locker, [file], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; reader.stdout.on("data", chunk => output += chunk.toString());
      const closed = new Promise((resolve, reject) => { reader.once("close", resolve); reader.once("error", reject); });
      try {
        await expect.poll(() => output, { timeout: 1000 }).toContain("locked");
        const helper = fileURLToPath(new URL("../src/harness-runtime/windows-resident-helper.py", import.meta.url));
        const script = "import importlib.util,sys;s=importlib.util.spec_from_file_location('helper',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.atomic_json(sys.argv[2],{'status':'spawned'})";
        await execute(await windowsExecutable("python.exe"), ["-I", "-B", "-c", script, helper, file], { windowsHide: true, timeout: 5000 });
        expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ status: "spawned" });
        expect(await windowsRuntimeFileIsPrivate(file)).toBe(true);
      } finally { reader.kill(); await closed; }
    } finally {
      if (!path.resolve(root).startsWith(path.join(os.tmpdir(), "openfars-windows-publication-"))) throw new Error("Refusing cleanup outside publication fixture");
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15000);
});
