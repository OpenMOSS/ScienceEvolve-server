import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SharedProjectExplainerService,
  type ProjectExplainerBaseConfig,
  type ProjectExplainerConfigChange,
  type ProjectExplainerCoreHost
} from "../src/internal/shared/project-explainer.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function setup(files: string[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "explainer-input-paths-"));
  roots.push(root);
  const config: ProjectExplainerBaseConfig = {
    schemaVersion: 2, harness: "fixture", nativeProtocol: "responses", gatewayProtocol: "responses",
    model: "fixture", reasoningEffort: "low", revision: 1, updatedAt: "2026-10-13T00:00:00Z",
    available: true, routeMode: "direct"
  };
  const run = vi.fn(async (input: { workspacePath: string }) => {
    for (const filename of files) {
      expect(await fs.readFile(path.join(input.workspacePath, "user_inputs", ...filename.split("/")), "utf8"))
        .toBe("research evidence");
    }
    return { answer: "recommendation", session: {} };
  });
  const host: ProjectExplainerCoreHost<ProjectExplainerBaseConfig, ProjectExplainerConfigChange, object, object> = {
    project: vi.fn(), getConfig: vi.fn(), proposeConfig: vi.fn(), saveConfig: vi.fn(),
    configFingerprint: vi.fn(), resolveRoute: async () => ({}), routeStatus: vi.fn(), run,
    readSession: vi.fn(), writeSession: vi.fn(), sessionPath: vi.fn()
  };
  const core = new SharedProjectExplainerService(host);
  const input = {
    scopeId: "draft", projectPath: root, runtimePath: root, config, instructions: "Recommend", evidence: {},
    files: files.map(filename => ({ path: filename, data: Buffer.from("research evidence") })),
    verifyCurrent: async () => undefined
  };
  return { root, core, input, run };
}

describe("detached Explainer input paths", () => {
  it.runIf(process.platform !== "win32")("stages native POSIX filenames for recommendation and cleans the snapshot", async () => {
    const { root, core, input, run } = await setup([
      "资料/CON:notes?.txt", "back\\slash.txt", "line\nbreak.txt", "trailing."
    ]);
    await expect(core.runDetached(input, new AbortController().signal)).resolves.toBe("recommendation");
    expect(run).toHaveBeenCalledOnce();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each([
    ["../escape.txt"], ["folder/../../escape.txt"], ["/absolute.txt"], ["folder/./notes.txt"],
    ["folder//notes.txt"], ["nul\0.txt"], ["safe.txt", "safe.txt"]
  ])("rejects unsafe or duplicate paths at the shared core boundary: %j", async (...files) => {
    const { root, core, input, run } = await setup(files);
    await expect(core.runDetached(input, new AbortController().signal))
      .rejects.toThrow("Invalid detached Explainer input file path");
    expect(run).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.runIf(process.platform === "win32").each(["C:/escape.txt", "folder\\..\\escape.txt", "\\\\server\\share\\escape.txt"])(
    "rejects Windows absolute and alternate-separator paths: %s", async (filename) => {
      const { root, core, input, run } = await setup([filename]);
      await expect(core.runDetached(input, new AbortController().signal))
        .rejects.toThrow("Invalid detached Explainer input file path");
      expect(run).not.toHaveBeenCalled();
      expect(await fs.readdir(root)).toEqual([]);
    }
  );
});
