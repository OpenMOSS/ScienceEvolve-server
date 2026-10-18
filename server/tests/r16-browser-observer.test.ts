import { expect, it } from "vitest";
import { sha256 } from "../../scripts/r-projects/catalog.mjs";
import { verifyR16BrowserObserver } from "../../scripts/r-projects/probe-r16-browser.mjs";

function fixture() {
  const entry = { payloadSha256: "a".repeat(64) }, manifest = { binding: { runId: "fixture" }, cases: [entry] };
  const observation = { scope: "local-browser-capability-only", version: "fixture-chromium", userAgent: "HeadlessChrome/fixture",
    expanded: true, pageErrors: [], drag: { before: { x: 10, y: 20 }, after: { x: 110, y: 80 } }, motion: { before: 0, after: 100 } };
  const observer = { status: "available", runId: "fixture", commit: "fixture-head", manifestSha256: sha256(manifest),
    payloadSha256: entry.payloadSha256, scope: observation.scope, command: { argv: ["fixture"], env: {} }, browserVersion: observation.version,
    browserExecutable: "executable", playwrightModule: "module", screenshot: "screenshot", observation: "observation" };
  const read: unknown[] = [];
  const input = { observer, manifest, entry, head: "fixture-head", readArtifact: async (ref: unknown, parse = true) => {
    read.push(ref); return parse ? observation : Buffer.from("fixture artifact");
  } };
  return { input, observation, read };
}

it("requires fresh manifest/commit and independently read browser artifacts rather than an available flag", async () => {
  const f = fixture(); await expect(verifyR16BrowserObserver(f.input)).resolves.toBeUndefined();
  expect(f.read).toEqual(["executable", "module", "screenshot", "observation"]);
  for (const override of [{ head: "other-head" }, { manifest: { ...f.input.manifest, binding: { runId: "other" } } },
    { observer: { status: "available", runId: "fixture" } },
    { observer: { ...f.input.observer, scope: "live-r16-passed" } },
    { readArtifact: async () => { throw new Error("Executable hash changed"); } }]) {
    await expect(verifyR16BrowserObserver({ ...f.input, ...override })).rejects.toThrow();
  }
});

it("rejects nominal rendering without observed click, pointer movement and animation", async () => {
  const f = fixture();
  for (const override of [{ expanded: false }, { userAgent: "mock renderer" }, { pageErrors: ["page failed"] },
    { drag: { before: { x: 1, y: 1 }, after: { x: 1, y: 1 } } }, { motion: { before: 5, after: 5 } }]) {
    await expect(verifyR16BrowserObserver({ ...f.input, readArtifact: async (_ref: unknown, parse = true) =>
      parse ? { ...f.observation, ...override } : Buffer.from("fixture artifact") })).rejects.toThrow();
  }
});
