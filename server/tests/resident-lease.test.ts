import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunResult } from "../src/types.js";
import {
  ResidentLeaseManager,
  linuxProcPath,
  linuxProcessStopped,
  readLinuxProcessIdentity,
  type ResidentHarnessDriver,
  type ResidentProcessIdentity,
  type ResidentTurn
} from "../src/harness-runtime/resident-lease.js";
import type { SessionRef } from "../src/harness-runtime/contracts.js";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {
    recursive: true,
    force: true
  })));
});

class LineFixtureDriver implements ResidentHarnessDriver {
  readonly identity: ResidentProcessIdentity;
  readonly session: SessionRef;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #responses: Array<(value: string) => void> = [];

  private constructor(
    child: ChildProcessWithoutNullStreams,
    identity: ResidentProcessIdentity,
    session: SessionRef
  ) {
    this.#child = child;
    this.identity = identity;
    this.session = session;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#responses.shift()?.(line));
  }

  static async open(sessionId: string): Promise<LineFixtureDriver> {
    const child = spawn(process.execPath, ["-e", [
      "const r=require('node:readline').createInterface({input:process.stdin});",
      "r.on('line',line=>{const v=JSON.parse(line);",
      "if(v.close){process.exit(0)};",
      "process.stdout.write(JSON.stringify({pid:process.pid,prompt:v.prompt})+'\\n')});"
    ].join("")], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    children.push(child);
    const identity = await waitForIdentity(child.pid!);
    return new LineFixtureDriver(child, identity, {
      schemaVersion: 1,
      harnessId: "fixture",
      adapterVersion: "resident-test",
      generation: 0,
      nativeId: sessionId,
      durable: true,
      createdAt: "2026-09-22T00:00:00.000Z"
    });
  }

  async submit(turn: ResidentTurn): Promise<AgentRunResult> {
    const response = new Promise<string>((resolve) => this.#responses.push(resolve));
    this.#child.stdin.write(`${JSON.stringify({ prompt: turn.prompt })}\n`);
    const value = JSON.parse(await response) as { pid: number; prompt: string };
    return { handoff: `${value.pid}:${value.prompt}`, threadId: this.session.nativeId };
  }

  async probe() {
    try {
      const identity = await readLinuxProcessIdentity(this.identity.pid);
      const status = await fs.readFile(`${await linuxProcPath(this.identity.pid)}/status`, "utf8");
      return { alive: true, stopped: linuxProcessStopped(status), identity };
    } catch {
      return { alive: false, stopped: false, identity: this.identity };
    }
  }

  async pause(): Promise<void> {
    process.kill(this.identity.pid, "SIGSTOP");
    await waitForStopped(this.identity.pid, true);
  }

  async resume(): Promise<void> {
    process.kill(this.identity.pid, "SIGCONT");
    await waitForStopped(this.identity.pid, false);
  }

  async close(): Promise<void> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    this.#child.stdin.write(`${JSON.stringify({ close: true })}\n`);
    await new Promise<void>((resolve) => this.#child.once("close", () => resolve()));
  }

  forceClose(): void {
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      process.kill(-this.identity.processGroupId!, "SIGKILL");
    }
  }

  kill(): void {
    process.kill(-this.identity.processGroupId!, "SIGKILL");
  }
}

describe.runIf(process.platform === "linux")("ResidentLeaseManager", () => {
  it("retains a durable never-input proof through pause, resume and normal stop", async () => {
    const runtimePath = await temporaryRuntime();
    const driver = await LineFixtureDriver.open("reserved-empty-session");
    const manager = new ResidentLeaseManager();
    await manager.open({ ...authority(0), runtimePath, workspacePath: runtimePath, driver });
    const marker = async () => JSON.parse(await fs.readFile(path.join(runtimePath, "resident-process.json"), "utf8"));
    expect(await marker()).toMatchObject({ inputStarted: false, workspacePath: runtimePath });
    await manager.pause(authority(1));
    await manager.resume(authority(2));
    await manager.close(authority(3));
    expect(await marker()).toMatchObject({ inputStarted: false, state: "stopped", controlSeq: 3 });
    const recovered = await new ResidentLeaseManager().reconcileStartup({ ...authority(0), runtimePath, nextOwnershipEpoch: 5 });
    expect(recovered.previous).toMatchObject({ inputStarted: false, workspacePath: runtimePath });
  });

  it("persists inputStarted before native input and retains it after failed input and recovery", async () => {
    const runtimePath = await temporaryRuntime();
    const driver = await LineFixtureDriver.open("started-session");
    const manager = new ResidentLeaseManager();
    await manager.open({ ...authority(0), runtimePath, workspacePath: runtimePath, driver });
    driver.submit = async () => {
      expect(JSON.parse(await fs.readFile(path.join(runtimePath, "resident-process.json"), "utf8")))
        .toMatchObject({ inputStarted: true, state: "busy" });
      throw new Error("native input rejected");
    };
    await expect(manager.submit(authority(1), turn("first", "original input"))).rejects.toThrow("native input rejected");
    await manager.close(authority(2));
    const recovered = await new ResidentLeaseManager().reconcileStartup({ ...authority(0), runtimePath, nextOwnershipEpoch: 5 });
    expect(recovered.previous).toMatchObject({ inputStarted: true });
  });

  it("never treats a resumed historical Session as empty just because its new process has no inputs", async () => {
    const runtimePath = await temporaryRuntime();
    const driver = await LineFixtureDriver.open("historical-session");
    driver.session.resumedAt = "2026-10-12T00:00:00.000Z";
    const manager = new ResidentLeaseManager();
    const lease = await manager.open({ ...authority(0), runtimePath, workspacePath: runtimePath, driver });
    expect(lease.inputStarted).toBe(true);
    await manager.close(authority(1));
    const recovered = await new ResidentLeaseManager().reconcileStartup({ ...authority(0), runtimePath, nextOwnershipEpoch: 5 });
    expect(recovered.previous).toMatchObject({ inputStarted: true });
  });

  it.each([false, true])("supplement reopens the stopped original epoch with fresh physical authority (restart=%s)", async (restart) => {
    const previousRuntimePath = await temporaryRuntime();
    const runtimePath = path.join(path.dirname(previousRuntimePath), "supplement-one");
    let manager = new ResidentLeaseManager();
    const old = await LineFixtureDriver.open("same-task-session");
    await manager.open({ ...authority(1), runtimePath: previousRuntimePath, driver: old });
    await manager.close(authority(1));
    if (restart) {
      manager = new ResidentLeaseManager();
      await manager.reconcileStartup({ ...authority(1), runtimePath: previousRuntimePath, nextOwnershipEpoch: 5 });
    }
    let checks = 0;
    const driver = await LineFixtureDriver.open("same-task-session");
    const sameEpochReopen = { previousRuntimePath, revalidate: () => { checks += 1; } };
    await expect(manager.open({ ...authority(1), runtimePath, driver })).rejects.toThrow(/obsolete ownership epoch/);
    const lease = await manager.open({ ...authority(1), runtimePath, driver, sameEpochReopen });
    expect(lease.ownershipEpoch).toBe(4);
    expect(lease.session).toEqual(old.session);
    expect(lease.pid).not.toBe(old.identity.pid);
    expect(lease.physicalLeaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(checks).toBe(2);
    const current = (seq: number) => ({ ...authority(seq), physicalLeaseId: lease.physicalLeaseId });
    for (const stale of [authority(100), { ...authority(100), physicalLeaseId: "11111111-1111-4111-8111-111111111111" }]) {
      await expect(manager.submit(stale, turn("stale", "never reach the new process"))).rejects.toThrow(/physical lease identity/);
      await expect(manager.close(stale)).rejects.toThrow(/physical lease identity/);
    }
    expect((await driver.probe()).alive).toBe(true);
    await expect(manager.submit(current(1), turn("supplement", "finish my retained tools"))).resolves.toMatchObject({
      lease: { ownershipEpoch: 4, physicalLeaseId: lease.physicalLeaseId }, result: { handoff: expect.stringContaining("retained tools") }
    });
    await manager.close(current(2));
    const marker = JSON.parse(await fs.readFile(path.join(runtimePath, "resident-process.json"), "utf8"));
    expect(marker.physicalLeaseId).toBe(lease.physicalLeaseId);
    const nextDriver = await LineFixtureDriver.open("same-task-session");
    const next = await manager.open({ ...authority(1), runtimePath: path.join(path.dirname(runtimePath), "supplement-two"),
      driver: nextDriver, sameEpochReopen: { previousRuntimePath: runtimePath, revalidate: () => undefined } });
    expect(next.physicalLeaseId).not.toBe(lease.physicalLeaseId);
    await expect(manager.pause(current(100))).rejects.toThrow(/physical lease identity/);
    await manager.close({ ...authority(1), physicalLeaseId: next.physicalLeaseId });
  });

  it.each(["live", "lower-epoch", "same-runtime", "other-parent", "role", "session", "revoked"] as const)(
    "supplement rejects %s without installing a replacement lease", async (invalid) => {
      const previousRuntimePath = await temporaryRuntime();
      const manager = new ResidentLeaseManager();
      const old = await LineFixtureDriver.open("supplement-fenced-session");
      await manager.open({ ...authority(1), runtimePath: previousRuntimePath, driver: old });
      if (invalid !== "live") await manager.close(authority(1));
      const driver = await LineFixtureDriver.open(invalid === "session" ? "other-session" : old.session.nativeId);
      let checks = 0;
      await expect(manager.open({ ...authority(1), ownershipEpoch: invalid === "lower-epoch" ? 3 : 4,
        role: invalid === "role" ? "leader" : "delivery",
        runtimePath: invalid === "same-runtime" ? previousRuntimePath : path.join(path.dirname(previousRuntimePath), "supplement"), driver,
        sameEpochReopen: { previousRuntimePath: invalid === "other-parent" ? path.join(previousRuntimePath, "other") : previousRuntimePath,
          revalidate: () => { checks += 1; if (invalid === "revoked" && checks === 2) throw new Error("S repair authority revoked during native probe"); } }
      })).rejects.toThrow();
      expect(manager.snapshot("exec-one", "fixture")?.pid).toBe(old.identity.pid);
      await driver.close();
      if (invalid === "live") await manager.close(authority(1));
    });

  it("supplement excludes overlapping open and startup reconciliation during grant I/O", async () => {
    const previousRuntimePath = await temporaryRuntime();
    const runtimePath = path.join(path.dirname(previousRuntimePath), "supplement");
    const manager = new ResidentLeaseManager();
    const old = await LineFixtureDriver.open("serialized-supplement");
    await manager.open({ ...authority(1), runtimePath: previousRuntimePath, driver: old });
    await manager.close(authority(1));
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>((r) => { enter = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const driver = await LineFixtureDriver.open(old.session.nativeId);
    const request = { ...authority(1), runtimePath, driver,
      sameEpochReopen: { previousRuntimePath, revalidate: async () => { enter(); await gate; } } };
    const pending = manager.open(request);
    await Promise.race([entered, pending.then(() => undefined)]);
    await expect(manager.open(request)).rejects.toThrow(/open already owns/);
    await expect(manager.reconcileStartup({ ...authority(1), runtimePath: previousRuntimePath, nextOwnershipEpoch: 5 }))
      .rejects.toThrow(/cannot overlap/);
    release();
    const lease = await pending;
    await manager.close({ ...authority(1), physicalLeaseId: lease.physicalLeaseId });
  });

  it("keeps one native PID across two turns, waits without polling, and acknowledges STOP/CONT", async () => {
    const runtimePath = await temporaryRuntime();
    const driver = await LineFixtureDriver.open("session-one");
    const manager = new ResidentLeaseManager();
    const opened = await manager.open({
      executionId: "exec-one",
      harnessId: "fixture",
      ownershipEpoch: 4,
      runtimePath,
      driver
    });
    expect(opened.state).toBe("waiting");
    const first = await manager.submit(authority(1), turn("input-1", "turn one"));
    expect(first.lease.pid).toBe(opened.pid);
    expect(first.lease.startTicks).toBe(opened.startTicks);
    expect(first.lease.state).toBe("waiting");
    expect(first.result.handoff).toContain("turn one");

    const waited = await manager.wait(authority(2));
    expect(waited.state).toBe("waiting");
    const paused = await manager.pause(authority(3));
    expect(paused.state).toBe("paused");
    expect((await driver.probe()).stopped).toBe(true);
    const resumed = await manager.resume(authority(4));
    expect(resumed.state).toBe("waiting");
    const second = await manager.submit(authority(5), turn("input-2", "turn two"));
    expect(second.lease.pid).toBe(opened.pid);
    expect(second.lease.startTicks).toBe(opened.startTicks);
    expect(second.lease.state).toBe("waiting");

    const marker = JSON.parse(await fs.readFile(
      path.join(runtimePath, "resident-process.json"), "utf8"
    )) as Record<string, unknown>;
    expect(marker).toMatchObject({
      executionId: "exec-one",
      ownershipEpoch: 4,
      state: "waiting",
      controlSeq: 5,
      acknowledgedControlSeq: 5,
      pid: opened.pid,
      startTicks: opened.startTicks
    });
    await manager.close(authority(6));
  }, 15_000);

  it("detects a crash, fences the old epoch, and accepts one new-epoch recovery process", async () => {
    const runtimePath = await temporaryRuntime();
    const manager = new ResidentLeaseManager();
    const oldDriver = await LineFixtureDriver.open("durable-session");
    await manager.open({
      executionId: "exec-one", harnessId: "fixture", ownershipEpoch: 4,
      runtimePath, driver: oldDriver
    });
    await manager.submit(authority(1), turn("input-1", "committed turn"));
    oldDriver.kill();
    await waitForDead(oldDriver.identity.pid);
    await expect(manager.probe(authority(2))).resolves.toMatchObject({ state: "crashed" });

    const recovered = await LineFixtureDriver.open("durable-session");
    const lease = await manager.open({
      executionId: "exec-one", harnessId: "fixture", ownershipEpoch: 5,
      runtimePath, driver: recovered
    });
    expect(lease.pid).not.toBe(oldDriver.identity.pid);
    expect(lease.ownershipEpoch).toBe(5);
    await expect(manager.submit(authority(3), turn("stale", "old"))).rejects.toThrow(
      /obsolete ownership epoch/
    );
    const turnThree = await manager.submit(
      { ...authority(1), ownershipEpoch: 5 },
      {
        ...turn("input-3", "rehydrated turn three"),
        durableRehydrate: {
          sourceDigest: createHash("sha256").update("committed turn").digest("hex"),
          lastBusinessTurn: 1,
          lastInputId: "input-1",
          transcript: "committed turn"
        }
      }
    );
    expect(turnThree.result.handoff).toContain("rehydrated turn three");
    await manager.close({ ...authority(2), ownershipEpoch: 5 });
  });

  it("resumes a paused process before protocol shutdown and leaves no live lease", async () => {
    const runtimePath = await temporaryRuntime();
    const driver = await LineFixtureDriver.open("paused-close-session");
    const manager = new ResidentLeaseManager();
    await manager.open({
      executionId: "exec-one", harnessId: "fixture", ownershipEpoch: 4,
      runtimePath, driver
    });
    await expect(manager.pause(authority(1))).resolves.toMatchObject({ state: "paused" });
    expect((await driver.probe()).stopped).toBe(true);
    await expect(manager.close(authority(2))).resolves.toMatchObject({ state: "stopped" });
    expect((await driver.probe()).alive).toBe(false);
  });

  it("preserves stopped proof when startup reconciliation fences a completed close", async () => {
    const runtimePath = await temporaryRuntime();
    const driver = await LineFixtureDriver.open("closed-before-terminal-session");
    const beforeRestart = new ResidentLeaseManager();
    await beforeRestart.open({
      executionId: "exec-one", harnessId: "fixture", ownershipEpoch: 4,
      runtimePath, driver
    });
    const stopped = await beforeRestart.close(authority(1));
    expect(stopped).toMatchObject({
      executionId: "exec-one",
      harnessId: "fixture",
      ownershipEpoch: 4,
      state: "stopped",
      acknowledgedControlSeq: 1
    });
    const markerPath = path.join(runtimePath, "resident-process.json");
    const stoppedMarker = JSON.parse(await fs.readFile(markerPath, "utf8")) as Record<string, unknown>;
    expect(stoppedMarker).toEqual(stopped);

    // Simulate a service crash after native close persisted its proof but
    // before S committed the execution terminal, then reconcile at a new epoch.
    const restarted = new ResidentLeaseManager();
    const reconciled = await restarted.reconcileStartup({
      executionId: "exec-one", harnessId: "fixture", runtimePath,
      nextOwnershipEpoch: 5
    });

    expect(reconciled).toEqual({ outcome: "dead", previous: stopped });
    const fence = JSON.parse(await fs.readFile(markerPath, "utf8")) as Record<string, unknown>;
    expect(fence).toMatchObject({
      executionId: "exec-one",
      harnessId: "fixture",
      ownershipEpoch: 4,
      state: "crashed",
      pid: stopped.pid,
      startTicks: stopped.startTicks
    });
  });

  it("accepts a failed resume acknowledgement only after actual owned close succeeds", async () => {
    const runtimePath = await temporaryRuntime();
    const driver = await LineFixtureDriver.open("resume-ack-lost-before-close");
    const manager = new ResidentLeaseManager();
    await manager.open({ executionId: "exec-one", harnessId: "fixture", ownershipEpoch: 4, runtimePath, driver });
    await manager.pause(authority(1));
    const resume = driver.resume.bind(driver);
    driver.resume = async () => { await resume(); throw new Error("fixture resume acknowledgement lost"); };
    await expect(manager.close(authority(2))).resolves.toMatchObject({ state: "stopped", inputStarted: false });
    expect((await driver.probe()).alive).toBe(false);
  });

  it("retains a failed close even after containment stopped the original process", async () => {
    const runtimePath = await temporaryRuntime();
    const driver = await LineFixtureDriver.open("failed-close-after-pause");
    const manager = new ResidentLeaseManager();
    await manager.open({ executionId: "exec-one", harnessId: "fixture", ownershipEpoch: 4, runtimePath, driver });
    await manager.pause(authority(1));
    const close = driver.close.bind(driver);
    driver.close = async () => { await close(); throw new Error("fixture protocol close failed"); };
    await expect(manager.close(authority(2))).rejects.toThrow("fixture protocol close failed");
    expect(manager.snapshot("exec-one", "fixture")).toMatchObject({ state: "crashed", inputStarted: false });
    expect((await driver.probe()).alive).toBe(false);
    driver.close = close;
    await expect(manager.close(authority(3))).resolves.toMatchObject({ state: "stopped" });
  });

  it("does not turn a failed final stop probe into successful stopped proof", async () => {
    const runtimePath = await temporaryRuntime();
    const driver = await LineFixtureDriver.open("unknown-final-stop-probe");
    const manager = new ResidentLeaseManager();
    await manager.open({ executionId: "exec-one", harnessId: "fixture", ownershipEpoch: 4, runtimePath, driver });
    const probe = driver.probe.bind(driver);
    driver.probe = async () => { throw new Error("fixture stop observation unavailable"); };
    await expect(manager.close(authority(1))).rejects.toThrow("fixture stop observation unavailable");
    expect(manager.snapshot("exec-one", "fixture")).toMatchObject({ state: "crashed", acknowledgedControlSeq: 0 });
    driver.probe = probe;
    await expect(manager.close(authority(2))).resolves.toMatchObject({ state: "stopped" });
  });

  it("fails closed when close leaves an unauthorized live child", async () => {
    const runtimePath = await temporaryRuntime();
    const driver = await LineFixtureDriver.open("leak-session");
    const manager = new ResidentLeaseManager();
    await manager.open({
      executionId: "exec-one", harnessId: "fixture", ownershipEpoch: 4,
      runtimePath, driver
    });
    const leaky = driver as ResidentHarnessDriver & { close(): Promise<void>; forceClose(): void };
    leaky.close = async () => undefined;
    leaky.forceClose = () => undefined;
    await expect(manager.close(authority(1))).rejects.toThrow(/remained alive/);
    expect(manager.snapshot("exec-one", "fixture")?.state).toBe("crashed");
  });

  it("serializes leader and delivery ownership of one native session", async () => {
    const leaderRuntime = await temporaryRuntime();
    const deliveryRuntime = await temporaryRuntime();
    const manager = new ResidentLeaseManager();
    const leader = await LineFixtureDriver.open("shared-role-session");
    const delivery = await LineFixtureDriver.open("shared-role-session");
    await manager.open({
      executionId: "management:node:group", harnessId: "fixture",
      ownershipEpoch: 9, role: "leader", runtimePath: leaderRuntime, driver: leader
    });
    await expect(manager.open({
      executionId: "exec-two", harnessId: "fixture", ownershipEpoch: 1,
      role: "delivery", runtimePath: deliveryRuntime, driver: delivery
    })).rejects.toThrow(/already owned by another collaboration role/);
    await manager.close({
      executionId: "management:node:group", harnessId: "fixture",
      ownershipEpoch: 9, controlSeq: 1
    });
    await expect(manager.open({
      executionId: "exec-two", harnessId: "fixture", ownershipEpoch: 1,
      role: "delivery", runtimePath: deliveryRuntime, driver: delivery
    })).resolves.toMatchObject({ role: "delivery", state: "waiting" });
    await manager.close({
      executionId: "exec-two", harnessId: "fixture", ownershipEpoch: 1, controlSeq: 1
    });
  });

  it("reconciles a live startup orphan, kills only its full PID identity, and fences its epoch", async () => {
    const runtimePath = await temporaryRuntime();
    const beforeRestart = new ResidentLeaseManager();
    const orphan = await LineFixtureDriver.open("restart-session");
    await beforeRestart.open({
      executionId: "exec-one", harnessId: "fixture", ownershipEpoch: 4,
      runtimePath, driver: orphan
    });

    const restarted = new ResidentLeaseManager();
    await expect(restarted.reconcileStartup({
      executionId: "exec-one", harnessId: "fixture", runtimePath,
      nextOwnershipEpoch: 5
    })).resolves.toMatchObject({
      outcome: "terminated",
      previous: { pid: orphan.identity.pid, ownershipEpoch: 4, state: "crashed" }
    });
    await waitForDead(orphan.identity.pid);
    const staleDriver = await LineFixtureDriver.open("restart-session");
    await expect(restarted.open({
      executionId: "exec-one", harnessId: "fixture", ownershipEpoch: 4,
      runtimePath, driver: staleDriver
    })).rejects.toThrow(/obsolete ownership epoch/);
    await staleDriver.close();
    await expect(restarted.wait(authority(1))).rejects.toThrow(/No resident Harness lease/);
  });

  it("does not signal a PID whose marker boot identity no longer matches", async () => {
    const runtimePath = await temporaryRuntime();
    const original = new ResidentLeaseManager();
    const driver = await LineFixtureDriver.open("reused-pid-session");
    await original.open({
      executionId: "exec-one", harnessId: "fixture", ownershipEpoch: 4,
      runtimePath, driver
    });
    const markerPath = path.join(runtimePath, "resident-process.json");
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(markerPath, `${JSON.stringify({ ...marker, bootId: "different-boot" })}\n`);
    const restarted = new ResidentLeaseManager();
    await expect(restarted.reconcileStartup({
      executionId: "exec-one", harnessId: "fixture", runtimePath,
      nextOwnershipEpoch: 5
    })).resolves.toMatchObject({ outcome: "identity-mismatch" });
    expect((await driver.probe()).alive).toBe(true);
    await driver.close();
  });

  it("reconciles an already-dead startup marker without signaling another process", async () => {
    const runtimePath = await temporaryRuntime();
    const original = new ResidentLeaseManager();
    const driver = await LineFixtureDriver.open("dead-marker-session");
    await original.open({
      executionId: "exec-one", harnessId: "fixture", ownershipEpoch: 4,
      runtimePath, driver
    });
    driver.kill();
    await waitForDead(driver.identity.pid);
    const restarted = new ResidentLeaseManager();
    await expect(restarted.reconcileStartup({
      executionId: "exec-one", harnessId: "fixture", runtimePath,
      nextOwnershipEpoch: 5
    })).resolves.toMatchObject({ outcome: "dead" });
  });
});

function authority(controlSeq: number) {
  return {
    executionId: "exec-one",
    harnessId: "fixture",
    ownershipEpoch: 4,
    controlSeq
  };
}

function turn(inputId: string, prompt: string): ResidentTurn {
  return {
    inputId,
    invocationId: `inv-${inputId}`,
    prompt,
    route: { baseUrl: "http://127.0.0.1:1/v1", token: `token-${inputId}` },
    controlCapability: `capability-${inputId}`
  };
}

async function temporaryRuntime(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-resident-test-"));
  roots.push(root);
  const runtime = path.join(root, "runtime");
  await fs.mkdir(runtime);
  return runtime;
}

async function waitForIdentity(pid: number): Promise<ResidentProcessIdentity> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { return await readLinuxProcessIdentity(pid); } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("fixture process did not start");
}

async function waitForStopped(pid: number, expected: boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const status = await fs.readFile(`${await linuxProcPath(pid)}/status`, "utf8");
      if (linuxProcessStopped(status) === expected) return;
    } catch { /* retry */ }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("fixture process did not reach expected stop state");
}

async function waitForDead(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { await linuxProcPath(pid); } catch { return; }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("fixture process did not exit");
}
