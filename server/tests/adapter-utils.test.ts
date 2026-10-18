import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRunRequest } from "../src/types.js";
import type { SessionRef } from "../src/harness-runtime/contracts.js";
import { DEFAULT_RAW_LOG_LIMIT_BYTES } from "../src/harness-runtime/process-host.js";
import {
  adapterResult,
  writeAdapterLogs
} from "../src/harness-runtime/adapters/adapter-utils.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe("Adapter diagnostic logs", () => {
  it("never persists official stdout payloads that can contain hidden reasoning", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-adapter-log-"));
    roots.push(root);
    await writeAdapterLogs(
      {
        projectPath: root,
        workspacePath: root,
        inboxPath: path.join(root, "inbox.md"),
        memoryPath: path.join(root, "Memory.md"),
        runtimePath: root,
        inboxSha256: "fixture"
      },
      "fixture",
      JSON.stringify({ type: "thinking", text: "raw-hidden-reasoning" }),
      "Authorization: Bearer diagnostic-secret"
    );

    const stdout = await fs.readFile(path.join(root, "fixture-stdout.log"), "utf8");
    const stderr = await fs.readFile(path.join(root, "fixture-stderr.log"), "utf8");
    expect(stdout).toContain("canonical Harness events are authoritative");
    expect(stdout).not.toContain("raw-hidden-reasoning");
    expect(stderr).not.toContain("diagnostic-secret");
  });

  it("bounds a multibyte stderr log by UTF-8 bytes without splitting a character", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-adapter-log-utf8-"));
    roots.push(root);
    await writeAdapterLogs(
      {
        projectPath: root,
        workspacePath: root,
        inboxPath: path.join(root, "inbox.md"),
        memoryPath: path.join(root, "Memory.md"),
        runtimePath: root,
        inboxSha256: "fixture"
      },
      "fixture",
      "",
      "测".repeat(Math.ceil(DEFAULT_RAW_LOG_LIMIT_BYTES / 3) + 100)
    );

    const stderrBuffer = await fs.readFile(path.join(root, "fixture-stderr.log"));
    const stderr = stderrBuffer.toString("utf8");
    expect(stderrBuffer.byteLength).toBeLessThanOrEqual(DEFAULT_RAW_LOG_LIMIT_BYTES);
    expect(stderr).not.toContain("\uFFFD");
    expect(Buffer.byteLength(stderr, "utf8")).toBe(stderrBuffer.byteLength);
  });
});

describe("Adapter result contract", () => {
  const request = {} as AgentRunRequest;
  const session: SessionRef = {
    schemaVersion: 1,
    harnessId: "fixture",
    adapterVersion: "1",
    generation: 0,
    nativeId: "fixture-session",
    durable: true,
    createdAt: "2026-09-16T00:00:00.000Z"
  };

  it("returns a non-empty natural-language handoff", async () => {
    await expect(adapterResult(request, session, "  Fixture complete.\r\n"))
      .resolves.toEqual({
        handoff: "Fixture complete.",
        threadId: "fixture-session"
      });
  });

  it("does not treat a staged decision as a natural-language handoff", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-adapter-decision-"));
    roots.push(root);
    const stagingPath = path.join(root, "actions.json");
    await fs.writeFile(stagingPath, JSON.stringify([{
      projectId: "prj_test",
      agent: "main",
      invocationId: "inv_test",
      callId: "call_test",
      stateVersion: 1,
      receivedAt: "2026-09-16T00:00:00.000Z",
      action: {
        tool: "apply_workflow",
        path: "workflow.json",
        rationale: "The new topology is required for the next phase."
      }
    }]));
    const stagedRequest = {
      control: { stagingPath }
    } as AgentRunRequest;
    await expect(adapterResult(stagedRequest, session, " ")).rejects.toMatchObject({
      code: "HARNESS_CONTRACT_VIOLATION"
    });
  });

  it("reports an empty handoff as a stable Harness contract violation", async () => {
    await expect(adapterResult(request, session, " \n\r ")).rejects.toMatchObject({
      code: "HARNESS_CONTRACT_VIOLATION",
      source: "adapter",
      harnessId: "fixture",
      retryable: false
    });
  });
});
