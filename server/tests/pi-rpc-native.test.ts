import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ResidentNativeDriver, piRpcCodec } from "../src/harness-runtime/resident-native-driver.js";

// Explicit integration run uses the installed Pi CLI, its real retry state
// machine and a localhost-only provider. No model account or gateway is used.
const repo = fileURLToPath(new URL("../../", import.meta.url));
const piRoot = path.join(repo, "harness/pi/node_modules/@mariozechner/pi-coding-agent");
const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null && child.pid) process.kill(-child.pid, "SIGKILL");
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === "linux" && process.env.OPENFARS_NATIVE_PI_TESTS === "1")(
  "installed Pi RPC retry protocol", () => {
    it.each(["recover", "exhaust"] as const)("retains authority through native retries: %s", async (mode) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-pi-local-"));
      roots.push(root);
      let requests = 0;
      const provider = createServer(async (req, res) => {
        for await (const _chunk of req) { /* drain localhost fixture request */ }
        requests += 1;
        if (requests === 1 || mode === "exhaust") {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "503 isolated retry fixture", type: "server_error" } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: object, finish_reason: string | null) => res.write(`data: ${JSON.stringify({
          id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
          choices: [{ index: 0, delta, finish_reason }]
        })}\n\n`);
        chunk({ role: "assistant", content: requests === 2 ? "native-retry-final" : "native-next-turn" }, null);
        chunk({}, "stop");
        res.end("data: [DONE]\n\n");
      });
      servers.push(provider);
      await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      await fs.writeFile(path.join(root, "models.json"), JSON.stringify({ providers: { fixture: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture-only",
        models: [{ id: "fixture", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 512 }]
      } } }));
      await fs.writeFile(path.join(root, "settings.json"), JSON.stringify({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 2000, provider: { maxRetries: 0 } }
      }));
      const sessionPath = path.join(root, "session.jsonl");
      const child = spawn(process.execPath, [path.join(piRoot, "dist/cli.js"),
        "--mode", "rpc", "--provider", "fixture", "--model", "fixture", "--thinking", "off",
        "--session", sessionPath, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
        "--tools", "read"
      ], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: root }, detached: true, stdio: "pipe" });
      children.push(child);
      const wire: Array<{ at: number; frame: Record<string, unknown> }> = [];
      let buffer = "";
      child.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (line.trim()) wire.push({ at: Date.now(), frame: JSON.parse(line) });
        }
      });
      const releases: Array<{ at: number; outcome: string; alive: boolean }> = [];
      const driver = await ResidentNativeDriver.open({
        child,
        session: { schemaVersion: 1, harnessId: "pi", adapterVersion: "native-test", generation: 0,
          nativeId: sessionPath, durable: true, createdAt: new Date().toISOString() },
        codec: piRpcCodec({ expectedSessionPath: sessionPath }), ownershipEpoch: 1,
        inactivityPolicy: { modelTimeoutMs: 15_000, toolTimeoutMs: 15_000 },
        turnAuthority: { activate: async (turn) => ({
          inputId: turn.inputId, invocationId: turn.invocationId, ownershipEpoch: 1,
          release: async (outcome) => { releases.push({ at: Date.now(), outcome, alive: (await driver.probe()).alive }); }
        }) }
      });
      const turn = (index: number) => ({ inputId: `input-${index}`, invocationId: `inv-${index}`,
        prompt: `Return the fixture text for turn ${index}.`,
        route: { baseUrl: `http://127.0.0.1:${address.port}/turn-${index}`, token: `fixture-${index}` },
        controlCapability: `fixture-capability-${index}` });
      const result = driver.submit(turn(1)).then(
        (value) => ({ value, error: undefined }), (error: Error) => ({ value: undefined, error })
      );
      await expect.poll(() => wire.some(({ frame }) => frame.type === "auto_retry_start"), { timeout: 12_000 }).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(releases).toEqual([]);
      expect(driver.activityState()?.invocationId).toBe("inv-1");
      await expect(driver.submit(turn(2))).rejects.toThrow(/concurrent/);
      await expect(driver.pause()).rejects.toThrow(/busy/);
      const backoff = { at: Date.now(), activity: driver.activityState(), process: await driver.probe(),
        releases: structuredClone(releases), concurrentTurnRejected: true, pauseRejected: true };
      const outcome = await result;
      const firstTurnRequests = requests;
      const retryIndex = wire.findIndex(({ frame }) => frame.type === "auto_retry_start");
      expect(wire[retryIndex]!.frame).toMatchObject({ attempt: 1, delayMs: 2000, maxAttempts: 1 });
      expect(wire[retryIndex]!.frame.sessionId).toBeUndefined();
      expect(wire[retryIndex - 1]!.frame.type).toBe("agent_end");
      const retryEnd = wire.find(({ frame }) => frame.type === "auto_retry_end")!;
      expect(retryEnd.at - wire[retryIndex]!.at).toBeGreaterThanOrEqual(1900);
      expect(releases).toHaveLength(1);
      expect(requests).toBe(2);
      let adjacentTurn;
      if (mode === "recover") {
        expect(outcome.error).toBeUndefined();
        expect(outcome.value?.handoff).toBe("native-retry-final");
        expect(releases[0]!.outcome).toBe("completed");
        const finalEnd = wire.filter(({ frame }) => frame.type === "agent_end").at(-1)!;
        expect(releases[0]!.at).toBeGreaterThanOrEqual(finalEnd.at);
        expect(retryEnd.frame.success).toBe(true);
        adjacentTurn = await driver.submit(turn(2));
        expect(adjacentTurn).toMatchObject({ handoff: "native-next-turn" });
        await driver.close();
      } else {
        expect(outcome.error?.message).toMatch(/Pi automatic retry failed/);
        expect(retryEnd.frame.success).toBe(false);
        expect(releases[0]).toMatchObject({ outcome: "failed", alive: false });
      }
      if (process.env.OPENFARS_PI_EVIDENCE_DIR) {
        const dir = path.resolve(process.env.OPENFARS_PI_EVIDENCE_DIR);
        await fs.mkdir(dir, { recursive: true });
        const files = ["package.json", "dist/cli.js", "dist/core/agent-session.js", "dist/modes/rpc/rpc-mode.js"];
        const hashes = Object.fromEntries(await Promise.all(files.map(async (file) => [file,
          createHash("sha256").update(await fs.readFile(path.join(piRoot, file))).digest("hex")])));
        await fs.writeFile(path.join(dir, `${mode}.json`), JSON.stringify({
          schemaVersion: 2, mode, piVersion: JSON.parse(await fs.readFile(path.join(piRoot, "package.json"), "utf8")).version,
          packageRoot: await fs.realpath(piRoot), hashes, requests, firstTurnRequests, wire, releases, backoff, adjacentTurn,
          sessionPath, sessionSha256: createHash("sha256").update(await fs.readFile(sessionPath)).digest("hex"),
          stopProof: { at: Date.now(), process: await driver.probe() },
          outcome: { value: outcome.value, error: outcome.error?.message },
          stopped: !(await driver.probe()).alive
        }, null, 2), { flag: "wx" });
      }
    }, 30_000);
  }
);
