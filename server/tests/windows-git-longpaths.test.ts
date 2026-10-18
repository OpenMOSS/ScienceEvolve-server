import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExecFileGitCommandRunner } from "../src/collaboration-git/command-runner.js";

describe.runIf(process.platform === "win32")("Windows Git reconciliation references", () => {
  it("fetches and publishes an operation ref whose lock path exceeds MAX_PATH", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-windows-longrefs-"));
    try {
      const repository = path.join(root, "retained-project-runtime-".repeat(4));
      await fs.mkdir(repository);
      const runner = new ExecFileGitCommandRunner();
      await runner.run({ cwd: repository, args: ["init", "--bare"] });
      const tree = (await runner.run({ cwd: repository, args: ["mktree"], stdin: "" })).stdout.trim();
      const commit = (await runner.run({ cwd: repository, args: ["commit-tree", tree, "-m", "Long ref regression"],
        environment: { GIT_AUTHOR_NAME: "QA", GIT_AUTHOR_EMAIL: "qa@example.invalid",
          GIT_COMMITTER_NAME: "QA", GIT_COMMITTER_EMAIL: "qa@example.invalid" } })).stdout.trim();
      const source = "refs/heads/main";
      const target = `refs/openfars/reconciled/scoped-delivery-scoped-exec-${"a".repeat(64)}-epoch-1-${"b".repeat(40)}-merge`;
      expect(path.join(repository, `${target}.lock`).length).toBeGreaterThan(260);
      await runner.run({ cwd: repository, args: ["update-ref", source, commit] });
      await runner.run({ cwd: repository, args: ["remote", "add", "origin", repository] });
      await runner.run({ cwd: repository, args: ["fetch", "--no-tags", "--no-write-fetch-head", "origin", `${source}:${target}`] });
      expect((await runner.run({ cwd: repository, args: ["rev-parse", target] })).stdout.trim()).toBe(commit);
    } finally {
      if (!path.resolve(root).startsWith(path.join(os.tmpdir(), "openfars-windows-longrefs-"))) throw new Error("Refusing cleanup outside long-ref fixture");
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15000);
});
