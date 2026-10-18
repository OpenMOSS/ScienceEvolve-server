import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  startProtocolProxy as startValidatedProtocolProxy,
  type AgentProtocol,
  type BufferedProtocolResponse,
  type ProtocolProxy,
  type ProtocolProxyOptions
} from "../src/protocol-router.js";
import type {
  GatewayModelStreamEvent,
  GatewayTokenUsage,
  GatewayUsagePersistenceFailure,
  GatewayUsageReport
} from "../src/types.js";

const startProtocolProxy = (options: ProtocolProxyOptions) =>
  startValidatedProtocolProxy({
    ...options,
    validateGatewayTarget: async () => undefined
  });

const protocols: AgentProtocol[] = ["responses", "chat-completions", "anthropic-messages"];

const sourcePath: Record<AgentProtocol, string> = {
  responses: "/v1/responses",
  "chat-completions": "/v1/chat/completions",
  "anthropic-messages": "/v1/messages"
};

function sourceBody(protocol: AgentProtocol, stream: boolean): Record<string, unknown> {
  if (protocol === "responses") {
    return {
      model: "nex-agi/Nex-N2-Pro",
      input: [{ role: "user", content: "hello" }],
      stream
    };
  }
  if (protocol === "chat-completions") {
    return {
      model: "nex-agi/Nex-N2-Pro",
      messages: [{ role: "user", content: "hello" }],
      stream
    };
  }
  return {
    model: "nex-agi/Nex-N2-Pro",
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    stream
  };
}

function responseBody(protocol: AgentProtocol): Record<string, unknown> {
  if (protocol === "responses") {
    return {
      id: "resp_test",
      model: "nex-agi/Nex-N2-Pro",
      output_text: "hello from responses",
      output: [{ type: "message", content: [{ type: "output_text", text: "hello from responses" }] }]
    };
  }
  if (protocol === "chat-completions") {
    return {
      id: "chat_test",
      model: "nex-agi/Nex-N2-Pro",
      choices: [{ index: 0, message: { role: "assistant", content: "hello from chat" }, finish_reason: "stop" }]
    };
  }
  return {
    id: "msg_test",
    type: "message",
    model: "nex-agi/Nex-N2-Pro",
    role: "assistant",
    content: [{ type: "text", text: "hello from anthropic" }],
    stop_reason: "end_turn"
  };
}

function streamFrames(protocol: AgentProtocol): string[] {
  if (protocol === "responses") {
    return [
      JSON.stringify({ type: "response.output_text.delta", delta: "streamed responses" }),
      JSON.stringify({ type: "response.completed", response: { status: "completed" } })
    ];
  }
  if (protocol === "chat-completions") {
    return [
      JSON.stringify({ choices: [{ delta: { content: "streamed chat" }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })
    ];
  }
  return [
    JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "streamed anthropic" } }),
    JSON.stringify({ type: "message_stop" })
  ];
}

async function listen(server: Server): Promise<{ port: number; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback server did not receive a port");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

describe("protocol proxy loopback integration", () => {
  let upstream: Server | undefined;
  let proxy: ProtocolProxy | undefined;

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
    if (upstream?.listening) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = undefined;
  });

  it.each(protocols)("retains the actual outgoing tool schemas once per changed set (%s)", async targetProtocol => {
    const forwarded: Array<Record<string, unknown>> = [];
    const traces: Array<{ message: string; data?: Record<string, unknown> }> = [];
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody(targetProtocol)));
    });
    const address = await listen(upstream);
    proxy = await startProtocolProxy({ sourceProtocol: "responses", targetProtocol, force: true,
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`, gatewayApiKey: "upstream-secret",
      onTrace: (_kind, message, data) => { traces.push({ message, data }); } });
    const tools = [{ type: "function", name: "mcp__openfars__finish_task", description: "Finish the current task",
      strict: true, parameters: { type: "object", properties: { summary: { type: "string" } },
        required: ["summary"], additionalProperties: false } }];
    for (const current of [tools, tools, [{ ...tools[0], parameters: { ...tools[0].parameters, required: [] } }], []]) {
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST",
        headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...sourceBody("responses", false), tools: current,
          input: [{ role: "user", content: "private prompt sentinel" }] }) });
      expect(response.status).toBe(200); await response.text();
    }
    const diagnostics = traces.filter(trace => trace.message === "Protocol proxy forwarded request").map(trace => trace.data!);
    expect(diagnostics).toHaveLength(4);
    for (const index of [0, 2, 3]) {
      expect(diagnostics[index].toolDefinitions).toEqual(forwarded[index].tools ?? []);
      expect(diagnostics[index].toolDefinitionDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(diagnostics[index].requestId).toMatch(/^usage_/);
    }
    expect(diagnostics[0].toolNames).toEqual(["mcp__openfars__finish_task"]);
    expect(diagnostics[1].toolDefinitions).toBeUndefined();
    expect(diagnostics[1].toolDefinitionsOmittedReason).toBe("already_traced");
    expect(diagnostics[1].toolDefinitionDigest).toBe(diagnostics[0].toolDefinitionDigest);
    expect(diagnostics[2].toolDefinitionDigest).not.toBe(diagnostics[0].toolDefinitionDigest);
    expect(diagnostics[3].toolNames).toEqual([]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/upstream-secret|private prompt sentinel|Bearer /);
  });

  it.each([false, true])("bounds and redacts tool diagnostics without changing the outgoing tools (oversize=%s)", async oversize => {
    const traces: Array<{ message: string; data?: Record<string, unknown> }> = [];
    let forwarded: Record<string, unknown> | undefined;
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody("chat-completions")));
    });
    const address = await listen(upstream);
    proxy = await startProtocolProxy({ sourceProtocol: "responses", targetProtocol: "chat-completions", force: true,
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`, gatewayApiKey: "upstream-secret",
      onTrace: (_kind, message, data) => { traces.push({ message, data }); } });
    const tool = { type: "function", name: "lookup", description: oversize ? "large schema sentinel".repeat(8_000) : "lookup",
      parameters: { type: "object", properties: { apiKey: { type: "string", default: "private-schema-secret" } } } };
    const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST",
      headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...sourceBody("responses", false), tools: [tool] }) });
    expect(response.status).toBe(200); await response.text();
    const diagnostic = traces.find(trace => trace.message === "Protocol proxy forwarded request")!.data!;
    expect(diagnostic.toolNames).toEqual(["lookup"]);
    expect(diagnostic.toolDefinitionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(diagnostic.toolDefinitionsRedacted).toBe(true);
    expect(JSON.stringify(diagnostic)).not.toMatch(/private-schema-secret|upstream-secret/);
    expect(JSON.stringify(forwarded!.tools)).toContain("private-schema-secret");
    if (oversize) {
      expect(diagnostic.toolDefinitions).toBeUndefined();
      expect(diagnostic.toolDefinitionsOmittedReason).toBe("size_limit");
      expect(JSON.stringify(diagnostic).length).toBeLessThan(2_000);
    } else expect(JSON.stringify(diagnostic.toolDefinitions)).toContain("[REDACTED]");
  });

  it.each(["http", "sse", "buffered", "buffered-cached", "buffered-200", "json-200"])(
    "adapts Kimi context errors for native compaction and permits recovery (%s)", async (mode) => {
      let calls = 0;
      const cache = new Map<string, Promise<BufferedProtocolResponse>>();
      upstream = createServer(async (request, response) => {
        for await (const _chunk of request) { /* drain request */ }
        const error = { type: "error", error: {
          type: "invalid_request_error",
          message: "Your request exceeded model token limit: 1048576 (requested: 1230139)"
        } };
        if (++calls === 1) {
          if (mode === "sse") {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(`event: error\ndata: ${JSON.stringify(error)}\n\n`);
          } else {
            response.writeHead(mode.endsWith("200") ? 200 : 400, { "content-type": "application/json" });
            response.end(JSON.stringify(error));
          }
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(responseBody("anthropic-messages")));
        }
      });
      const address = await listen(upstream);
      proxy = await startProtocolProxy({
        sourceProtocol: "anthropic-messages", targetProtocol: "anthropic-messages", force: true,
        gatewayUrl: `http://127.0.0.1:${address.port}/v1`, gatewayApiKey: "fixture-secret",
        ...(mode.startsWith("buffered") ? { deliveryMode: "buffered-json" as const } : {}),
        ...(mode === "buffered-cached" || mode === "buffered-200" ? { bufferedResponseCache: cache } : {})
      });
      const send = (stream: boolean) => fetch(`${proxy!.baseUrl}/messages`, {
        method: "POST", headers: { "content-type": "application/json", "x-api-key": proxy!.token },
        body: JSON.stringify(sourceBody("anthropic-messages", stream))
      });
      const failed = await send(mode !== "http" && mode !== "json-200");
      const text = await failed.text();
      expect(text).toContain("prompt is too long: 1230139 tokens > 1048576 maximum");
      expect(text).toContain("invalid_request_error");
      expect(proxy.getFailure?.()).toMatchObject({
        code: "MODEL_CONTEXT_LIMIT_EXCEEDED", requestedTokens: 1230139, limitTokens: 1048576
      });
      expect(cache.size).toBe(0);
      // Native compaction uses this same route; the error must not quarantine it.
      const recovered = await send(mode.startsWith("buffered"));
      expect(await recovered.text()).toContain("hello from anthropic");
      expect(calls).toBe(2);
      expect(proxy.getFailure?.()).toBeUndefined();
    }
  );
  it.each([
    { mode: "http", target: "responses" }, { mode: "sse", target: "responses" },
    { mode: "buffered", target: "responses" }, { mode: "json-200", target: "responses" },
    { mode: "http", target: "chat-completions" }, { mode: "http", target: "anthropic-messages" }
  ] as const)("preserves native Responses context recovery for $target/$mode", async ({ mode, target }) => {
    let calls = 0;
    const error = { code: "context_length_exceeded", type: "invalid_request_error",
      message: "This model's maximum context length is 20000 tokens. You requested 22000 tokens." };
    upstream = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain */ }
      if (++calls === 1) {
        if (mode === "sse") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(`data: ${JSON.stringify({ type: "response.failed", response: { id: "resp_context", status: "failed", error } })}\n\n`);
        } else {
          response.writeHead(mode === "json-200" ? 200 : 400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error }));
        }
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(responseBody(target)));
      }
    });
    const address = await listen(upstream);
    proxy = await startProtocolProxy({ sourceProtocol: "responses", targetProtocol: target, force: true,
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`, gatewayApiKey: "fixture-secret",
      ...(mode === "buffered" ? { deliveryMode: "buffered-json" as const } : {}) });
    const send = (stream: boolean) => fetch(`${proxy!.baseUrl}/responses`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${proxy!.token}` },
      body: JSON.stringify(sourceBody("responses", stream)) });
    const failed = await send(true), text = await failed.text();
    expect(failed.status).toBe(200); expect(failed.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain('"type":"response.failed"'); expect(text).toContain('"code":"context_length_exceeded"');
    expect(text).not.toContain('"type":"response.completed"');
    expect(proxy.getFailure?.()).toMatchObject({ code: "MODEL_CONTEXT_LIMIT_EXCEEDED", requestedTokens: 22000, limitTokens: 20000 });
    const recovered = await send(false); expect(await recovered.text()).toContain("hello");
    expect(proxy.getFailure?.()).toBeUndefined(); expect(calls).toBe(2);
  });

  it("advertises the configured Codex window for OpenAI and native model catalogs", async () => {
    let nativeCatalog = false;
    upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(nativeCatalog
        ? { models: [{ slug: "small", context_window: 272_000, base_instructions: "keep" }, { slug: "other", context_window: 8_192 }] }
        : { object: "list", data: [{ id: "small", max_model_len: 272_000 }, { id: "large" }, { id: "other", max_model_len: 4_096 }] }));
    });
    const address = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "responses", targetProtocol: "responses",
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`, gatewayApiKey: "upstream-secret",
      modelContextWindows: { small: 4_096, large: 1_048_576 }, force: true
    });
    const catalog = async () => (await fetch(`${proxy!.baseUrl}/models`, {
      headers: { authorization: `Bearer ${proxy!.token}` }
    })).json() as Promise<{ models: Array<Record<string, unknown>> }>;
    const openaiModels = (await catalog()).models;
    expect(openaiModels.find((model) => model.slug === "small")).toMatchObject({
      context_window: 4_096, max_context_window: 4_096, auto_compact_token_limit: 3_276
    });
    expect(openaiModels.find((model) => model.slug === "large")).toMatchObject({
      context_window: 1_048_576, auto_compact_token_limit: 838_860
    });
    expect(openaiModels.find((model) => model.slug === "other")?.context_window).toBe(4_096);
    nativeCatalog = true;
    const nativeModels = (await catalog()).models;
    expect(nativeModels[0]).toMatchObject({
      slug: "small", context_window: 4_096, auto_compact_token_limit: 3_276,
      base_instructions: "keep"
    });
    expect(nativeModels[1]).toMatchObject({ slug: "other", context_window: 8_192 });
  });

  it("forwards DSH's output budget through a Chat to Anthropic Gateway route", async () => {
    let forwarded: Record<string, unknown> | undefined;
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "msg_budget", type: "message", role: "assistant", model: "model-a",
        content: [{ type: "text", text: "done" }], stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 2 }
      }));
    });
    const address = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "chat-completions", targetProtocol: "anthropic-messages",
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`, gatewayApiKey: "upstream-secret"
    });
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "model-a", messages: [{ role: "user", content: "continue" }], max_completion_tokens: 8_192, stream: false })
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(forwarded).toMatchObject({ model: "model-a", max_tokens: 8_192 });
  });

  it("injects the selected reasoning value into the final cross-protocol provider body", async () => {
    let forwarded: Record<string, unknown> | undefined;
    const traces: Array<{ message: string; data?: Record<string, unknown> }> = [];
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ...responseBody("chat-completions"),
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
      }));
    });
    const address = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "responses",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`,
      gatewayApiKey: "upstream-secret",
      gatewayReasoning: {
        mode: "option",
        optionId: "high",
        label: "High",
        value: "xhigh",
        parameter: "chat_template_kwargs.reasoning_effort",
        fingerprint: "b".repeat(64)
      },
      onTrace: (_kind, message, data) => { traces.push({ message, data }); }
    });
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
      body: JSON.stringify(sourceBody("responses", false))
    });
    expect(response.status).toBe(200);
    await response.json();
    expect(forwarded).toMatchObject({
      chat_template_kwargs: { reasoning_effort: "xhigh" }
    });
    expect(traces.find((trace) => trace.message === "Protocol proxy forwarded request")?.data)
      .toMatchObject({
        reasoningParameter: "chat_template_kwargs.reasoning_effort",
        reasoningValue: "xhigh",
        reasoningOptionId: "high",
        reasoningFingerprint: "b".repeat(64)
      });
  });

  it("routes all six directed pairs over real HTTP and preserves source response shape", async () => {
    const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(String(chunk)));
      seen.push({ path: request.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
      const target = request.url?.endsWith("/responses")
        ? "responses"
        : request.url?.endsWith("/chat/completions")
          ? "chat-completions"
          : "anthropic-messages" as AgentProtocol;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody(target)));
    });
    const upstreamAddress = await listen(upstream);

    for (const source of protocols) {
      for (const target of protocols) {
        if (source === target) continue;
        proxy = await startProtocolProxy({
          sourceProtocol: source,
          targetProtocol: target,
          gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
          gatewayApiKey: "upstream-secret"
        });
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (source === "anthropic-messages") {
          headers["x-api-key"] = proxy.token;
          headers["anthropic-version"] = "2023-06-01";
        } else {
          headers.authorization = `Bearer ${proxy.token}`;
        }
        const response = await fetch(`${proxy.baseUrl}${source === "chat-completions" ? "/chat/completions" : source === "responses" ? "/responses" : "/messages"}`, {
          method: "POST",
          headers,
          body: JSON.stringify(sourceBody(source, false))
        });
        expect(response.status).toBe(200);
        const body = await response.json() as Record<string, unknown>;
        expect(body.model).toBe("nex-agi/Nex-N2-Pro");
        if (source === "responses") expect(body.object).toBe("response");
        if (source === "chat-completions") expect(body.choices).toBeTruthy();
        if (source === "anthropic-messages") expect(body.content).toBeTruthy();
        await proxy.close();
        proxy = undefined;
      }
    }
    expect(seen).toHaveLength(6);
    expect(seen.map((item) => item.path)).toEqual(expect.arrayContaining([
      "/v1/responses", "/v1/chat/completions", "/v1/messages"
    ]));
  });

  it("retains the latest provider transport failure and clears it after a later successful request", async () => {
    let upstreamRequests = 0;
    upstream = createServer(async (request, response) => {
      upstreamRequests += 1;
      if (upstreamRequests <= 2) {
        request.socket.destroy();
        return;
      }
      for await (const _chunk of request) {
        // Drain the successful request before responding.
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody("chat-completions")));
    });
    const upstreamAddress = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "chat-completions",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret",
      force: true
    });
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${proxy.token}`
    };
    const invoke = () => fetch(`${proxy!.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(sourceBody("chat-completions", false))
    });

    const failed = await invoke();
    expect(failed.status).toBe(502);
    expect(proxy.getFailure?.()).toMatchObject({
      code: "MODEL_PROVIDER_FAILED",
      message: "Gateway request failed before a response was received",
      sourceProtocol: "chat-completions",
      targetProtocol: "chat-completions"
    });

    const succeeded = await invoke();
    expect(succeeded.status).toBe(200);
    expect(proxy.getFailure?.()).toBeUndefined();
    expect(upstreamRequests).toBe(3);
  });

  it("converts streaming frames for all six directed pairs", async () => {
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(String(chunk)));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean };
      expect(body.stream).toBe(true);
      const target = request.url?.endsWith("/responses")
        ? "responses"
        : request.url?.endsWith("/chat/completions")
          ? "chat-completions"
          : "anthropic-messages" as AgentProtocol;
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of streamFrames(target)) response.write(`data: ${frame}\n\n`);
      response.end();
    });
    const upstreamAddress = await listen(upstream);

    for (const source of protocols) {
      for (const target of protocols) {
        if (source === target) continue;
        proxy = await startProtocolProxy({
          sourceProtocol: source,
          targetProtocol: target,
          gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
          gatewayApiKey: "upstream-secret"
        });
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (source === "anthropic-messages") headers["x-api-key"] = proxy.token;
        else headers.authorization = `Bearer ${proxy.token}`;
        const response = await fetch(`${proxy.baseUrl}${sourcePath[source].slice(3)}`, {
          method: "POST",
          headers,
          body: JSON.stringify(sourceBody(source, true))
        });
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain("streamed");
        if (source === "chat-completions") expect(text).toContain("[DONE]");
        if (source === "anthropic-messages") expect(text).toContain("event: message_stop");
        await proxy.close();
        proxy = undefined;
      }
    }
  });

  it("resets the provider inactivity deadline when an SSE frame arrives", async () => {
    upstream = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the request before starting the delayed stream.
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const frames = streamFrames("responses");
      response.write(`data: ${frames[0]}\n\n`);
      await delay(700);
      response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: " still working" })}\n\n`);
      await delay(700);
      response.write(`data: ${frames[1]}\n\n`);
      response.end();
    });
    const upstreamAddress = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "chat-completions",
      targetProtocol: "responses",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret",
      timeoutMs: 1_000
    });
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${proxy.token}`
      },
      body: JSON.stringify(sourceBody("chat-completions", true))
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("streamed responses");
  }, 10_000);

  it.each([true, false])("streams only explicit public summaries from actual tool turns before completion (tools=%s)", async withTools => {
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    upstream = createServer(async (request, response) => {
      for await (const _chunk of request) {}
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of [
        { type: "response.reasoning_text.delta", delta: "RAW_PRIVATE_THOUGHT" },
        { type: "response.reasoning_summary_text.delta", item_id: "summary-1", summary_index: 0, delta: "Inspect " },
        { type: "response.reasoning_summary_text.delta", item_id: "summary-1", summary_index: 0, delta: "the draft." }
      ]) response.write(`data: ${JSON.stringify(frame)}\n\n`);
      await paused;
      response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Visible answer" })}\n\n`);
      response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`);
    });
    const address = await listen(upstream), summaries: Array<{ text: string; id: string }> = [];
    proxy = await startProtocolProxy({ sourceProtocol: "responses", targetProtocol: "responses", force: true,
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`, gatewayApiKey: "upstream-secret", timeoutMs: 2000,
      onVisibleReasoningSummaryDelta: (text, id) => { summaries.push({ text, id }); } });
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST",
        headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...sourceBody("responses", true), tools: withTools
          ? [{ type: "function", name: "get_context", parameters: { type: "object", properties: {} } }] : [] }) });
      let completed = false;
      const body = response.text().then(text => { completed = true; return text; });
      if (withTools) {
        await vi.waitFor(() => expect(summaries.map(item => item.text)).toEqual(["Inspect ", "the draft."]));
        expect(summaries[0].id).toBe(summaries[1].id);
        expect(completed).toBe(false);
      }
      release();
      expect(await body).toContain("Visible answer");
      expect(JSON.stringify(summaries)).not.toContain("RAW_PRIVATE_THOUGHT");
      if (!withTools) expect(summaries).toEqual([]);
    } finally { release(); }
  });

  it("delivers native Chat reasoning chunks before the provider completes", async () => {
    let completeProvider!: () => void;
    const completion = new Promise<void>((resolve) => { completeProvider = resolve; });
    upstream = createServer(async (request, response) => {
      for await (const _chunk of request) {}
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        choices: [{ delta: { reasoning_content: "native reasoning" }, finish_reason: null }]
      })}\n\n`);
      await completion;
      response.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: "visible answer" }, finish_reason: null }]
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }]
      })}\n\n`);
      response.end();
    });
    const upstreamAddress = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "chat-completions",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret",
      force: true,
      timeoutMs: 1_000
    });
    try {
      const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${proxy.token}`
        },
        body: JSON.stringify(sourceBody("chat-completions", true)),
        signal: AbortSignal.timeout(3_000)
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes("native reasoning")) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        received += decoder.decode(chunk.value, { stream: true });
      }
      const frame = received.split("\n").find((line) => line.startsWith("data:") && line.includes("native reasoning"));
      const delta = JSON.parse(frame!.slice(5)).choices[0].delta;
      expect(delta).toEqual({ reasoning_content: "native reasoning" });
      completeProvider();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
      expect(received).toContain("visible answer");
      expect(received).toContain("[DONE]");
    } finally {
      completeProvider();
    }
  }, 10_000);

  it("keeps a Responses client alive during hidden Chat reasoning without exposing it", async () => {
    upstream = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the request before starting the delayed stream.
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        choices: [{ delta: { reasoning_content: "private chain of thought" }, finish_reason: null }]
      })}\n\n`);
      await delay(600);
      response.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: "visible answer" }, finish_reason: null }]
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }]
      })}\n\n`);
      response.end();
    });
    const upstreamAddress = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "responses",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret",
      timeoutMs: 1_000
    });
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${proxy.token}`
      },
      body: JSON.stringify(sourceBody("responses", true))
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"type":"response.in_progress"');
    expect(body).toContain("visible answer");
    expect(body).not.toContain("private chain of thought");
  }, 10_000);

  it("reports only substantive model deltas and completion as model activity", async () => {
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(String(chunk)));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean };
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const frame of streamFrames("chat-completions")) {
          response.write(`data: ${frame}\n\n`);
        }
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody("chat-completions")));
    });
    const upstreamAddress = await listen(upstream);
    const onActivity = vi.fn();
    const modelEvents: GatewayModelStreamEvent[] = [];
    proxy = await startProtocolProxy({
      sourceProtocol: "chat-completions",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret",
      force: true,
      onActivity,
      onModelStreamEvent: (event) => { modelEvents.push(event); }
    });

    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${proxy.token}`
    };
    const complete = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(sourceBody("chat-completions", false))
    });
    expect(complete.status).toBe(200);
    await complete.json();
    expect(onActivity).toHaveBeenCalledTimes(1);
    expect(onActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "model", phase: "completed", source: "gateway" })
    );

    onActivity.mockClear();
    const streaming = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(sourceBody("chat-completions", true))
    });
    expect(streaming.status).toBe(200);
    await streaming.text();
    expect(onActivity).toHaveBeenCalledTimes(2);
    expect(onActivity.mock.calls.map(([activity]) => activity)).toEqual([
      expect.objectContaining({
        kind: "model",
        phase: "delta",
        source: "gateway",
        deltaKind: "visible-text"
      }),
      expect.objectContaining({ kind: "model", phase: "completed", source: "gateway" })
    ]);
    expect(modelEvents.filter((event) => event.phase === "delta")).toEqual([
      expect.objectContaining({
        streaming: true,
        deliveryMode: "native-stream",
        deltaKind: "visible-text",
        text: "streamed chat"
      })
    ]);
    expect(modelEvents.filter((event) => event.phase === "started").map((event) => event.streaming))
      .toEqual([false, true]);
  });

  it("reports one merged usage record through a native Anthropic route", async () => {
    upstream = createServer(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const frames = [
        {
          type: "message_start",
          message: {
            id: "msg-usage",
            usage: {
              input_tokens: 7,
              cache_creation_input_tokens: 3,
              cache_read_input_tokens: 11,
              output_tokens: 0
            }
          }
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "metered" }
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 }
        },
        { type: "message_stop" }
      ];
      for (const frame of frames) {
        response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
      }
      response.end();
    });
    const upstreamAddress = await listen(upstream);
    const usage: GatewayTokenUsage[] = [];
    proxy = await startProtocolProxy({
      sourceProtocol: "anthropic-messages",
      targetProtocol: "anthropic-messages",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret",
      force: true,
      onUsage: (item) => { usage.push(item); }
    });
    const response = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": proxy.token,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(sourceBody("anthropic-messages", true))
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("metered");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      protocol: "anthropic-messages",
      inputTokens: 21,
      cachedInputTokens: 11,
      outputTokens: 5,
      totalTokens: 26
    });
  });

  it("publishes a structured failure when durable usage accounting rejects", async () => {
    upstream = createServer(async (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ...responseBody("chat-completions"),
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      }));
    });
    const address = await listen(upstream);
    const failures: GatewayUsagePersistenceFailure[] = [];
    proxy = await startProtocolProxy({
      sourceProtocol: "chat-completions",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`,
      gatewayApiKey: "upstream-secret",
      force: true,
      onUsage: () => { throw new Error("fixture durable accounting outage"); },
      onUsagePersistenceFailure: (failure) => { failures.push(failure); }
    });
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${proxy.token}`
      },
      body: JSON.stringify(sourceBody("chat-completions", false))
    });
    expect(response.status).toBe(200);
    await response.json();
    expect(failures.length).toBeGreaterThan(0);
    expect(failures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        usageId: expect.any(String),
        protocol: "chat-completions",
        model: "nex-agi/Nex-N2-Pro",
        error: "fixture durable accounting outage"
      })
    ]));
    expect(failures.every((failure) => failure.error === "fixture durable accounting outage"))
      .toBe(true);
  });

  it("records a completed provider request without usage as unknown instead of zero", async () => {
    upstream = createServer(async (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody("chat-completions")));
    });
    const address = await listen(upstream);
    const usage: GatewayUsageReport[] = [];
    proxy = await startProtocolProxy({
      sourceProtocol: "chat-completions",
      targetProtocol: "chat-completions",
      force: true,
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`,
      gatewayApiKey: "upstream-secret",
      onUsage: (item) => { usage.push(item); }
    });
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
      body: JSON.stringify(sourceBody("chat-completions", false))
    });
    expect(response.status).toBe(200);
    await response.json();
    expect(usage).toEqual([
      expect.objectContaining({
        status: "unknown",
        reason: "provider-response-missing-usage",
        processingState: "processed"
      })
    ]);
    expect(usage[0]).not.toHaveProperty("totalTokens");
  });

  it("records a cleanly completed stream without usage as processed rather than interrupted", async () => {
    upstream = createServer(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of streamFrames("chat-completions")) {
        response.write(`data: ${frame}\n\n`);
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
    const address = await listen(upstream);
    const usage: GatewayUsageReport[] = [];
    proxy = await startProtocolProxy({
      sourceProtocol: "chat-completions",
      targetProtocol: "chat-completions",
      force: true,
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`,
      gatewayApiKey: "upstream-secret",
      onUsage: (item) => { usage.push(item); }
    });

    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${proxy.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(sourceBody("chat-completions", true))
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("streamed chat");
    expect(usage).toEqual([
      expect.objectContaining({
        status: "unknown",
        reason: "provider-response-missing-usage",
        processingState: "processed"
      })
    ]);
  });

  it("accounts each real provider retry under a distinct request identity", async () => {
    let attempts = 0;
    upstream = createServer(async (_request, response) => {
      attempts += 1;
      response.writeHead(attempts === 1 ? 503 : 200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify(attempts === 1
        ? { error: { message: "temporary overload" } }
        : {
            ...responseBody("chat-completions"),
            usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }
          }));
    });
    const address = await listen(upstream);
    const usage: GatewayUsageReport[] = [];
    proxy = await startProtocolProxy({
      sourceProtocol: "chat-completions",
      targetProtocol: "chat-completions",
      force: true,
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`,
      gatewayApiKey: "upstream-secret",
      onUsage: (item) => { usage.push(item); }
    });
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
      body: JSON.stringify(sourceBody("chat-completions", false))
    });
    expect(response.status).toBe(200);
    await response.json();
    expect(attempts).toBe(2);
    expect(usage).toHaveLength(2);
    expect(new Set(usage.map((item) => item.usageId)).size).toBe(2);
    expect(usage[0]).toMatchObject({
      status: "unknown",
      reason: "retry-abandoned",
      processingState: "indeterminate"
    });
    expect(usage[1]).toMatchObject({
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 10
    });
  });

  it("keeps valid streamed usage when a later provider frame fails", async () => {
    upstream = createServer(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: { id: "msg-partial", usage: { input_tokens: 9, output_tokens: 0 } }
      })}\n\n`);
      response.write(`event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "partial" }
      })}\n\n`);
      response.end(`event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { type: "api_error", message: "stream broke after usage" }
      })}\n\n`);
    });
    const address = await listen(upstream);
    const usage: GatewayUsageReport[] = [];
    proxy = await startProtocolProxy({
      sourceProtocol: "anthropic-messages",
      targetProtocol: "anthropic-messages",
      force: true,
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`,
      gatewayApiKey: "upstream-secret",
      onUsage: (item) => { usage.push(item); }
    });
    const response = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": proxy.token,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(sourceBody("anthropic-messages", true))
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("stream broke after usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      inputTokens: 9,
      outputTokens: 0,
      totalTokens: 9
    });
    expect(usage[0]).not.toHaveProperty("status", "unknown");
  });

  it("flushes a prompt Anthropic prelude while buffering delayed buffered Chat output", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const onActivity = vi.fn();
    const modelEvents: GatewayModelStreamEvent[] = [];
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(String(chunk)));
      upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      await delay(1_200);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "neutral-buffered",
        model: "model-neutral-a",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "缓冲回答" },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
      }));
    });
    const upstreamAddress = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "anthropic-messages",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret",
      deliveryMode: "buffered-json",
      onActivity,
      onModelStreamEvent: (event) => { modelEvents.push(event); }
    });
    const started = Date.now();
    const response = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": proxy.token },
      body: JSON.stringify({
        model: "model-neutral-a",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "hello" }]
      })
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(Date.now() - started).toBeLessThan(700);
    const chunks: string[] = [new TextDecoder().decode(first.value)];
    while (!first.done) {
      const next = await reader.read();
      if (next.value) chunks.push(new TextDecoder().decode(next.value));
      if (next.done) break;
    }
    const body = chunks.join("");
    expect(body).toContain("event: message_start");
    expect(body).toContain("缓冲回答");
    expect(body).toContain("event: message_stop");
    expect(body).toContain("\u200b");
    expect(upstreamBody?.stream).toBe(false);
    expect(upstreamBody).not.toHaveProperty("chat_template_kwargs");
    expect(onActivity).toHaveBeenCalledTimes(1);
    expect(onActivity).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "model", phase: "completed", source: "gateway" })
    );
    expect(modelEvents.map((event) => event.phase)).toEqual(["started", "completed"]);
    expect(modelEvents[0]).toMatchObject({
      streaming: false,
      deliveryMode: "buffered-json"
    });
    expect(modelEvents.at(-1)).toMatchObject({
      phase: "completed",
      streaming: false,
      estimatedOutputTokens: expect.any(Number)
    });
  });

  it("semantically reuses a buffered Main response after a fresh Claude client disconnects", async () => {
    let upstreamRequests = 0;
    const usage: GatewayTokenUsage[] = [];
    const terminalTool = "mcp__scienceevolve-orchestration-control__route_to_agent";
    upstream = createServer(async (_request, response) => {
      upstreamRequests += 1;
      await delay(800);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "neutral-recovered",
        model: "model-neutral-a",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "复用成功",
            tool_calls: [{
              id: "call_recovered_route",
              type: "function",
              function: {
                name: terminalTool,
                arguments: JSON.stringify({
                  callId: "recovered-route",
                  target: "analyst",
                  assignment: "continue the recovered turn"
                })
              }
            }]
          },
          finish_reason: "tool_calls"
        }],
        usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 }
      }));
    });
    const upstreamAddress = await listen(upstream);
    const bufferedResponseCache = new Map<string, Promise<BufferedProtocolResponse>>();
    const requestBody = (sessionMarker: string) => JSON.stringify({
      model: "model-neutral-a",
      max_tokens: 128,
      stream: true,
      system: `ephemeral Claude session ${sessionMarker}`,
      messages: [{ role: "user", content: "recover this turn" }],
      tools: [{
        name: terminalTool,
        input_schema: { type: "object", properties: { target: { type: "string" } } }
      }]
    });

    proxy = await startProtocolProxy({
      sourceProtocol: "anthropic-messages",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret",
      bufferedResponseCache,
      deliveryMode: "buffered-json",
      onUsage: (item) => { usage.push(item); }
    });
    const firstController = new AbortController();
    const first = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": proxy.token },
      body: requestBody("first"),
      signal: firstController.signal
    });
    const firstReader = first.body!.getReader();
    expect((await firstReader.read()).done).toBe(false);
    firstController.abort();
    await firstReader.cancel().catch(() => undefined);
    await delay(950);
    await proxy.close();
    proxy = undefined;

    proxy = await startProtocolProxy({
      sourceProtocol: "anthropic-messages",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret",
      bufferedResponseCache,
      deliveryMode: "buffered-json",
      onUsage: (item) => { usage.push(item); }
    });
    const retryStarted = Date.now();
    const retry = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": proxy.token },
      // A fresh Claude session changes private prompt material, but the
      // invocation still recovers the same undelivered response stage.
      body: requestBody("second")
    });
    const retryBody = await retry.text();

    expect(retry.status).toBe(200);
    expect(retryBody).toContain("复用成功");
    expect(retryBody).toContain(terminalTool);
    expect(retryBody).toContain("event: message_stop");
    expect(Date.now() - retryStarted).toBeLessThan(500);
    expect(upstreamRequests).toBe(1);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 20, outputTokens: 4, totalTokens: 24 });
    expect(bufferedResponseCache.size).toBe(0);
  });

  it("semantically reuses a buffered initial Worker tool response across fresh Claude prompts", async () => {
    let upstreamRequests = 0;
    const appendTool = "mcp__scienceevolve-workspace__scienceevolve_append_file";
    upstream = createServer(async (_request, response) => {
      upstreamRequests += 1;
      await delay(800);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "neutral-recovered-worker",
        model: "model-neutral-a",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_recovered_append",
              type: "function",
              function: {
                name: appendTool,
                arguments: JSON.stringify({
                  path: "worker-report.md",
                  content: "# Worker report\n"
                })
              }
            }]
          },
          finish_reason: "tool_calls"
        }]
      }));
    });
    const upstreamAddress = await listen(upstream);
    const bufferedResponseCache = new Map<string, Promise<BufferedProtocolResponse>>();
    const requestBody = (recoveryPrompt: string) => JSON.stringify({
      model: "model-neutral-a",
      max_tokens: 128,
      stream: true,
      system: recoveryPrompt,
      messages: [{ role: "user", content: "produce the Worker artifact" }],
      tools: [{
        name: appendTool,
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" }
          }
        }
      }]
    });

    proxy = await startProtocolProxy({
      sourceProtocol: "anthropic-messages",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret",
      bufferedResponseCache,
      deliveryMode: "buffered-json"
    });
    const firstController = new AbortController();
    const first = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": proxy.token },
      body: requestBody("first process prompt"),
      signal: firstController.signal
    });
    const firstReader = first.body!.getReader();
    expect((await firstReader.read()).done).toBe(false);
    firstController.abort();
    await firstReader.cancel().catch(() => undefined);
    await delay(950);
    await proxy.close();
    proxy = undefined;

    proxy = await startProtocolProxy({
      sourceProtocol: "anthropic-messages",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret",
      bufferedResponseCache,
      deliveryMode: "buffered-json"
    });
    const retryStarted = Date.now();
    const retry = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": proxy.token },
      body: requestBody("process-recovery attempt 2 with changed prompt text")
    });
    const retryBody = await retry.text();

    expect(retry.status).toBe(200);
    expect(retryBody).toContain(appendTool);
    expect(retryBody).toContain("worker-report.md");
    expect(Date.now() - retryStarted).toBeLessThan(500);
    expect(upstreamRequests).toBe(1);
    expect(bufferedResponseCache.size).toBe(0);
  });

  it("replays an undelivered later Worker turn to a fresh Claude process", async () => {
    let upstreamRequests = 0;
    const readTool = "Read";
    const appendTool = "mcp__scienceevolve-workspace__scienceevolve_append_file";
    upstream = createServer(async (_request, response) => {
      upstreamRequests += 1;
      if (upstreamRequests === 2) await delay(800);
      const tool = upstreamRequests === 1
        ? {
            id: "call_read_evidence",
            name: readTool,
            arguments: JSON.stringify({ file_path: "evidence.md" })
          }
        : {
            id: "call_append_after_read",
            name: appendTool,
            arguments: JSON.stringify({
              path: "worker-report.md",
              content: "# Verified worker report\n"
            })
          };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: `neutral-worker-stage-${upstreamRequests}`,
        model: "model-neutral-a",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: tool.id,
              type: "function",
              function: { name: tool.name, arguments: tool.arguments }
            }]
          },
          finish_reason: "tool_calls"
        }]
      }));
    });
    const upstreamAddress = await listen(upstream);
    const bufferedResponseCache = new Map<string, Promise<BufferedProtocolResponse>>();
    const options = {
      sourceProtocol: "anthropic-messages" as const,
      targetProtocol: "chat-completions" as const,
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret",
      bufferedResponseCache,
      deliveryMode: "buffered-json" as const
    };
    const tools = [
      { name: readTool, input_schema: { type: "object" } },
      { name: appendTool, input_schema: { type: "object" } }
    ];
    const headers = { "content-type": "application/json", "x-api-key": "" };

    proxy = await startProtocolProxy(options);
    headers["x-api-key"] = proxy.token;
    const first = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "model-neutral-a",
        max_tokens: 128,
        stream: true,
        system: "first Claude process",
        messages: [{ role: "user", content: "read, then write" }],
        tools
      })
    });
    expect(await first.text()).toContain(readTool);
    expect(bufferedResponseCache.size).toBe(0);

    const secondController = new AbortController();
    const second = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers,
      signal: secondController.signal,
      body: JSON.stringify({
        model: "model-neutral-a",
        max_tokens: 128,
        stream: true,
        system: "first Claude process",
        messages: [
          { role: "user", content: "read, then write" },
          { role: "assistant", content: [{ type: "tool_use", id: "call_read_evidence", name: readTool, input: { file_path: "evidence.md" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_read_evidence", content: "verified evidence" }] }
        ],
        tools
      })
    });
    const secondReader = second.body!.getReader();
    expect((await secondReader.read()).done).toBe(false);
    secondController.abort();
    await secondReader.cancel().catch(() => undefined);
    await delay(950);
    await proxy.close();
    proxy = undefined;

    proxy = await startProtocolProxy(options);
    headers["x-api-key"] = proxy.token;
    const recoveryStarted = Date.now();
    const recovery = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "model-neutral-a",
        max_tokens: 128,
        stream: true,
        system: "fresh recovery process without the prior transcript",
        messages: [{ role: "user", content: "recover the interrupted work" }],
        tools
      })
    });
    const recoveryBody = await recovery.text();

    expect(recoveryBody).toContain(appendTool);
    expect(recoveryBody).toContain("worker-report.md");
    expect(Date.now() - recoveryStarted).toBeLessThan(500);
    expect(upstreamRequests).toBe(2);
    expect(bufferedResponseCache.size).toBe(0);
  });

  it("delivers a buffered text-only workflow response without forcing or retrying a tool", async () => {
    let upstreamRequests = 0;
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const terminalTool = "mcp__scienceevolve-orchestration-control__route_to_agent";
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(String(chunk)));
      upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      upstreamRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: `neutral-text-${upstreamRequests}`,
        model: "model-neutral-a",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "保留普通文本答复" },
          finish_reason: "stop"
        }]
      }));
    });
    const upstreamAddress = await listen(upstream);
    const bufferedResponseCache = new Map<string, Promise<BufferedProtocolResponse>>();
    proxy = await startProtocolProxy({
      sourceProtocol: "anthropic-messages",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret",
      bufferedResponseCache,
      deliveryMode: "buffered-json"
    });
    const requestBody = JSON.stringify({
      model: "model-neutral-a",
      max_tokens: 128,
      stream: true,
      messages: [{ role: "user", content: "answer normally if no tool is needed" }],
      tools: [{
        name: terminalTool,
        input_schema: { type: "object", properties: { target: { type: "string" } } }
      }]
    });

    const response = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": proxy.token },
      body: requestBody
    });
    const responseBody = await response.text();

    expect(response.status).toBe(200);
    expect(responseBody).toContain("保留普通文本答复");
    expect(responseBody).toContain("event: message_stop");
    expect(upstreamRequests).toBe(1);
    expect(bufferedResponseCache.size).toBe(0);
    expect(upstreamBodies[0]).not.toHaveProperty("tool_choice");
    expect(JSON.stringify(upstreamBodies[0]?.tools)).toContain(terminalTool);
  });

  it("cancels buffered provider work when the outer Agent invocation is cancelled", async () => {
    let upstreamClosed = false;
    let markUpstreamStarted!: () => void;
    const upstreamStarted = new Promise<void>((resolve) => {
      markUpstreamStarted = resolve;
    });
    upstream = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Consume the request before waiting for invocation cancellation.
      }
      response.once("close", () => {
        upstreamClosed = true;
      });
      markUpstreamStarted();
      await new Promise<void>((resolve) => response.once("close", resolve));
    });
    const upstreamAddress = await listen(upstream);
    const invocation = new AbortController();
    const bufferedResponseCache = new Map<string, Promise<BufferedProtocolResponse>>();
    proxy = await startProtocolProxy({
      sourceProtocol: "anthropic-messages",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret",
      bufferedResponseCache,
      deliveryMode: "buffered-json",
      invocationSignal: invocation.signal
    });
    const pending = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": proxy.token },
      body: JSON.stringify({
        model: "model-neutral-a",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "cancel this whole invocation" }],
        tools: [{
          name: "mcp__scienceevolve-orchestration-control__route_to_agent",
          input_schema: { type: "object" }
        }]
      })
    });
    const reader = pending.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await upstreamStarted;

    invocation.abort();
    for (let attempt = 0; attempt < 20 && (!upstreamClosed || bufferedResponseCache.size); attempt += 1) {
      await delay(10);
    }
    await reader.cancel().catch(() => undefined);

    expect(upstreamClosed).toBe(true);
    expect(bufferedResponseCache.size).toBe(0);
  });

  it("buffers Chat-native buffered route tool arguments and normalizes every required field atomically", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const toolName = "mcp__scienceevolve-workspace__scienceevolve_append_file";
    const artifact = "# Invoice audit\n\nAll totals and rounding checks pass.";
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(String(chunk)));
      upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      await delay(500);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "neutral-buffered-tool",
        model: "model-neutral-a",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "append-call-1",
              type: "function",
              function: {
                name: toolName,
                arguments: `<tool_call><function=${toolName}><parameter=path>invoice-analysis.md</parameter><parameter=content>${artifact}</parameter></function></tool_call>`
              }
            }]
          },
          finish_reason: "tool_calls"
        }]
      }));
    });
    const upstreamAddress = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "chat-completions",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret",
      force: true,
      deliveryMode: "buffered-json"
    });
    const started = Date.now();
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({
        model: "model-neutral-a",
        stream: true,
        messages: [{ role: "user", content: "write the audit" }],
        tools: [{
          type: "function",
          function: {
            name: toolName,
            parameters: {
              type: "object",
              properties: { path: { type: "string" }, content: { type: "string" } },
              required: ["path", "content"]
            }
          }
        }]
      })
    });
    expect(Date.now() - started).toBeLessThan(400);
    const body = await response.text();
    const frames = body.split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .filter((line) => line !== "[DONE]")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const argumentText = frames.flatMap((frame) => {
      const choices = Array.isArray(frame.choices) ? frame.choices : [];
      const choice = choices[0] && typeof choices[0] === "object"
        ? choices[0] as Record<string, unknown>
        : {};
      const delta = choice.delta && typeof choice.delta === "object"
        ? choice.delta as Record<string, unknown>
        : {};
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      return calls.flatMap((call) => {
        const fn = call && typeof call === "object" &&
          (call as Record<string, unknown>).function &&
          typeof (call as Record<string, unknown>).function === "object"
          ? (call as Record<string, unknown>).function as Record<string, unknown>
          : {};
        return typeof fn.arguments === "string" ? [fn.arguments] : [];
      });
    }).join("");

    expect(JSON.parse(argumentText)).toEqual({
      path: "invoice-analysis.md",
      content: artifact
    });
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toContain("data: [DONE]");
    expect(upstreamBody?.stream).toBe(false);
  });

  it.each(["responses", "chat-completions", "anthropic-messages"] as const)("preserves reported %s argument errors as feedback for the Agent's next call", async sourceProtocol => {
    const malformed = '{"path":"report.md"} trailing text';
    const toolError = "Tool argument parsing failed; inspect the current state before retrying";
    let received: Record<string, unknown> | undefined;
    upstream = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      received = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "corrected-history", model: "neutral-model", choices: [{ index: 0,
        message: { role: "assistant", content: "The recorded error can now be corrected." }, finish_reason: "stop" }] }));
    });
    const address = await listen(upstream);
    const traces: unknown[] = [];
    proxy = await startProtocolProxy({ sourceProtocol, targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`, force: true,
      onTrace: (...args) => { traces.push(args); } });
    const native = sourceProtocol === "responses" ? { input: [
      { type: "function_call", call_id: "bad-call", name: "state_patch", arguments: malformed },
      { type: "function_call_output", call_id: "bad-call", output: toolError }
    ] } : sourceProtocol === "chat-completions" ? { messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "bad-call", type: "function", function: { name: "state_patch", arguments: malformed } }] },
      { role: "tool", tool_call_id: "bad-call", content: toolError }
    ] } : { messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "bad-call", name: "state_patch", input: malformed }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "bad-call", is_error: true, content: toolError }] }
    ] };
    const response = await fetch(`${proxy.baseUrl}/${sourceProtocol === "responses" ? "responses" : sourceProtocol === "chat-completions" ? "chat/completions" : "messages"}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${proxy.token}`, "x-api-key": proxy.token },
      body: JSON.stringify({ model: "neutral-model", stream: false, ...native }) });
    expect(response.status).toBe(200);
    await response.text();
    const messages = received?.messages as Array<{ content: string; tool_calls?: unknown; role: string }>;
    expect(messages.map(message => message.content).join("\n")).toContain(toolError);
    expect(messages.map(message => message.content).join("\n")).toContain("state_patch");
    expect(messages.every(message => !message.tool_calls && message.role !== "tool")).toBe(true);
    expect(JSON.stringify(traces)).not.toContain("trailing text");
    expect(proxy.getFailure?.()).toBeUndefined();
  });

  it("allows clean native retries after malformed provider arguments and still rejects poisoned history", async () => {
    const malformedArguments = '{"path":"report.md","content":"draft"}\n,\n"description":"extra"';
    let upstreamRequests = 0;
    upstream = createServer(async (request, response) => {
      upstreamRequests += 1;
      for await (const _chunk of request) {
        // Drain the request before responding.
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "neutral-malformed-tool",
        model: "model-neutral-a",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "append-malformed",
              type: "function",
              function: {
                name: "scienceevolve_append_file",
                arguments: upstreamRequests === 1 ? malformedArguments : JSON.stringify({ path: "report.md", content: "corrected draft" })
              }
            }]
          },
          finish_reason: "tool_calls"
        }]
      }));
    });
    const upstreamAddress = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "chat-completions",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret",
      force: true,
      deliveryMode: "buffered-json"
    });
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${proxy.token}`
    };
    const first = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "model-neutral-a",
        stream: true,
        messages: [{ role: "user", content: "write a report" }]
      })
    });
    const firstBody = await first.text();
    expect(firstBody).toContain("invalid JSON tool arguments");
    expect(firstBody).not.toContain(malformedArguments);
    expect(proxy.getFailure?.()).toMatchObject({
      code: "PROTOCOL_TOOL_ARGUMENTS_INVALID",
      toolName: "scienceevolve_append_file",
      sourceProtocol: "chat-completions",
      targetProtocol: "chat-completions"
    });
    expect(upstreamRequests).toBe(1);

    const retried = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "model-neutral-a",
        stream: false,
        messages: [{ role: "user", content: "retry the original clean input" }]
      })
    });
    expect(retried.status).toBe(200);
    expect(JSON.stringify(await retried.json())).toContain("corrected draft");
    expect(proxy.getFailure?.()).toBeUndefined();
    expect(upstreamRequests).toBe(2);

    const second = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "model-neutral-a",
        stream: false,
        messages: [{
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "append-malformed",
            type: "function",
            function: { name: "scienceevolve_append_file", arguments: malformedArguments }
          }]
        }]
      })
    });
    expect(second.status).toBe(502);
    expect(JSON.stringify(await second.json())).toContain("invalid JSON tool arguments");
    expect(proxy.getFailure?.()).toMatchObject({
      code: "PROTOCOL_TOOL_ARGUMENTS_INVALID",
      toolName: "scienceevolve_append_file"
    });
    expect(upstreamRequests).toBe(2);
  });

  it("does not expose malformed streamed tool frames to a Responses-native Harness", async () => {
    upstream = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the request before responding.
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const frames = [{
        id: "chat-malformed-stream",
        object: "chat.completion.chunk",
        model: "model-neutral-a",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call-malformed-stream",
              type: "function",
              function: {
                name: "scienceevolve_append_file",
                arguments: '{"path":"report.md","content":"draft"}'
              }
            }]
          },
          finish_reason: null
        }]
      }, {
        id: "chat-malformed-stream",
        object: "chat.completion.chunk",
        model: "model-neutral-a",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '\n,\n"description":"extra"' }
            }]
          },
          finish_reason: null
        }]
      }, {
        id: "chat-malformed-stream",
        object: "chat.completion.chunk",
        model: "model-neutral-a",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
      }];
      for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    const upstreamAddress = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "responses",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret"
    });

    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${proxy.token}`
      },
      body: JSON.stringify({
        model: "model-neutral-a",
        stream: true,
        input: [{ role: "user", content: "write a report" }],
        tools: [{
          type: "function",
          name: "scienceevolve_append_file",
          parameters: { type: "object" }
        }]
      })
    });
    const body = await response.text();

    expect(body).toContain('"type":"error"');
    expect(body).toContain("invalid JSON tool arguments");
    expect(body).not.toContain("response.function_call_arguments");
    expect(body).not.toContain("report.md");
    expect(proxy.getFailure?.()).toMatchObject({
      code: "PROTOCOL_TOOL_ARGUMENTS_INVALID",
      toolName: "scienceevolve_append_file",
      sourceProtocol: "responses",
      targetProtocol: "chat-completions"
    });
  });

  it("retries a rejected sole required Chat tool with a named choice", async () => {
    const choices: unknown[] = [];
    let unrelatedError = false;
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(String(chunk)));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      choices.push(body.tool_choice);
      if (unrelatedError || body.tool_choice === "required") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: unrelatedError
          ? "invalid model"
          : "tool_choice required is not supported" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chat-named-tool",
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{
          id: "call-finish", type: "function", function: { name: "finish", arguments: "{}" }
        }] }, finish_reason: "tool_calls" }]
      }));
    });
    const upstreamAddress = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "responses",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret"
    });
    const requestBody = JSON.stringify({
      model: "named-only-model",
      input: [{ role: "user", content: "finish" }],
      tools: [{ type: "function", name: "finish", parameters: { type: "object" } }],
      tool_choice: { type: "function", name: "finish" }
    });
    const send = () => fetch(`${proxy!.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${proxy!.token}` },
      body: requestBody
    });

    const accepted = await send();
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ output: [expect.objectContaining({ name: "finish" })] });
    expect(choices).toEqual(["required", { type: "function", function: { name: "finish" } }]);

    unrelatedError = true;
    const rejected = await send();
    expect(rejected.status).toBe(400);
    expect(choices).toHaveLength(3);
  });

  it("forces a terminal tool only until that tool call appears in the conversation", async () => {
    const seen: Record<string, unknown>[] = [];
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(String(chunk)));
      seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(seen.length === 1
        ? {
            id: "chat-required-terminal",
            model: "model-neutral-a",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: "tool-1",
                  type: "function",
                  function: {
                    name: "mcp__scienceevolve-orchestration-control__complete_project",
                    arguments: '{"callId":"complete-1","rationale":"done"}'
                  }
                }]
              },
              finish_reason: "tool_calls"
            }]
          }
        : responseBody("chat-completions")));
    });
    const upstreamAddress = await listen(upstream);
    const terminalTool = "mcp__scienceevolve-orchestration-control__complete_project";
    proxy = await startProtocolProxy({
      sourceProtocol: "anthropic-messages",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret",
      requiredToolName: "complete_project"
    });
    const headers = {
      "content-type": "application/json",
      "x-api-key": proxy.token,
      "anthropic-version": "2023-06-01"
    };
    const tools = [{
      name: terminalTool,
      description: "Complete the project",
      input_schema: { type: "object" }
    }];

    const first = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "model-neutral-a",
        max_tokens: 128,
        messages: [{ role: "user", content: "finish" }],
        tools
      })
    });
    expect(first.status).toBe(200);
    await first.text();
    const second = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "model-neutral-a",
        max_tokens: 128,
        messages: [
          { role: "user", content: "finish" },
          {
            role: "assistant",
            content: [{
              type: "tool_use",
              id: "tool-1",
              name: terminalTool,
              input: { rationale: "done" }
            }]
          },
          {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "staged"
            }]
          }
        ],
        tools
      })
    });
    expect(second.status).toBe(200);
    await second.text();

    expect(seen).toHaveLength(2);
    expect(seen[0]?.tool_choice).toBe("required");
    expect(seen[0]?.tools).toEqual([expect.objectContaining({
      function: expect.objectContaining({ name: terminalTool })
    })]);
    expect(seen[1]).not.toHaveProperty("tool_choice");
  });

  it("routes Codex namespaced MCP tools through Chat and restores the Responses namespace", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const namespace = "mcp__scienceevolve_orchestration_control";
    const toolName = "complete_project";
    const qualifiedName = `${namespace}__${toolName}`;
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(String(chunk)));
      upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chat-codex-mcp",
        model: "model-neutral-a",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call-codex-complete",
              type: "function",
              function: {
                name: qualifiedName,
                arguments: '{"callId":"complete-real","rationale":"done"}'
              }
            }]
          },
          finish_reason: "tool_calls"
        }]
      }));
    });
    const upstreamAddress = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "responses",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret"
    });

    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${proxy.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "model-neutral-a",
        input: [{ role: "user", content: "finish" }],
        tools: [{
          type: "namespace",
          name: "mcp__scienceevolve_orchestration_control",
          tools: [{
            type: "function",
            name: "complete_project",
            description: "Complete the project",
            parameters: {
              type: "object",
              properties: { callId: { type: "string" }, rationale: { type: "string" } },
              required: ["callId", "rationale"],
              additionalProperties: false
            }
          }]
        }]
      })
    });
    const converted = await response.json() as Record<string, unknown>;
    const upstreamTools = upstreamBody?.tools as Array<Record<string, unknown>>;

    expect(response.status).toBe(200);
    expect(upstreamTools).toEqual([{
      type: "function",
      function: expect.objectContaining({ name: qualifiedName })
    }]);
    expect(upstreamBody).not.toHaveProperty("tool_choice");
    expect(converted).toMatchObject({
      output: [expect.objectContaining({
        type: "function_call",
        namespace,
        name: toolName,
        call_id: "call-codex-complete"
      })]
    });
  });

  it("restores a Codex namespace on streamed Chat tool-call items", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const namespace = "mcp__scienceevolve_orchestration_control";
    const toolName = "complete_project";
    const qualifiedName = `${namespace}__${toolName}`;
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(String(chunk)));
      upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        id: "chat-codex-mcp-stream",
        object: "chat.completion.chunk",
        model: "model-neutral-a",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call-codex-complete",
              type: "function",
              function: {
                name: qualifiedName,
                arguments: '{"callId":"complete-real","rationale":"done"}'
              }
            }]
          },
          finish_reason: null
        }]
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chat-codex-mcp-stream",
        object: "chat.completion.chunk",
        model: "model-neutral-a",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
      })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
    const upstreamAddress = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "responses",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret"
    });

    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${proxy.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "model-neutral-a",
        stream: true,
        input: [{ role: "user", content: "finish" }],
        tools: [{
          type: "namespace",
          name: namespace,
          tools: [{
            type: "function",
            name: toolName,
            description: "Complete the project",
            parameters: {
              type: "object",
              properties: { callId: { type: "string" }, rationale: { type: "string" } },
              required: ["callId", "rationale"],
              additionalProperties: false
            }
          }]
        }]
      })
    });
    const text = await response.text();
    const frames = text.split(/\r?\n\r?\n/).flatMap((chunk) => {
      const data = chunk.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") return [];
      return [JSON.parse(data) as Record<string, unknown>];
    });
    const toolItems = frames
      .filter((frame) => frame.type === "response.output_item.added" || frame.type === "response.output_item.done")
      .map((frame) => frame.item);

    expect(response.status).toBe(200);
    expect((upstreamBody?.tools as Array<Record<string, unknown>>)[0]).toEqual({
      type: "function",
      function: expect.objectContaining({ name: qualifiedName })
    });
    expect(upstreamBody).not.toHaveProperty("tool_choice");
    expect(toolItems).toHaveLength(2);
    expect(toolItems).toEqual([
      expect.objectContaining({ type: "function_call", namespace, name: toolName }),
      expect.objectContaining({ type: "function_call", namespace, name: toolName })
    ]);
  });

  it("returns a client tool_search_call when a streamed provider selects discovery", async () => {
    upstream = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain request */ }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        id: "chat-tool-search", object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { tool_calls: [{
          index: 0, id: "call-search", type: "function",
          function: { name: "tool_search", arguments: '{"query":"scienceevolve_read_smoke_sentinel"}' }
        }] }, finish_reason: null }]
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chat-tool-search", object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    const upstreamAddress = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "responses", targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`, gatewayApiKey: "upstream-secret"
    });
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-terra", stream: true,
        input: [{ role: "user", content: "Find sentinel" }],
        tools: [{ type: "tool_search", execution: "client",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }]
      })
    });
    const frames = (await response.text()).split(/\r?\n\r?\n/).flatMap((chunk) => {
      const data = chunk.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
      return data && data !== "[DONE]" ? [JSON.parse(data) as Record<string, unknown>] : [];
    });
    expect(response.status).toBe(200);
    expect(frames.filter((frame) => frame.type === "response.output_item.done")).toEqual([
      expect.objectContaining({ item: expect.objectContaining({
        type: "tool_search_call", execution: "client", call_id: "call-search",
        arguments: { query: "scienceevolve_read_smoke_sentinel" }
      }) })
    ]);
  });

  it("keeps the complete Harness tool catalog available after Main control decisions", async () => {
    const seen: Record<string, unknown>[] = [];
    const routeTool = "mcp__scienceevolve-orchestration-control__route_to_agent";
    const displayTool = "mcp__scienceevolve-orchestration-control__select_display";
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(String(chunk)));
      seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/json" });
      const toolCall = seen.length === 1
        ? {
            id: "display-call-1",
            name: displayTool,
            arguments: JSON.stringify({
              callId: "display-before-terminal",
              primary: { agent: "analyst", path: "report.md", title: "Report" },
              items: []
            })
          }
        : seen.length === 2
          ? {
              id: "route-call-1",
              name: routeTool,
              arguments: JSON.stringify({
                callId: "terminal-route",
                target: "analyst",
                assignment: "verify"
              })
            }
          : undefined;
      response.end(JSON.stringify(toolCall
        ? {
            id: `chat-tool-${seen.length}`,
            model: "model-neutral-a",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: toolCall.id,
                  type: "function",
                  function: {
                    name: toolCall.name,
                    arguments: toolCall.arguments
                  }
                }]
              },
              finish_reason: "tool_calls"
            }]
          }
        : responseBody("chat-completions")));
    });
    const upstreamAddress = await listen(upstream);
    const bufferedResponseCache = new Map<string, Promise<BufferedProtocolResponse>>();
    proxy = await startProtocolProxy({
      sourceProtocol: "anthropic-messages",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret",
      deliveryMode: "buffered-json",
      bufferedResponseCache
    });
    const headers = {
      "content-type": "application/json",
      "x-api-key": proxy.token,
      "anthropic-version": "2023-06-01"
    };
    const tools = [
      { name: "mcp__scienceevolve-workspace__scienceevolve_append_file", input_schema: { type: "object" } },
      { name: displayTool, input_schema: { type: "object" } },
      { name: routeTool, input_schema: { type: "object" } },
      { name: "mcp__scienceevolve-orchestration-control__request_user", input_schema: { type: "object" } },
      { name: "mcp__scienceevolve-orchestration-control__complete_project", input_schema: { type: "object" } }
    ];

    const first = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "model-neutral-a",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "decide" }],
        tools
      })
    });
    expect(first.status).toBe(200);
    await first.text();
    const second = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "model-neutral-a",
        max_tokens: 128,
        stream: true,
        messages: [
          { role: "user", content: "decide" },
          { role: "assistant", content: [{ type: "tool_use", id: "display-call-1", name: displayTool, input: { callId: "display-before-terminal", primary: { agent: "analyst", path: "report.md", title: "Report" }, items: [] } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "display-call-1", content: "staged" }] }
        ],
        tools
      })
    });
    expect(second.status).toBe(200);
    await second.text();

    const third = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "model-neutral-a",
        max_tokens: 128,
        stream: true,
        messages: [
          { role: "user", content: "decide" },
          { role: "assistant", content: [{ type: "tool_use", id: "display-call-1", name: displayTool, input: { callId: "display-before-terminal", primary: { agent: "analyst", path: "report.md", title: "Report" }, items: [] } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "display-call-1", content: "staged" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "route-call-1", name: routeTool, input: { callId: "terminal-route", target: "analyst", assignment: "verify" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "route-call-1", content: "staged" }] }
        ],
        tools
      })
    });
    expect(third.status).toBe(200);
    await third.text();

    expect(seen).toHaveLength(3);
    for (const request of seen) {
      expect(request).not.toHaveProperty("tool_choice");
      expect(JSON.stringify(request.tools)).toContain("scienceevolve_append_file");
      expect(JSON.stringify(request.tools)).toContain("select_display");
      expect(JSON.stringify(request.tools)).toContain("route_to_agent");
      expect(JSON.stringify(request.tools)).toContain("request_user");
      expect(JSON.stringify(request.tools)).toContain("complete_project");
    }
    expect(seen[0]?.stream).toBe(false);
  });

  it("surfaces an upstream stream that closes without a terminal event", async () => {
    upstream = createServer(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
      response.end();
    });
    const upstreamAddress = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "responses",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret"
    });

    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify(sourceBody("responses", true))
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("partial");
    expect(body).toContain("上游流在终止事件前结束");
    expect(body).not.toContain('"status":"completed"');
  });

  it("preserves Responses lifecycle IDs and closes a streamed Chat tool call", async () => {
    upstream = createServer(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        id: "chat-tool",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: '{"q":' }
            }]
          },
          finish_reason: null
        }]
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chat-tool",
        choices: [{
          delta: {
            tool_calls: [{ index: 0, function: { arguments: "\"x\"}" } }]
          },
          finish_reason: null
        }]
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chat-tool",
        choices: [{ delta: {}, finish_reason: "tool_calls" }]
      })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
    const upstreamAddress = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "responses",
      targetProtocol: "chat-completions",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret"
    });

    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({ ...sourceBody("responses", true), tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] })
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    const frames = body.split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .filter((line) => line !== "[DONE]")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(frames[0]).toMatchObject({ type: "response.created", response: { id: expect.any(String), status: "in_progress" } });
    expect(frames.some((frame) => frame.type === "response.function_call_arguments.delta")).toBe(true);
    expect(frames.some((frame) => frame.type === "response.function_call_arguments.done")).toBe(true);
    expect(frames.some((frame) => frame.type === "response.output_item.done")).toBe(true);
    const createdId = (frames[0]?.response as Record<string, unknown> | undefined)?.id;
    const terminal = frames.at(-1);
    expect(terminal).toMatchObject({ type: "response.completed", response: { id: createdId, status: "completed" } });
    expect(body).not.toContain('"type":"response.incomplete"');
  });

  it("keeps the Responses call_id distinct from item_id when streaming to Chat", async () => {
    upstream = createServer(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "fc-item-1",
            type: "function_call",
            call_id: "call-result-1",
            name: "lookup",
            arguments: ""
          }
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc-item-1",
          delta: '{"q":'
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          item_id: "fc-item-1",
          arguments: '{"q":"x"}'
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "fc-item-1",
            type: "function_call",
            call_id: "call-result-1",
            name: "lookup",
            arguments: '{"q":"x"}'
          }
        },
        {
          type: "response.completed",
          response: { id: "resp-tool", status: "completed" }
        }
      ]) response.write(`data: ${JSON.stringify(frame)}\n\n`);
      response.end();
    });
    const upstreamAddress = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "chat-completions",
      targetProtocol: "responses",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret"
    });

    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({
        ...sourceBody("chat-completions", true),
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }]
      })
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    const frames = body.split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .filter((line) => line !== "[DONE]")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const toolIds = frames.flatMap((frame) => {
      const choices = Array.isArray(frame.choices) ? frame.choices : [];
      const choice = choices[0] && typeof choices[0] === "object"
        ? choices[0] as Record<string, unknown>
        : {};
      const delta = choice.delta && typeof choice.delta === "object"
        ? choice.delta as Record<string, unknown>
        : {};
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      return calls.flatMap((call) =>
        call && typeof call === "object" && typeof (call as Record<string, unknown>).id === "string"
          ? [String((call as Record<string, unknown>).id)]
          : []
      );
    });
    expect(toolIds.length).toBeGreaterThan(0);
    expect(new Set(toolIds)).toEqual(new Set(["call-result-1"]));
    expect(body).not.toContain("fc-item-1");
    expect(frames.at(-1)).toMatchObject({
      choices: [{ finish_reason: "tool_calls" }]
    });
    expect(body).toContain("data: [DONE]");
  });

  it("does not reopen Anthropic tool blocks for duplicate Responses terminal frames", async () => {
    const calls = [
      { index: 0, itemId: "fc-1", callId: "call-1", name: "read_one", arguments: '{"path":"one"}' },
      { index: 1, itemId: "fc-2", callId: "call-2", name: "read_two", arguments: '{"path":"two"}' },
      { index: 2, itemId: "fc-3", callId: "call-3", name: "read_three", arguments: '{"path":"three"}' }
    ];
    upstream = createServer(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const call of calls) {
        for (const frame of [
          {
            type: "response.output_item.added",
            output_index: call.index,
            item: {
              id: call.itemId,
              type: "function_call",
              call_id: call.callId,
              name: call.name,
              arguments: ""
            }
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: call.index,
            item_id: call.itemId,
            delta: call.arguments
          },
          {
            type: "response.function_call_arguments.done",
            output_index: call.index,
            item_id: call.itemId,
            arguments: call.arguments
          }
        ]) response.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
      for (const call of calls) {
        response.write(`data: ${JSON.stringify({
          type: "response.output_item.done",
          output_index: call.index,
          item: {
            id: call.itemId,
            type: "function_call",
            call_id: call.callId,
            name: call.name,
            arguments: call.arguments
          }
        })}\n\n`);
      }
      response.write(`data: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp-tools", status: "completed" }
      })}\n\n`);
      response.end();
    });
    const upstreamAddress = await listen(upstream);
    proxy = await startProtocolProxy({
      sourceProtocol: "anthropic-messages",
      targetProtocol: "responses",
      gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      gatewayApiKey: "upstream-secret"
    });

    const response = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": proxy.token,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        ...sourceBody("anthropic-messages", true),
        tools: calls.map((call) => ({
          name: call.name,
          input_schema: { type: "object" }
        }))
      })
    });
    const body = await response.text();
    const frames = body.split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
    const startedIds = frames.flatMap((frame) => {
      if (frame.type !== "content_block_start") return [];
      const block = frame.content_block && typeof frame.content_block === "object"
        ? frame.content_block as Record<string, unknown>
        : {};
      return block.type === "tool_use" && typeof block.id === "string" ? [block.id] : [];
    });

    expect(startedIds).toEqual(calls.map((call) => call.callId));
    expect(new Set(startedIds).size).toBe(calls.length);
    expect(frames.at(-1)).toMatchObject({ type: "message_stop" });
  });

  it("preserves system/developer messages, tool calls/results, usage and stop reasons", async () => {
    const seen: Array<{ path: string; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }> = [];
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(String(chunk)));
      seen.push({
        path: request.url ?? "",
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        headers: request.headers
      });
      const target = request.url?.endsWith("/responses")
        ? "responses"
        : request.url?.endsWith("/chat/completions")
          ? "chat-completions"
          : "anthropic-messages" as AgentProtocol;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(target === "responses"
        ? { id: "r", model: "nex-agi/Nex-N2-Pro", status: "completed", output_text: "ok", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }
        : target === "chat-completions"
          ? { id: "c", model: "nex-agi/Nex-N2-Pro", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }
          : { id: "a", model: "nex-agi/Nex-N2-Pro", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } }
      ));
    });
    const upstreamAddress = await listen(upstream);
    const messages = [
      { role: "system" as const, content: "system rules" },
      { role: "developer" as const, content: "developer rules" },
      { role: "user" as const, content: "question" },
      { role: "assistant" as const, content: "", toolCalls: [{ id: "call-1", name: "lookup", arguments: '{"q":"x"}' }] },
      { role: "tool" as const, toolCallId: "call-1", content: "tool result" }
    ];
    for (const source of protocols) {
      for (const target of protocols) {
        if (source === target) continue;
        proxy = await startProtocolProxy({
          sourceProtocol: source,
          targetProtocol: target,
          gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
          gatewayApiKey: "upstream-secret"
        });
        const sourceRequest = source === "responses"
          ? { model: "nex-agi/Nex-N2-Pro", instructions: "developer rules", input: [
              { role: "user", content: "question" },
              { type: "function_call", call_id: "call-1", name: "lookup", arguments: '{"q":"x"}' },
              { type: "function_call_output", call_id: "call-1", output: "tool result" }
            ], tools: [{ type: "function", name: "lookup", description: "look up", parameters: { type: "object" } }] }
          : source === "chat-completions"
            ? { model: "nex-agi/Nex-N2-Pro", messages: [
                { role: "system", content: "system rules" }, { role: "developer", content: "developer rules" },
                { role: "user", content: "question" }, { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }] },
                { role: "tool", tool_call_id: "call-1", content: "tool result" }
              ], tools: [{ type: "function", function: { name: "lookup", description: "look up", parameters: { type: "object" } } }] }
            : { model: "nex-agi/Nex-N2-Pro", system: "system rules\ndeveloper rules", messages: [
                { role: "user", content: "question" }, { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "lookup", input: { q: "x" } }] },
                { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "tool result" }] }
              ], tools: [{ name: "lookup", description: "look up", input_schema: { type: "object" } }], max_tokens: 128 };
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (source === "anthropic-messages") headers["x-api-key"] = proxy.token;
        else headers.authorization = `Bearer ${proxy.token}`;
        const response = await fetch(`${proxy.baseUrl}${source === "chat-completions" ? "/chat/completions" : source === "responses" ? "/responses" : "/messages"}`, {
          method: "POST", headers, body: JSON.stringify(sourceRequest)
        });
        expect(response.status).toBe(200);
        const body = await response.json() as Record<string, unknown>;
        expect(body.model).toBe("nex-agi/Nex-N2-Pro");
        if (source === "responses") expect(body.object).toBe("response");
        if (source === "chat-completions") expect(body.choices).toBeTruthy();
        if (source === "anthropic-messages") expect(body.content).toBeTruthy();
        await proxy.close();
        proxy = undefined;
      }
    }
    expect(seen).toHaveLength(6);
    for (const item of seen) {
      expect(item.body.tools).toBeTruthy();
      expect(JSON.stringify(item.body)).toContain("call-1");
      expect(item.headers.authorization ?? item.headers["x-api-key"]).toBeTruthy();
    }
  });

  it("maps upstream errors and retries independently for all six directed pairs", async () => {
    let mode: "error" | "retry" = "error";
    let requests = 0;
    upstream = createServer(async (request, response) => {
      requests += 1;
      if (mode === "error") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "bad credential" } }));
        return;
      }
      if (requests === 1) {
        response.destroy();
        return;
      }
      const target = request.url?.endsWith("/responses")
        ? "responses"
        : request.url?.endsWith("/chat/completions")
          ? "chat-completions"
          : "anthropic-messages" as AgentProtocol;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody(target)));
    });
    const upstreamAddress = await listen(upstream);

    for (const source of protocols) {
      for (const target of protocols) {
        if (source === target) continue;
        proxy = await startProtocolProxy({
          sourceProtocol: source,
          targetProtocol: target,
          gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
          gatewayApiKey: "upstream-secret"
        });
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (source === "anthropic-messages") headers["x-api-key"] = proxy.token;
        else headers.authorization = `Bearer ${proxy.token}`;
        const url = `${proxy.baseUrl}${sourcePath[source].slice(3)}`;

        mode = "error";
        requests = 0;
        let response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(sourceBody(source, false))
        });
        expect(response.status, `${source}->${target} error status`).toBe(401);
        expect(JSON.stringify(await response.json()), `${source}->${target} error body`).toContain("bad credential");

        mode = "retry";
        requests = 0;
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(sourceBody(source, false))
        });
        expect(response.status, `${source}->${target} retry status`).toBe(200);
        expect(requests, `${source}->${target} retry attempts`).toBe(2);
        await proxy.close();
        proxy = undefined;
      }
    }
  });

  it.each(protocols.flatMap(source => protocols.filter(target => target !== source).map(target => ({ source, target }))))(
    "enforces timeout and caller cancellation independently ($source -> $target)", async ({ source, target }) => {
      let upstreamAborted = false;
      upstream = createServer(async (request, response) => {
        request.once("aborted", () => { upstreamAborted = true; });
        request.once("close", () => { if (!response.writableEnded) upstreamAborted = true; });
        await delay(2_000);
        if (response.destroyed) return;
        const target = request.url?.endsWith("/responses")
          ? "responses"
          : request.url?.endsWith("/chat/completions")
            ? "chat-completions"
            : "anthropic-messages" as AgentProtocol;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(responseBody(target)));
      });
      const upstreamAddress = await listen(upstream);

      const headersFor = (token: string): Record<string, string> => source === "anthropic-messages"
        ? { "content-type": "application/json", "x-api-key": token }
        : { "content-type": "application/json", authorization: `Bearer ${token}` };

      upstreamAborted = false;
      const timeoutTraces: Array<{
        kind: "status" | "error";
        message: string;
        data?: Record<string, unknown>;
      }> = [];
      proxy = await startProtocolProxy({
        sourceProtocol: source,
        targetProtocol: target,
        gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
        gatewayApiKey: "upstream-secret",
        timeoutMs: 1_000,
        onTrace: (kind, message, data) => { timeoutTraces.push({ kind, message, data }); }
      });
      let response = await fetch(`${proxy.baseUrl}${sourcePath[source].slice(3)}`, {
        method: "POST",
        headers: headersFor(proxy.token),
        body: JSON.stringify(sourceBody(source, false))
      });
      expect(response.status, `${source}->${target} timeout status`).toBe(504);
      expect(JSON.stringify(await response.json())).toContain("cancelled or timed out");
      await vi.waitFor(
        () => expect(upstreamAborted, `${source}->${target} timeout abort`).toBe(true),
        { timeout: 1_000, interval: 10 }
      );
      expect(timeoutTraces).toContainEqual(expect.objectContaining({
        kind: "error",
        message: "Protocol proxy upstream request failed",
        data: expect.objectContaining({
          diagnosticKind: "proxy.upstream.timeout",
          failureCode: "PROVIDER_TRANSPORT_IDLE_TIMEOUT",
          abortSource: "proxy-timeout",
          timedOut: true,
          deadlineType: "provider-transport-idle",
          timeoutMs: 1_000,
          elapsedMs: expect.any(Number),
          receivedProviderFrame: false,
          providerCompleted: false
        })
      }));
      await proxy.close();
      proxy = undefined;

      upstreamAborted = false;
      const cancellationTraces: Array<{
        kind: "status" | "error";
        message: string;
        data?: Record<string, unknown>;
      }> = [];
      proxy = await startProtocolProxy({
        sourceProtocol: source,
        targetProtocol: target,
        gatewayUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
        gatewayApiKey: "upstream-secret",
        timeoutMs: 5_000,
        onTrace: (kind, message, data) => { cancellationTraces.push({ kind, message, data }); }
      });
      const controller = new AbortController();
      const requestPromise = fetch(`${proxy.baseUrl}${sourcePath[source].slice(3)}`, {
        method: "POST",
        headers: headersFor(proxy.token),
        body: JSON.stringify(sourceBody(source, false)),
        signal: controller.signal
      });
      await delay(30);
      controller.abort();
      await expect(requestPromise, `${source}->${target} caller cancellation`).rejects.toThrow();
      await vi.waitFor(
        () => expect(upstreamAborted, `${source}->${target} caller abort`).toBe(true),
        { timeout: 1_000, interval: 10 }
      );
      expect(cancellationTraces.some((trace) =>
        trace.kind === "status" &&
        (trace.message === "Protocol proxy client request aborted" ||
          trace.message === "Protocol proxy client response closed")
      )).toBe(true);
      expect(cancellationTraces).toContainEqual(expect.objectContaining({
        kind: "status",
        message: "Protocol proxy upstream request cancelled after client disconnected",
        data: expect.objectContaining({
          diagnosticKind: "proxy.client.disconnected",
          failureCode: "CLIENT_DISCONNECTED",
          abortSource: "client",
          timedOut: false,
          elapsedMs: expect.any(Number),
          providerCompleted: false
        })
      }));
      expect(cancellationTraces.some((trace) => trace.kind === "error")).toBe(false);
      await proxy.close();
      proxy = undefined;
  }, 30_000);
});
