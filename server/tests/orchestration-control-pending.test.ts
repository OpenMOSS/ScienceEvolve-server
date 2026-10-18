import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlActionService, startControlActionBridge } from "../src/orchestration-control-bridge.js";
import type { ControlAction } from "../src/types.js";
import { CONTROL_OPERATION_TIMEOUT_MS } from "../src/control-request-lifetime.js";
import { GitHubProviderError, GitHubUncertainResultError, GitOperationResultAvailableError } from "../src/collaboration-git/errors.js";
import { controlResultDisplayText, controlResultText, type ControlResultInput } from "../src/control-result-receipts.js";

const roots: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
const source = fileURLToPath(new URL("../src/orchestration-control-mcp.ts", import.meta.url));
const loader = createRequire(import.meta.url).resolve("tsx");
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-control-pending-")); roots.push(root);
  return { root, projectId: "prj_pending", agent: "worker", invocationId: "inv_pending", stateVersion: 7,
    stagingPath: path.join(root, "actions.json"), workspacePath: root, kind: "worker", candidates: [], decisionBy: "agent",
    canComplete: false, allowUserIntervention: false, allowAgentGitActions: true, requireBridge: true };
}
async function callMcp(settings: Awaited<ReturnType<typeof fixture>>, endpoint: { path?: string; host?: string; port?: number },
  name = "github_get_pr", args: Record<string, unknown> = { providerNumber: 71 }) {
  const child = spawn(process.execPath, ["--import", loader, source], { cwd: settings.root,
    env: { ...process.env, SCIENCEEVOLVE_CONTROL_CAPABILITY: "fixture-capability", SCIENCEEVOLVE_CONTROL_CONTEXT: JSON.stringify({
      ...settings, bridgePath: endpoint.path, bridgeHost: endpoint.host, bridgePort: endpoint.port
    }) }, stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; let error = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
  const completed = new Promise<Record<string, any>>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) reject(new Error("Fixture MCP process failed: " + error));
      else { try { resolve(JSON.parse(output.trim())); } catch { reject(new Error("Fixture MCP has no valid response")); } }
    });
  });
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await completed.catch(() => undefined); } });
  child.stdin.end(JSON.stringify({ id: 1, method: "tools/call", params: { name, arguments: { callId: "exact-call", ...args } } }) + "\n");
  return completed;
}
async function fakePeer(settings: Awaited<ReturnType<typeof fixture>>, receive: (socket: net.Socket, request: Record<string, any>) => void) {
  const socketPath = path.join(settings.root, "fake.sock"); const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("error", () => socket.destroy()); socket.on("close", () => sockets.delete(socket));
    let input = ""; socket.setEncoding("utf8"); socket.on("data", chunk => {
      input += chunk; if (!input.includes("\n")) return;
      const line = input.slice(0, input.indexOf("\n")); input = ""; receive(socket, JSON.parse(line));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { path: socketPath };
}

describe("exact pending control request transport", () => {
  it("sends the retained result identity in the actual MCP text after saving the exact return", async () => {
    const f = await fixture(); const id = "a".repeat(64);
    let retained: Parameters<typeof controlResultText> | undefined;
    const service = new ControlActionService({ ...f, capability: "fixture-capability", revalidate: async () => {},
      execute: async () => ({ providerNumber: 71, status: "merged" }),
      onResult: input => { expect(input.requestedCallId).toBe("exact-call"); retained = [input.envelope, input.result, id]; return id; } });
    const bridge = await startControlActionBridge(service, f.root); cleanup.push(() => bridge.close());
    const response = await callMcp(f, bridge.endpoint);
    expect(retained).toBeDefined();
    expect(response.result.content[0].text).toBe(controlResultDisplayText(...retained!));
    expect(response.result.content[0].text).toContain(controlResultText(...retained!) + "\n");
    expect(response.result.content[0].text).toMatch(/^Git result: merged\./);
    expect(response.result.structuredContent).toEqual({ actionAccepted: true,
      git: { tool: "github_get_pr", outcome: "merged", completesTask: false },
      result: { providerNumber: 71, status: "merged" } });
    expect(response.result.content[0].text).toContain('[OpenFARS result ' + id + ']');
  });

  it("retries failed result persistence from the cached return without repeating the provider", async () => {
    const f = await fixture(); const execute = vi.fn(async () => ({ providerNumber: 71, status: "merged" }));
    let persist = false;
    const onResult = vi.fn(() => { if (!persist) throw new Error("receipt persistence interrupted"); return "b".repeat(64); });
    const service = new ControlActionService({ ...f, capability: "fixture-capability", revalidate: async () => {}, execute, onResult });
    const action = { tool: "github_merge_pr" as const, providerNumber: 71 };
    await expect(service.stageWithResult("fixture-capability", "exact-call", action)).rejects.toThrow("persistence interrupted");
    persist = true;
    await expect(service.stageWithResult("fixture-capability", "exact-call", action)).resolves.toMatchObject({ receiptId: "b".repeat(64), result: { status: "merged" } });
    expect(execute).toHaveBeenCalledOnce(); expect(onResult).toHaveBeenCalledTimes(2);
  });

  it("retains a late successful result after revocation without reporting it as delivered", async () => {
    const f = await fixture(); let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const onResult = vi.fn((_input: ControlResultInput) => "c".repeat(64));
    const service = new ControlActionService({ ...f, capability: "fixture-capability", revalidate: async () => {}, onResult,
      execute: async () => { entered(); await blocked; return { status: "merged" }; } });
    const result = service.stageWithResult("fixture-capability", "exact-call", { tool: "github_merge_pr", providerNumber: 71 });
    const rejected = expect(result).rejects.toThrow("revoked");
    await started; service.revoke(); release(); await rejected; await service.drain();
    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult.mock.calls[0]![0]).toMatchObject({ requestedCallId: "exact-call", result: { status: "merged" } });
  });

  it("keeps the exact uncertain operation identity and provider error code in the Agent's actual MCP error", async () => {
    const f = await fixture(); const operationId = "agent-git-original-epoch-7-exact-call-pr";
    const execute = vi.fn(async () => { throw new GitHubUncertainResultError(operationId); });
    const service = new ControlActionService({ ...f, capability: "fixture-capability", revalidate: async () => {}, execute });
    const bridge = await startControlActionBridge(service, f.root); cleanup.push(() => bridge.close());
    const response = await callMcp(f, bridge.endpoint, "github_create_pr", { base: "groups/direct", title: "Original PR", body: "Original task delivery" });
    expect(execute).toHaveBeenCalledOnce();
    expect(response.result.isError).toBe(true);
    expect(response.result.structuredContent.error).toMatchObject({ code: "GITHUB_RESULT_UNCERTAIN",
      operationId, reconcileRequired: true, retryable: true });
    expect(response.result.content[0].text).toContain(operationId);
  });

  it.each(["completed", "remote_success_local_pending"] as const)("transports known %s without changing it into a provider failure", async status => {
    const f = await fixture(); const operationId = "original-merge-operation";
    const localStage = status === "completed" ? "synchronized" : "synchronization_pending";
    const execute = vi.fn(async () => { throw new GitOperationResultAvailableError(operationId, status, localStage); });
    const service = new ControlActionService({ ...f, capability: "fixture-capability", revalidate: async () => {}, execute });
    const bridge = await startControlActionBridge(service, f.root); cleanup.push(() => bridge.close());
    const response = await callMcp(f, bridge.endpoint, "github_merge_pr", { providerNumber: 71 });
    expect(execute).toHaveBeenCalledOnce();
    expect(response.result.isError).toBe(true);
    expect(response.result.structuredContent.error).toMatchObject({ code: "GIT_OPERATION_RESULT_AVAILABLE",
      operationId, status, localStage, reconcileRequired: status !== "completed", retryable: status !== "completed" });
    expect(response.result.content[0].text).toContain(status);
  });

  it("returns the original operation's partial success through the callable synchronous query", async () => {
    const f = await fixture(); const operationId = "original-merge-operation";
    const execute = vi.fn(async envelope => {
      expect(envelope.action).toEqual({ tool: "git_get_operation", operationId });
      return { operation: { id: operationId, status: "finalized", remoteFact: { providerNumber: 71, status: "merged" } },
        status: "remote_success_local_pending", localStage: "synchronization_pending" };
    });
    const service = new ControlActionService({ ...f, capability: "fixture-capability", revalidate: async () => {}, execute });
    const bridge = await startControlActionBridge(service, f.root); cleanup.push(() => bridge.close());
    const response = await callMcp(f, bridge.endpoint, "git_get_operation", { operationId });
    expect(response.result.isError).not.toBe(true);
    expect(response.result.content[0].text).toContain('"status":"remote_success_local_pending"');
    expect(execute).toHaveBeenCalledOnce();
  });

  it("preserves a definitive provider rejection without copying arbitrary provider diagnostics", async () => {
    const f = await fixture();
    const service = new ControlActionService({ ...f, capability: "fixture-capability", revalidate: async () => {},
      execute: async () => { throw new GitHubProviderError("GitHub rejected this request", false,
        { operationId: "original-request", reconcileRequired: false, authorization: "private-provider-diagnostic" }); } });
    const bridge = await startControlActionBridge(service, f.root); cleanup.push(() => bridge.close());
    const response = await callMcp(f, bridge.endpoint);
    expect(response.result.structuredContent.error).toMatchObject({ code: "GITHUB_PROVIDER_FAILED",
      operationId: "original-request", reconcileRequired: false, retryable: false });
    expect(JSON.stringify(response)).not.toContain("private-provider-diagnostic");
  });

  it.each(["", "x".repeat(1_025), 17, "https://username:password@example.com/private"])(
    "does not forward an invalid operation identity (%j)", async operationId => {
      const f = await fixture();
      const endpoint = await fakePeer(f, socket => socket.end(JSON.stringify({ ok: false, error: {
        code: "GITHUB_RESULT_UNCERTAIN", message: "Observe the retained operation", operationId,
        retryable: "true", reconcileRequired: 1, status: "made-up-success", localStage: "unsafe-private-stage", providerPrivate: "not-a-public-result"
      } }) + "\n"));
      const response = await callMcp(f, endpoint);
      expect(response.result.isError).toBe(true);
      expect(response.result.structuredContent.error).not.toHaveProperty("operationId");
      expect(response.result.structuredContent.error).not.toHaveProperty("retryable");
      expect(response.result.structuredContent.error).not.toHaveProperty("reconcileRequired");
      expect(response.result.structuredContent.error).not.toHaveProperty("status");
      expect(response.result.structuredContent.error).not.toHaveProperty("localStage");
      expect(JSON.stringify(response)).not.toContain("not-a-public-result");
    });

  it("drains an accepted callback after the client disconnects and seals new admissions without rejecting its final result", async () => {
    const f = await fixture(); let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const execute = vi.fn(async () => { entered(); await blocked; return { status: "exact-late-result" }; });
    const service = new ControlActionService({ ...f, capability: "fixture-capability", revalidate: async () => {}, execute });
    const bridge = await startControlActionBridge(service, f.root);
    cleanup.push(async () => { release(); await bridge.close(); });
    const socket = net.createConnection(bridge.endpoint.path ? bridge.endpoint.path : { host: bridge.endpoint.host!, port: bridge.endpoint.port! });
    socket.on("error", () => undefined);
    await new Promise<void>(resolve => socket.once("connect", resolve));
    socket.write(JSON.stringify({ capability: "fixture-capability", callId: "exact-call",
      action: { tool: "github_get_pr", providerNumber: 71 } }) + "\n");
    await started; socket.destroy(); service.seal();
    let drained = false; const drain = service.drain().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(drained).toBe(false);
    await expect(service.stageWithResult("fixture-capability", "another-call", { tool: "github_get_pr", providerNumber: 71 }))
      .rejects.toThrow("no longer accepts new actions");
    release(); await drain; expect(drained).toBe(true); expect(execute).toHaveBeenCalledOnce();
  });

  it.each(["deadline", "revoke", "turn_cancel"] as const)("propagates %s to the accepted operation and retains its reservation until it really settles", async mode => {
    const f = await fixture(); const parent = new AbortController();
    let entered!: () => void; let release!: () => void; let operationSignal!: AbortSignal;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const service = new ControlActionService({ ...f, capability: "fixture-capability", signal: parent.signal,
      revalidate: async () => {}, execute: async (_envelope, signal) => {
        operationSignal = signal; entered(); await blocked; signal.throwIfAborted();
      } });
    vi.useFakeTimers();
    try {
      const result = service.stageWithResult("fixture-capability", "exact-call", { tool: "github_get_pr", providerNumber: 71 });
      const outcome = Promise.allSettled([result]); await started;
      if (mode === "deadline") await vi.advanceTimersByTimeAsync(CONTROL_OPERATION_TIMEOUT_MS);
      else if (mode === "revoke") service.revoke();
      else parent.abort(new Error("original native turn cancelled"));
      expect(operationSignal.aborted).toBe(true);
      let drained = false; const drain = service.drain().then(() => { drained = true; });
      await Promise.resolve(); expect(drained).toBe(false);
      release(); await drain;
      expect((await outcome)[0]!.status).toBe("rejected"); expect(drained).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { release?.(); vi.useRealTimers(); }
  });

  it.each(["success", "failure", "validation"])("returns the actual %s after more than the old five-second cutoff without repeating an Agent operation", async mode => {
    const f = await fixture(); const result = { providerNumber: 71, status: "merged", mergeCommitSha: "a".repeat(40) };
    const execute = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 5_300));
      if (mode === "failure") throw new Error("Exact original provider rejected this operation");
      return result;
    });
    const service = new ControlActionService({ ...f, capability: "fixture-capability", revalidate: async () => {
      if (mode === "validation") await new Promise(resolve => setTimeout(resolve, 5_300));
    }, execute });
    const bridge = await startControlActionBridge(service, f.root); cleanup.push(() => bridge.close());
    const response = mode === "validation" ? await callMcp(f, bridge.endpoint, "finish_task", { summary: "Agent-authored completion" })
      : await callMcp(f, bridge.endpoint);
    if (mode === "failure") {
      expect(response.result.isError).toBe(true);
      expect(JSON.stringify(response.result)).toContain("Exact original provider rejected");
      expect(JSON.stringify(response.result)).not.toContain("control bridge did not respond");
    } else {
      expect(response.result.isError).not.toBe(true);
      if (mode === "success") expect(response.result.content[0].text).toContain(JSON.stringify(result));
    }
    expect(execute).toHaveBeenCalledTimes(mode === "validation" ? 0 : 1);
    const staged = JSON.parse(await fs.readFile(f.stagingPath, "utf8"));
    expect(staged).toHaveLength(1); expect(staged[0]).toMatchObject({ projectId: f.projectId, invocationId: f.invocationId, callId: "exact-call" });
  }, 12_000);

  it.each(["silent", "partial"])("keeps the original transport silence deadline for a %s peer", async mode => {
    const f = await fixture();
    const endpoint = await fakePeer(f, socket => {
      if (mode === "partial") {
        socket.write('{"protocol":');
        const timer = setInterval(() => { if (!socket.destroyed) socket.write(" "); }, 100);
        socket.once("close", () => clearInterval(timer));
      }
    });
    const began = Date.now(); const response = await callMcp(f, endpoint);
    expect(response.result.isError).toBe(true); expect(JSON.stringify(response.result)).toContain("control bridge did not respond");
    expect(Date.now() - began).toBeLessThan(8_000);
  }, 12_000);

  it.each(["call", "protocol", "mixed", "owner"])("rejects a %s frame/result that does not belong to the current request", async mode => {
    const f = await fixture(); const endpoint = await fakePeer(f, (socket, request) => {
      const frame = mode === "owner" ? { ok: true, envelope: { projectId: f.projectId, agent: f.agent,
        invocationId: "another-live-invocation", callId: request.callId, stateVersion: f.stateVersion, action: request.action }, result: { status: "merged" } }
        : { protocol: mode === "protocol" ? "another-protocol" : "control-pending-v1",
          callId: mode === "call" ? "another-call" : request.callId, pending: true, ...(mode === "mixed" ? { result: { status: "merged" } } : {}) };
      socket.end(JSON.stringify(frame) + "\n");
    });
    const response = await callMcp(f, endpoint);
    expect(response.result.isError).toBe(true); expect(JSON.stringify(response.result)).toContain("does not match");
    expect(await fs.stat(f.stagingPath).catch(() => undefined)).toBeUndefined();
  });

  it("reads chunked and coalesced matching pending frames, then exactly one real result from a legacy-compatible endpoint", async () => {
    let negotiatedProtocol: unknown;
    const f = await fixture(); const endpoint = await fakePeer(f, (socket, request) => {
      negotiatedProtocol = request.progressProtocol;
      const pending = JSON.stringify({ protocol: "control-pending-v1", callId: request.callId, pending: true }) + "\n";
      const result = JSON.stringify({ ok: true, envelope: { projectId: f.projectId, agent: f.agent, invocationId: f.invocationId,
        callId: request.callId, stateVersion: f.stateVersion, action: request.action }, result: { status: "exact-result" } }) + "\n";
      socket.write(pending.slice(0, 10)); socket.end(pending.slice(10) + pending + result);
    });
    const response = await callMcp(f, endpoint);
    expect(negotiatedProtocol).toBe("control-pending-v1");
    expect(response.result.isError).not.toBe(true); expect(response.result.content[0].text).toContain("exact-result");
    expect(JSON.stringify(response)).not.toContain("control-pending-v1");
  });

  it("returns promptly when the original bridge is closed while its result remains pending", async () => {
    const f = await fixture(); let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const execute = vi.fn(async () => { entered(); await blocked; return { status: "late-provider-result" }; });
    const service = new ControlActionService({ ...f, capability: "fixture-capability", revalidate: async () => {}, execute });
    const bridge = await startControlActionBridge(service, f.root); cleanup.push(async () => { release(); await bridge.close(); });
    const pending = callMcp(f, bridge.endpoint); await started; const began = Date.now(); await bridge.close();
    const response = await pending; release();
    expect(Date.now() - began).toBeLessThan(2_000); expect(response.result.isError).toBe(true);
    expect(JSON.stringify(response.result)).toContain("before returning the current result");
    expect(JSON.stringify(response.result)).not.toContain("late-provider-result"); expect(execute).toHaveBeenCalledOnce();
  }, 12_000);

  it.each(["success", "failure", "revoked", "conflict"])("joins the same pending Agent action exactly once and keeps %s semantics", async mode => {
    const f = await fixture(); let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); const blocked = new Promise<void>(resolve => { release = resolve; });
    let secondEntered!: () => void; let validations = 0;
    const secondValidated = new Promise<void>(resolve => { secondEntered = resolve; });
    const execute = vi.fn(async () => { entered(); await blocked; if (mode === "failure") throw new Error("Original callback failed"); return { exact: "original-result" }; });
    const service = new ControlActionService({ ...f, capability: "fixture-capability", revalidate: async () => {
      if (++validations === 2) secondEntered();
    }, execute });
    const action: ControlAction = { tool: "github_get_pr", providerNumber: 71 };
    const first = service.stageWithResult("fixture-capability", "exact-call", action); await started;
    const second = service.stageWithResult("fixture-capability", "exact-call", mode === "conflict" ? { ...action, providerNumber: 72 } : action);
    const all = Promise.allSettled([first, second]);
    if (mode !== "conflict") { await secondValidated; await new Promise(resolve => setImmediate(resolve)); }
    if (mode === "revoked") service.revoke(); release();
    const outcomes = await all; expect(execute).toHaveBeenCalledOnce();
    if (mode === "success") {
      expect(outcomes.every(x => x.status === "fulfilled")).toBe(true);
      expect(outcomes[0]).toEqual(outcomes[1]);
      expect(await service.stageWithResult("fixture-capability", "exact-call", action)).toEqual((outcomes[0] as PromiseFulfilledResult<unknown>).value);
      expect(execute).toHaveBeenCalledOnce();
    } else if (mode === "conflict") {
      expect(outcomes[0].status).toBe("fulfilled"); expect(outcomes[1].status).toBe("rejected");
    } else {
      expect(outcomes.every(x => x.status === "rejected")).toBe(true);
      expect(String((outcomes[0] as PromiseRejectedResult).reason)).toContain(mode === "failure" ? "Original callback failed" : "revoked");
    }
    expect(JSON.parse(await fs.readFile(f.stagingPath, "utf8"))).toHaveLength(1);
  });
});
