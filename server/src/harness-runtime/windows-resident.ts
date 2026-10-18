import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LaunchPlan } from "./contracts.js";
import type { ResidentProcessCleanupIdentity } from "./process-host.js";
import type { ResidentProcessIdentity } from "./resident-lease.js";

const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "windows-resident-helper.py");
const WINDOWS_RESIDENT_HELPER_SHA256 = "443280b6de2976fd5c7520c76bcc6c673139a6cc364b707582453d913c9d62d4";
const registered = new Map<number, ResidentProcessIdentity>();
let pythonPath: string | undefined;

export async function windowsExecutable(name: string): Promise<string> {
  const directories = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter);
  for (const directory of directories) {
    const candidate = path.join(directory.replace(/^"|"$/g, ""), name);
    try {
      const info = await fs.lstat(candidate);
      if (info.isFile() && !info.isSymbolicLink()) return await fs.realpath(candidate);
    } catch { /* Continue through the service's executable search path. */ }
  }
  throw new Error(`Windows resident requires ${name} on the service PATH`);
}

async function helper(request: Record<string, unknown>): Promise<any> {
  await assertHelperDigest();
  pythonPath ??= await windowsExecutable("python.exe");
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath!, ["-I", "-B", helperPath], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP }
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Windows resident control timed out")); }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-65_536); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4_096); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Windows resident control failed: ${stderr.trim()}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Windows resident control returned invalid JSON")); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function assertHelperDigest(): Promise<void> {
  const info = await fs.lstat(helperPath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
    createHash("sha256").update(await fs.readFile(helperPath)).digest("hex") !== WINDOWS_RESIDENT_HELPER_SHA256) {
    throw new Error("Windows resident helper does not match the pinned build");
  }
}

export async function protectWindowsRuntimeFile(file: string): Promise<void> {
  const result = await helper({ action: "private-file", file, protect: true });
  if (result?.private !== true) throw new Error("Windows runtime file did not receive its private DACL");
}

export async function windowsRuntimeFileIsPrivate(file: string): Promise<boolean> {
  return (await helper({ action: "private-file", file })).private === true;
}

export async function readWindowsProcessIdentity(pid: number, jobName?: string): Promise<ResidentProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid Windows resident PID");
  const value = await helper({ action: "identity", pid });
  if (!value || value.pid !== pid || value.bootId !== "win32" || !/^\d+$/.test(value.startTicks)) {
    throw new Error("Windows resident process is no longer alive");
  }
  const known = registered.get(pid);
  if (jobName || known?.startTicks === value.startTicks) {
    value.windowsJobName = jobName ?? known?.windowsJobName;
  }
  return value;
}

export async function controlWindowsResident(identity: ResidentProcessIdentity,
  action: "probe" | "pause" | "resume" | "terminate"): Promise<{ alive: boolean; stopped?: boolean; members: number[] }> {
  if (!identity.windowsJobName || identity.bootId !== "win32" || !identity.startTicks) {
    throw new Error("Windows resident control requires its acknowledged job and process creation identity");
  }
  return helper({ action, pid: identity.pid, startTicks: identity.startTicks, windowsJobName: identity.windowsJobName });
}

export function registeredWindowsResident(child: ChildProcessWithoutNullStreams): ResidentProcessIdentity | undefined {
  return child.pid ? registered.get(child.pid) : undefined;
}

async function privateJson(file: string, value: unknown): Promise<void> {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); } finally { await handle.close(); }
  await protectWindowsRuntimeFile(file);
}

async function readJson(file: string): Promise<any | undefined> {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65_536) {
      throw new Error("Windows resident authority record is not a private regular file");
    }
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function files(identity: ResidentProcessCleanupIdentity, runtimePath: string) {
  const epoch = identity.role === "leader" ? identity.coordinatorEpoch : identity.ownershipEpoch;
  if (!Number.isSafeInteger(epoch) || epoch < 1 || !identity.projectId || !identity.scopeId ||
    !identity.harnessId || !["leader", "delivery", "final-integration"].includes(identity.role)) {
    throw new Error("Invalid Windows resident cleanup authority");
  }
  return { claimFile: path.join(runtimePath, `resident-launch-claim-v1-${epoch}.json`),
    fenceFile: path.join(runtimePath, `resident-stop-fence-v1-${epoch}.json`) };
}

function sameAuthority(left: unknown, right: unknown): boolean {
  // Identity values are server-owned and built in a stable key order.
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function prepareWindowsResidentLaunch(identity: ResidentProcessCleanupIdentity,
  runtimePath: string, plan: LaunchPlan): Promise<{ command: string; args: string[]; claimFile: string; configFile: string }> {
  pythonPath ??= await windowsExecutable("python.exe");
  await fs.mkdir(runtimePath, { recursive: true, mode: 0o700 });
  await assertHelperDigest();
  const { claimFile, fenceFile } = files(identity, runtimePath);
  if (await readJson(fenceFile)) throw new Error("Windows resident launch is fenced for this authority epoch");
  const owner = await readWindowsProcessIdentity(process.pid);
  const windowsJobName = `Local\\OpenFARS-${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24)}-${randomUUID()}`;
  const claim = { schemaVersion: 1, protocol: "trusted-supervisor-v1", platform: "win32", identity, owner,
    status: "launching", windowsJobName };
  const configFile = path.join(runtimePath, `resident-supervisor-v1-${randomUUID()}.json`);
  await privateJson(configFile, { identity, claimFile, fenceFile, windowsJobName,
    command: plan.command, args: plan.args, cwd: plan.cwd });
  try { await privateJson(claimFile, claim); } catch (error) {
    await fs.unlink(configFile);
    throw error;
  }
  if (await readJson(fenceFile)) {
    await fs.unlink(configFile);
    await fs.unlink(claimFile);
    throw new Error("Windows resident launch was fenced before spawn");
  }
  return { command: pythonPath, args: ["-I", "-B", helperPath, "supervise", configFile], claimFile, configFile };
}

export async function acknowledgeWindowsResident(identity: ResidentProcessCleanupIdentity,
  claimFile: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  const initial = await readJson(claimFile);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const claim = await readJson(claimFile);
    if (!claim || claim.protocol !== "trusted-supervisor-v1" || claim.platform !== "win32" ||
      !sameAuthority(claim.identity, identity) || !sameAuthority(claim.owner, initial.owner) ||
      claim.windowsJobName !== initial.windowsJobName) throw new Error("Windows supervisor changed launch authority");
    if (claim.status === "spawned") {
      const current = await readWindowsProcessIdentity(child.pid!);
      if (claim.process?.pid !== child.pid || current.startTicks !== claim.process.startTicks ||
        claim.process.windowsJobName !== claim.windowsJobName) throw new Error("Windows supervisor identity does not match its child process");
      registered.set(child.pid!, { ...current, windowsJobName: claim.windowsJobName });
      child.once("close", () => {
        if (registered.get(child.pid!)?.startTicks === current.startTicks) registered.delete(child.pid!);
      });
      if (!(await controlWindowsResident(registered.get(child.pid!)!, "probe")).alive) {
        throw new Error("Windows supervisor job was not alive at launch acknowledgement");
      }
      return;
    }
    if (claim.status !== "launching" || child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Windows resident supervisor exited before launch acknowledgement");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Windows resident supervisor did not acknowledge launch");
}

export async function cleanupWindowsResident(identity: ResidentProcessCleanupIdentity,
  runtimePath: string, allowMissingClaim: boolean): Promise<void> {
  const { claimFile, fenceFile } = files(identity, runtimePath);
  await fs.mkdir(runtimePath, { recursive: true, mode: 0o700 });
  try { await privateJson(fenceFile, { schemaVersion: 1, identity }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const fence = await readJson(fenceFile);
    if (!sameAuthority(fence?.identity, identity)) throw new Error("Windows resident stop fence changed authority");
  }
  const claim = await readJson(claimFile);
  if (!claim) {
    if (allowMissingClaim) return; // The durable launch record proves this is pre-spawn.
    throw new Error("Windows resident has no durable launch claim");
  }
  if (!sameAuthority(claim.identity, identity) || claim.protocol !== "trusted-supervisor-v1" || claim.platform !== "win32") {
    throw new Error("Windows resident claim changed cleanup authority");
  }
  if (claim.status === "terminated") return;
  if (claim.status === "launching") {
    // Wait for a concurrent trusted supervisor to see its fence and exit.
    // A launch owner still running is not proof of a native process launch;
    // no job member can launch before the durable spawned acknowledgement.
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await readJson(claimFile);
      if (current?.status === "spawned") return cleanupWindowsResident(identity, runtimePath, allowMissingClaim);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return;
  }
  if (claim.status !== "spawned" || claim.process?.windowsJobName !== claim.windowsJobName) {
    throw new Error("Malformed Windows resident supervisor claim");
  }
  await controlWindowsResident(claim.process, "terminate");
  const temporary = `${claimFile}.${randomUUID()}.tmp`;
  await privateJson(temporary, { ...claim, status: "terminated" });
  await fs.rename(temporary, claimFile);
}
