import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlActionService } from "../src/orchestration-control-bridge.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(reject = false) {
  const root = await mkdtemp(join(tmpdir(), "openfars-control-stage-drain-")); roots.push(root);
  const entered = deferred(), release = deferred(), stagingPath = join(root, "staged.json");
  const revalidate = vi.fn(async () => { entered.resolve(); await release.promise; if (reject) throw new Error("Original authority ended during validation"); });
  const service = new ControlActionService({ projectId: "original-project", agent: "main", invocationId: "original-invocation",
    stateVersion: 4, capability: "controlled-capability", stagingPath, revalidate });
  const stage = (callId = "original-call") => service.stage("controlled-capability", callId,
    { tool: "route_to_agent", target: "idea", assignment: "Continue the original task", rationale: "Original Main decision" });
  return { service, entered, release, stagingPath, revalidate, stage };
}

describe("control stage lifetime at an invocation commit boundary", () => {
  it("drains an original direct stage through validation and its actual durable write", async () => {
    const f = await fixture(), stage = f.stage(); await f.entered.promise;
    let drained = false; const drain = f.service.drain().then(() => { drained = true; });
    await setImmediate(); const prematurelyDrained = drained;
    f.release.resolve(); const accepted = await stage; await drain;
    expect(prematurelyDrained).toBe(false);
    expect(JSON.parse(await readFile(f.stagingPath, "utf8"))).toEqual([accepted]);
  });

  it("seals new admission while retaining the original already validating stage until its write finishes", async () => {
    const f = await fixture(), stage = f.stage(); await f.entered.promise; f.service.seal();
    await expect(f.stage("new-after-seal")).rejects.toThrow("no longer accepts");
    let drained = false; const drain = f.service.drain().then(() => { drained = true; });
    await setImmediate(); const prematurelyDrained = drained;
    f.release.resolve(); const accepted = await stage; await drain;
    expect(prematurelyDrained).toBe(false); expect(f.revalidate).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(f.stagingPath, "utf8"))).toEqual([accepted]);
  });

  it("does not treat revocation or a rejected stage as proof that its original validation callback has settled", async () => {
    const f = await fixture(true), stage = f.stage().then(() => "unexpected", error => error.message as string);
    await f.entered.promise; f.service.revoke();
    let drained = false; const drain = f.service.drain().then(() => { drained = true; });
    await setImmediate(); const prematurelyDrained = drained;
    f.release.resolve(); expect(await stage).toBe("Original authority ended during validation"); await drain;
    expect(prematurelyDrained).toBe(false); await expect(readFile(f.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for the original serial write queue while rejecting queued calls whose admission ended", async () => {
    const f = await fixture(), first = f.stage("original-first"); await f.entered.promise;
    const queued = f.stage("queued-before-seal").then(() => "unexpected", error => error.message as string); f.service.seal();
    let drained = false; const drain = f.service.drain().then(() => { drained = true; });
    await setImmediate(); const prematurelyDrained = drained;
    f.release.resolve(); const accepted = await first; expect(await queued).toContain("no longer accepts"); await drain;
    expect(prematurelyDrained).toBe(false); expect(f.revalidate).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(f.stagingPath, "utf8"))).toEqual([accepted]);
  });
});
