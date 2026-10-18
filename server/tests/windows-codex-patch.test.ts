import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { installWindowsCodexPatch } from "../src/harness-runtime/windows-codex-patch.js";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.join(os.tmpdir(), "openfars-windows-patch-"))) {
      throw new Error("Refusing cleanup outside patch fixture");
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe.runIf(process.platform === "win32")("Windows native Codex patch launcher", () => {
  it("preserves multiline UTF-8 argv and stdin, forwards diagnostics and native exit status", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-windows-patch-")); roots.push(root);
    const target = path.join(root, "home", "tmp", "arg0", "codex-generated");
    const native = path.join(root, "native codex.exe");
    const receiver = path.join(root, "receiver.cs");
    await fs.mkdir(target, { recursive: true });
    // A native process verifies the actual Windows quoting boundary without
    // requiring a model request or changing a business checkout.
    await fs.writeFile(receiver, `using System; using System.Text;
public static class Receiver { public static int Main(string[] args) {
  Console.OutputEncoding = new UTF8Encoding(false);
  if (args.Length != 2 || args[0] != "--codex-run-as-apply-patch") return 7;
  Console.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(args[1])));
  Console.Error.WriteLine("官方诊断"); return args[1].Contains("FAIL") ? 9 : 0;
}}`);
    const compiler = path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    await execute(compiler, ["/nologo", "/target:exe", `/out:${native}`, receiver], { windowsHide: true });
    await fs.writeFile(path.join(target, "apply_patch.bat"), `@echo off\r\n"${native}" --codex-run-as-apply-patch %*\r\n`);
    await installWindowsCodexPatch(path.join(root, "home"), native, path.join(root, "runtime"));
    const launcher = path.join(target, "apply_patch.exe");
    const patch = '*** Begin Patch\n*** Add File: 中文.txt\n+"引号" C:\\path\\file $value %PATH%\n*** End Patch';
    const direct = await execute(launcher, [patch], { windowsHide: true, encoding: "utf8" });
    expect(Buffer.from(direct.stdout.trim(), "base64").toString("utf8")).toBe(patch);
    expect(direct.stderr.trim()).toBe("官方诊断");
    const piped = spawn(launcher, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; let diagnostics = "";
    piped.stdout.on("data", chunk => output += chunk.toString("utf8"));
    piped.stderr.on("data", chunk => diagnostics += chunk.toString("utf8"));
    piped.stdin.end(Buffer.from(`\uFEFF\r\n${patch}\r\n`, "utf8"));
    const code = await new Promise<number | null>((resolve, reject) => {
      piped.once("error", reject); piped.once("close", resolve);
    });
    expect(code).toBe(0);
    expect(Buffer.from(output.trim(), "base64").toString("utf8")).toBe(patch);
    expect(diagnostics.trim()).toBe("官方诊断");
    await expect(execute(launcher, [patch.replace("中文.txt", "FAIL.txt")], { windowsHide: true })).rejects.toMatchObject({ code: 9 });
    await expect(execute(launcher, ["incomplete"], { windowsHide: true })).rejects.toMatchObject({ code: 1 });
    await fs.writeFile(path.join(target, "openfars-codex-path.txt"), "different.exe");
    await expect(installWindowsCodexPatch(path.join(root, "home"), native, path.join(root, "runtime"))).rejects.toThrow("binding changed");
  }, 15000);
});
