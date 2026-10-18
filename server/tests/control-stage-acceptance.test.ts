import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlActionService } from "../src/orchestration-control-bridge.js";
import type { ControlActionEnvelope } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(onStaged: (envelope: ControlActionEnvelope) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "openfars-control-acceptance-")); roots.push(root);
  const stagingPath = join(root, "staged.json"), rejected = vi.fn();
  const service = new ControlActionService({ projectId: "original-project", agent: "main", invocationId: "original-invocation",
    stateVersion: 4, capability: "controlled-capability", stagingPath, revalidate: async () => {}, onStaged, onRejected: rejected });
  const stage = (callId = "original-call") => service.stageWithResult("controlled-capability", callId,
    { tool: "apply_workflow", path: "workflow.json", rationale: "Original accepted explanation" });
  return { stagingPath, service, rejected, stage };
}

describe("Durable live control acceptance", () => {
  it("waits for the original persistence callback before returning success or finishing drain", async () => {
    const entered = deferred(), release = deferred();
    const f = await fixture(async envelope => {
      expect(JSON.parse(await readFile(f.stagingPath, "utf8"))).toEqual([envelope]);
      entered.resolve(); await release.promise;
    });
    let accepted = false, drained = false;
    const stage = f.stage().then(value => { accepted = true; return value; });
    await entered.promise;
    const drain = f.service.drain().then(() => { drained = true; });
    await setImmediate(); const early = { accepted, drained };
    release.resolve(); const receipt = await stage; await drain;
    expect(early).toEqual({ accepted: false, drained: false });
    expect(receipt.envelope.callId).toBe("original-call"); expect(f.rejected).not.toHaveBeenCalled();
  });

  it("audits persistence rejection and retries with the exact original canonical envelope", async () => {
    let fail = true;
    const inputs: ControlActionEnvelope[] = [];
    const f = await fixture(async envelope => {
      inputs.push(structuredClone(envelope));
      if (fail) throw new Error("Original journal persistence failed");
      envelope.callId = "Mutation of disposable callback input";
    });
    await expect(f.stage()).rejects.toThrow("Original journal persistence failed");
    expect(f.rejected).toHaveBeenCalledOnce();
    expect(f.rejected.mock.calls[0][1].message).toBe("Original journal persistence failed");
    const staged = JSON.parse(await readFile(f.stagingPath, "utf8")) as ControlActionEnvelope[];
    fail = false;
    const retry = await f.stage("equivalent-retry-call"); await f.service.drain();
    expect(inputs).toEqual([staged[0], staged[0]]);
    expect(retry.envelope).toEqual(staged[0]);
    expect(JSON.parse(await readFile(f.stagingPath, "utf8"))).toEqual(staged);
  });
});
