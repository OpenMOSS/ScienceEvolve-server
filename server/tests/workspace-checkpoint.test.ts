import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildWorkspaceManifest, scanWorkspace } from "../src/workspace-checkpoint.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe("workspace recovery manifest", () => {
  it("indexes changed deliverables without treating input copies, runtime secrets or dependencies as outputs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-")); roots.push(root);
    await fs.writeFile(path.join(root, "input.txt"), "input evidence");
    await fs.writeFile(path.join(root, "Memory.md"), "agent memory");
    await fs.writeFile(path.join(root, ".env"), "SECRET=hidden");
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.writeFile(path.join(root, "node_modules", "dependency.js"), "dependency");
    const baseline = await scanWorkspace(root);
    await fs.writeFile(path.join(root, "submission.py"), "answer = 42\n");
    const manifest = await buildWorkspaceManifest(root, { id: "fixture", agent: "solver", invocationId: "inv_fixture", reason: "cancelled" }, baseline.files);
    expect(manifest).toMatchObject({ status: "unverified_partial_output", fileCount: 1, incomplete: false, files: [{ path: "submission.py", sha256: createHash("sha256").update("answer = 42\n").digest("hex") }] });
    expect(JSON.stringify(manifest)).not.toContain("SECRET");
    expect(JSON.stringify(manifest)).not.toContain("input.txt");
    expect((await buildWorkspaceManifest(root, { id: "again", agent: "solver", invocationId: "inv_again", reason: "completed" }, (await scanWorkspace(root)).files)).status).toBe("no_output");
  });
});
