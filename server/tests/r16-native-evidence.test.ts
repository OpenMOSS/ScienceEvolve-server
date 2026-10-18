import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { nativeFiles, validateNativeEvidence, verifyR16NativeController } from "../../scripts/r-projects/verify-r16-native.mjs";
import { sha256 } from "../../scripts/r-projects/catalog.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
function evidence(mode: "recover" | "exhaust") {
  const recover = mode === "recover", identity = { pid: 123, startTicks: "456", bootId: "fixture-only" };
  return { schemaVersion: 2, mode, firstTurnRequests: 2, requests: recover ? 3 : 2,
    piVersion: "fixture", packageRoot: "/fixture", hashes: Object.fromEntries(nativeFiles.map((name: string) => [name, "a".repeat(64)])),
    sessionPath: "/fixture/session.jsonl", sessionSha256: "b".repeat(64),
    wire: [{ at: 1000, frame: { type: "agent_end" } },
      { at: 1100, frame: { type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 2000 } },
      { at: 3100, frame: { type: "auto_retry_end", success: recover } }],
    backoff: { at: 2100, activity: { invocationId: "inv-1" }, process: { alive: true, identity },
      releases: [], concurrentTurnRejected: true, pauseRejected: true },
    releases: [{ at: 3150, outcome: recover ? "completed" : "failed", alive: recover },
      ...(recover ? [{ at: 3200, outcome: "completed", alive: true }] : [])],
    stopped: true, stopProof: { at: 3300, process: { alive: false, identity } },
    ...(recover ? { outcome: { value: { handoff: "native-retry-final" } }, adjacentTurn: { handoff: "native-next-turn" } }
      : { outcome: { error: "Pi automatic retry failed" } }) };
}

it.each(["recover", "exhaust"] as const)("rejects missing/early release, live stop and cross-process evidence: %s", (mode) => {
  const valid = evidence(mode); expect(() => validateNativeEvidence(valid, mode)).not.toThrow();
  for (const override of [{ schemaVersion: 1 }, { wire: [] }, { firstTurnRequests: 3 },
    { backoff: { ...valid.backoff, at: 3101 } }, { backoff: { ...valid.backoff, releases: [valid.releases[0]] } },
    { backoff: { ...valid.backoff, concurrentTurnRejected: false } },
    { releases: [{ ...valid.releases[0], at: 1099 }] },
    { stopProof: { ...valid.stopProof, process: { ...valid.stopProof.process, alive: true } } },
    { stopProof: { ...valid.stopProof, process: { ...valid.stopProof.process, identity: { pid: 123, startTicks: "other" } } } }]) {
    expect(() => validateNativeEvidence({ ...valid, ...override }, mode)).toThrow();
  }
  if (mode === "recover") expect(() => validateNativeEvidence({ ...valid, adjacentTurn: undefined }, mode)).toThrow();
  else expect(() => validateNativeEvidence({ ...valid, releases: [{ ...valid.releases[0], alive: true }] }, mode)).toThrow();
});

it("binds both raw observations to current manifest/payload/commit and actual Pi package bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "r16-native-proof-")); roots.push(root);
  const hashes: Record<string, string> = {};
  for (const name of nativeFiles) {
    const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, name); hashes[name] = createHash("sha256").update(name).digest("hex");
  }
  const entry = { payloadSha256: "c".repeat(64) }, manifest = { binding: { runId: "fixture" }, cases: [entry] };
  const controller = { commit: "fixture-head", manifestSha256: sha256(manifest), payloadSha256: entry.payloadSha256,
    nativeHarness: { id: "pi", packageRoot: root, version: "fixture", hashes }, nativeEvidence: { recover: "recover", exhaust: "exhaust" } };
  const readArtifact = async (mode: "recover" | "exhaust") => ({ ...evidence(mode), packageRoot: root, hashes });
  const input = { controller, manifest, entry, head: "fixture-head", packageRoot: root, readArtifact };
  await expect(verifyR16NativeController(input)).resolves.toBeUndefined();
  for (const override of [{ head: "new-head" }, { manifest: { ...manifest, binding: { runId: "other" } } },
    { entry: { payloadSha256: "d".repeat(64) } },
    { readArtifact: async (mode: "recover" | "exhaust") => ({ ...await readArtifact(mode), piVersion: "other" }) }]) {
    await expect(verifyR16NativeController({ ...input, ...override })).rejects.toThrow();
  }
  await fs.writeFile(path.join(root, "dist/cli.js"), "new installed Pi");
  await expect(verifyR16NativeController(input)).rejects.toThrow(/native package changed/);
});
