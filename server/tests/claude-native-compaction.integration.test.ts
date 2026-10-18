import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { startProtocolProxy } from "../src/protocol-router.js";

// Opt-in test against an installed Claude Code CLI. All model responses and
// usage are synthetic; no credentials or external model service are used.
const executable = process.env.SCIENCEEVOLVE_TEST_CLAUDE_BIN;
it.skipIf(!executable).each(["proactive", "reactive"] as const)(
  "uses Claude Code native %s compaction through the gateway proxy", async (mode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-native-compact-"));
    const fixture = path.join(root, "fixture.txt");
    await fs.writeFile(fixture, "Synthetic evidence was read.\n");
    let stage = "seed";
    let summaries = 0;
    let errors = 0;
    const upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const last = JSON.stringify(body.messages?.at(-1)?.content ?? "");
      const summary = /Your task is to create a detailed summary|summarize the conversation|summarise the conversation|context window.*summary/i.test(last);
      if (summary) summaries++;
      if (mode === "reactive" && stage === "tool-sent" && !summary && summaries === 0 && errors === 0) {
        errors++;
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: {
          type: "invalid_request_error",
          message: "Your request exceeded model token limit: 1048576 (requested: 1230139)"
        } }));
        return;
      }
      let content: Array<Record<string, unknown>>;
      let reason = "end_turn";
      let cachedTokens = 0;
      if (stage === "seed") {
        content = [{ type: "text", text: "Setup acknowledged." }];
      } else if (stage === "read" && !summary) {
        content = [{ type: "tool_use", id: "toolu_fixture", name: "Read", input: { file_path: fixture } }];
        reason = "tool_use";
        cachedTokens = mode === "proactive" ? 900000 : 1000;
        stage = "tool-sent";
      } else {
        content = [{ type: "text", text: summary
          ? "The user requested reading the synthetic fixture. It has been read. Reply DONE."
          : "DONE" }];
      }
      const message = {
        id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: "k3",
        content, stop_reason: reason, stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: cachedTokens, cache_creation_input_tokens: 0 }
      };
      if (!body.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(message));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, value: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      send("message_start", { message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } });
      for (const [index, block] of content.entries()) {
        send("content_block_start", { index, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } });
        send("content_block_delta", { index, delta: block.type === "text"
          ? { type: "text_delta", text: block.text }
          : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
        send("content_block_stop", { index });
      }
      send("message_delta", { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 30 } });
      send("message_stop", {});
      response.end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const proxy = await startProtocolProxy({
      sourceProtocol: "anthropic-messages", targetProtocol: "anthropic-messages", force: true,
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`, gatewayApiKey: "synthetic-local-only",
      validateGatewayTarget: async () => undefined
    });
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "windir", "COMSPEC", "ComSpec", "TEMP", "TMP", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, {
      CLAUDE_CONFIG_DIR: path.join(root, "config"), ANTHROPIC_BASE_URL: proxy.baseUrl.replace(/\/v1$/, ""),
      ANTHROPIC_AUTH_TOKEN: proxy.token, ANTHROPIC_MODEL: "k3", ANTHROPIC_SMALL_FAST_MODEL: "k3",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "800000", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1", API_TIMEOUT_MS: "15000", CLAUDE_CODE_MAX_RETRIES: "0"
    });
    const session = randomUUID();
    const invoke = async (resume: boolean, prompt: string) => {
      const child = spawn(executable!, [
        "--print", "--verbose", "--output-format", "stream-json", "--bare", "--restricted",
        "--tools", "Read", "--allowedTools", "Read", "--permission-mode", "dontAsk", "--model", "k3",
        "--settings", JSON.stringify({ modelOverrides: { "claude-sonnet-4-5": "k3" } }),
        "--max-turns", "8", resume ? "--resume" : "--session-id", session
      ], { cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdin.end(prompt);
      const timer = setTimeout(() => child.kill(), 45_000);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        expect(code, stderr || stdout).toBe(0);
        return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } finally { clearTimeout(timer); }
    };
    try {
      await invoke(false, "Remember that the next request will ask you to read a synthetic fixture.");
      stage = "read";
      const events = await invoke(true, `Read ${fixture} with the Read tool, then reply DONE.`);
      expect(summaries).toBeGreaterThan(0);
      expect(errors).toBe(mode === "reactive" ? 1 : 0);
      expect(events.some((event) => event.subtype === "compact_boundary")).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "result", is_error: false, result: "DONE" });
      expect(proxy.getFailure()).toBeUndefined();
    } finally {
      await proxy.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 110_000
);
