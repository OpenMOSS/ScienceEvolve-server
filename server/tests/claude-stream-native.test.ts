import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ResidentNativeDriver, claudeStreamJsonCodec } from "../src/harness-runtime/resident-native-driver.js";

// Explicit integration run: real installed CLI, localhost-only provider/MCP,
// private native Session, no model account or production project.
describe.runIf(process.platform === "linux" && process.env.OPENFARS_NATIVE_CLAUDE_TESTS === "1")(
  "installed Claude stream-json protocol", () => {
    it("retains the original slow MCP call through its native progress heartbeat and actual result", async () => {
      const repo = fileURLToPath(new URL("../../", import.meta.url));
      const executable = await fs.realpath(path.join(repo, "harness/claude code/node_modules/.bin/claude"));
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-claude-progress-"));
      const sessionId = randomUUID();
      const requests: Array<{ model: string; hasResult: boolean }> = [];
      const metadata: Array<Record<string, unknown>> = [];
      const releases: string[] = [];
      const provider = createServer(async (req, res) => {
        let body = ""; for await (const chunk of req) body += chunk;
        if (!req.url?.includes("/messages")) { res.writeHead(200); res.end("{}"); return; }
        const input = JSON.parse(body);
        const hasResult = input.messages?.some((message: { content?: Array<{ type: string }> }) =>
          Array.isArray(message.content) && message.content.some(block => block.type === "tool_result"));
        const tool = input.tools?.find((value: { name: string }) => value.name.includes("delayed"));
        requests.push({ model: input.model, hasResult });
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        send("message_start", { message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant",
          model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } });
        if (!hasResult && tool) {
          send("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_delayed_1", name: tool.name, input: {} } });
          send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
        } else {
          send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
          send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "isolated-slow-tool-received" } });
        }
        send("content_block_stop", { index: 0 });
        send("message_delta", { delta: { stop_reason: !hasResult && tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } });
        send("message_stop", {}); res.end();
      });
      await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture provider address");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const callsPath = path.join(root, "calls.jsonl");
      const toolPath = path.join(root, "tool.cjs");
      await fs.writeFile(toolPath, String.raw`
        const fs=require('node:fs'),r=require('node:readline').createInterface({input:process.stdin});
        const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
        r.on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;
          const reply=result=>send({jsonrpc:'2.0',id:q.id,result});
          if(q.method==='initialize')return reply({protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
          if(q.method==='tools/list')return reply({tools:[{name:'delayed',description:'Controlled slow tool.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]});
          if(q.method==='tools/call'){fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({name:q.params.name})+'\n');return setTimeout(()=>reply({content:[{type:'text',text:'controlled-tool-result'}]}),32000);}
          reply({});
        });
      `);
      const configPath = path.join(root, "mcp.json");
      await fs.writeFile(configPath, JSON.stringify({ mcpServers: { fixture: { type: "stdio", command: process.execPath, args: [toolPath] } } }));
      const environment: NodeJS.ProcessEnv = { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: path.join(root, "claude"),
        ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: "local-fixture", ANTHROPIC_API_KEY: "local-fixture",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
      delete environment.CLAUDECODE;
      const child = spawn(executable, ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
        "--replay-user-messages", "--include-partial-messages", "--bare", "--tools", "", "--allowedTools", "mcp__fixture__delayed",
        "--strict-mcp-config", "--mcp-config", configPath, "--permission-mode", "dontAsk", "--model", "fixture", "--session-id", sessionId],
      { cwd: root, env: environment, detached: true, stdio: "pipe" });
      let driver: ResidentNativeDriver | undefined;
      try {
        driver = await ResidentNativeDriver.open({ child, session: { schemaVersion: 1, harnessId: "claude-code", adapterVersion: "1",
          generation: 0, nativeId: sessionId, durable: true, createdAt: new Date().toISOString() }, codec: claudeStreamJsonCodec(),
        ownershipEpoch: 1, inactivityPolicy: { modelTimeoutMs: 60_000, toolTimeoutMs: 60_000 },
        turnAuthority: { activate: async turn => ({ inputId: turn.inputId, invocationId: turn.invocationId, ownershipEpoch: 1,
          release: outcome => { releases.push(outcome); } }) },
        onFrame: frame => {
          metadata.push({ type: frame.type, sessionId: frame.session_id, toolCallId: frame.tool_use_id,
            parentToolCallId: frame.parent_tool_use_id, toolName: frame.tool_name, elapsedSeconds: frame.elapsed_time_seconds });
          if (frame.type === "tool_progress") expect(releases).toEqual([]);
        } });
        const turn = (index: number) => ({ inputId: `input-${index}`, invocationId: `inv-${index}`,
          prompt: "Call the controlled slow tool once, then report its actual result.", route: { baseUrl, token: `local-only-${index}` } });
        await expect(driver.submit(turn(1))).resolves.toMatchObject({ handoff: "isolated-slow-tool-received", threadId: sessionId });
        expect(metadata).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool_progress", sessionId,
          toolCallId: "toolu_delayed_1-heartbeat-0", parentToolCallId: "toolu_delayed_1",
          toolName: "mcp__fixture__delayed", elapsedSeconds: 30 })]));
        expect(releases).toEqual(["completed"]);
        expect(requests).toEqual([{ model: "fixture", hasResult: false }, { model: "fixture", hasResult: true }]);
        await expect(driver.submit(turn(2))).resolves.toMatchObject({ handoff: "isolated-slow-tool-received", threadId: sessionId });
        expect((await fs.readFile(callsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line))).toEqual([{ name: "delayed" }]);
        await driver.close();
        expect((await driver.probe()).alive).toBe(false);
        if (process.env.OPENFARS_CLAUDE_EVIDENCE_DIR) {
          const dir = path.resolve(process.env.OPENFARS_CLAUDE_EVIDENCE_DIR); await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, "slow-tool.json"), JSON.stringify({ at: new Date().toISOString(),
            executable, executableSha256: createHash("sha256").update(await fs.readFile(executable)).digest("hex"),
            sessionId, metadata, requests, releases, toolCalls: 1, stopProof: await driver.probe() }, null, 2), { flag: "wx" });
        }
      } finally {
        await driver?.close().catch(() => undefined);
        if (child.exitCode === null && child.signalCode === null && child.pid) process.kill(-child.pid, "SIGKILL");
        provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
        await fs.rm(root, { recursive: true, force: true });
      }
    }, 60_000);
  }
);
