import { describe, expect, it } from "vitest";
import {
  convertProtocolResponse,
  convertStreamEvent,
  mapProtocolError,
  nativeWebSearchRequest,
  normalizeGatewayTokenUsage,
  normalizeIncomingRequest,
  normalizeProtocolStreamEvents,
  normalizeProtocolStreamEvent,
  routeProtocolRequest,
  startProtocolProxy,
  validateToolArguments
} from "../src/protocol-router.js";
import type { AgentProtocol } from "../src/agent-runtime.js";
import {
  GATEWAY_REASONING_PARAMETER_PATHS,
  type GatewayReasoningParameterPath,
  type ResolvedGatewayReasoning
} from "../src/gateway-reasoning.js";
import { createServer } from "node:http";
import { validatePublicWebNetworkTarget } from "../src/gateway-security.js";

const request = {
  model: "nex-agi/Nex-N2-Pro",
  messages: [
    { role: "system" as const, content: "Follow the project rules." },
    { role: "user" as const, content: "Inspect the evidence." }
  ],
  tools: [{ name: "finish", description: "Finish", inputSchema: { type: "object" } }],
  stream: true,
  maxOutputTokens: 128
};

const reasoningMatrixHarnesses = [
  { harness: "codex", sourceProtocol: "responses" },
  { harness: "claude-code", sourceProtocol: "anthropic-messages" },
  { harness: "pi", sourceProtocol: "chat-completions" },
  { harness: "dsh", sourceProtocol: "chat-completions" }
] as const satisfies ReadonlyArray<{ harness: string; sourceProtocol: AgentProtocol }>;

const reasoningMatrixOptions = [
  { parameter: "reasoning_effort", targetProtocol: "chat-completions" },
  { parameter: "reasoning.effort", targetProtocol: "responses" },
  { parameter: "chat_template_kwargs.reasoning_effort", targetProtocol: "anthropic-messages" },
  { parameter: "thinking.effort", targetProtocol: "chat-completions" }
] as const satisfies ReadonlyArray<{
  parameter: GatewayReasoningParameterPath;
  targetProtocol: AgentProtocol;
}>;

function nativeReasoningMatrixRequest(
  protocol: AgentProtocol,
  mode: "resident" | "one-shot"
): Record<string, unknown> {
  const common = {
    model: "reasoning-matrix-model",
    stream: mode === "resident",
    reasoning_effort: "adapter-shadow",
    reasoning: { effort: "adapter-shadow" },
    chat_template_kwargs: { reasoning_effort: "adapter-shadow" },
    thinking: { effort: "adapter-shadow" }
  };
  if (protocol === "responses") {
    return { ...common, input: [{ role: "user", content: "matrix" }] };
  }
  if (protocol === "anthropic-messages") {
    return { ...common, messages: [{ role: "user", content: "matrix" }], max_tokens: 64 };
  }
  return { ...common, messages: [{ role: "user", content: "matrix" }], max_tokens: 64 };
}

function valueAtPath(body: Record<string, unknown>, path: GatewayReasoningParameterPath): unknown {
  return path.split(".").reduce<unknown>((current, segment) =>
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)[segment]
      : undefined, body);
}

function countScalar(value: unknown, expected: string): number {
  if (value === expected) return 1;
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countScalar(item, expected), 0);
  }
  if (value && typeof value === "object") {
    return Object.values(value).reduce(
      (total, item) => total + countScalar(item, expected),
      0
    );
  }
  return 0;
}

describe("local protocol router", () => {
  it("uses each Gateway protocol's native search shape without forcing tool_choice", () => {
    const responses = nativeWebSearchRequest("responses", "model-a", "query", "secret");
    expect(responses.body).toMatchObject({ tools: [{ type: "web_search" }], stream: false });
    expect(responses.body).not.toHaveProperty("tool_choice");

    const chat = nativeWebSearchRequest("chat-completions", "model-a", "query", "secret");
    expect(chat.body).toMatchObject({ web_search_options: { search_context_size: "medium" }, stream: false });
    expect(chat.body).not.toHaveProperty("tool_choice");

    const reasonedChat = nativeWebSearchRequest(
      "chat-completions",
      "model-a",
      "query",
      "secret",
      {
        mode: "option",
        optionId: "highest",
        label: "Highest",
        value: "max",
        parameter: "chat_template_kwargs.reasoning_effort",
        fingerprint: "a".repeat(64)
      }
    );
    expect(reasonedChat.body).toMatchObject({
      chat_template_kwargs: { reasoning_effort: "max" }
    });

    const anthropic = nativeWebSearchRequest("anthropic-messages", "model-a", "query", "secret");
    expect(anthropic.body).toMatchObject({
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]
    });
    expect(anthropic.body).not.toHaveProperty("tool_choice");
  });

  it("rejects private destinations for server-side Web Fetch", async () => {
    await expect(validatePublicWebNetworkTarget(
      "https://internal.example.test/page",
      async () => ["10.20.30.40"]
    )).rejects.toThrow("不能指向内网");
  });

  it("serves authenticated Web Search MCP tools through the invocation Gateway route", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const upstream = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        upstreamBody = JSON.parse(raw) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "resp_web",
          object: "response",
          model: "fixture-model",
          status: "completed",
          output: [{
            type: "message",
            role: "assistant",
            content: [{
              type: "output_text",
              text: "A cited result.",
              annotations: [{
                type: "url_citation",
                url: "https://example.com/result",
                title: "Example result"
              }]
            }]
          }]
        }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("fixture upstream did not listen");
    const proxy = await startProtocolProxy({
      sourceProtocol: "chat-completions",
      targetProtocol: "responses",
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`,
      gatewayApiKey: "upstream-secret",
      webSearchModel: "fixture-model",
      webSearchEnabled: true,
      force: true,
      validateGatewayTarget: async () => undefined
    });
    const call = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await fetch(`${proxy.baseUrl}/web-mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${proxy.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params })
      });
      expect(response.status).toBe(200);
      return await response.json() as Record<string, any>;
    };
    try {
      const listing = await call("tools/list");
      expect(listing.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "web_search",
        "web_fetch"
      ]);
      const result = await call("tools/call", {
        name: "web_search",
        arguments: { query: "fixture query", maxResults: 3 }
      });
      expect(result.result.isError).toBe(false);
      expect(result.result.content[0].text).toContain("https://example.com/result");
      expect(upstreamBody).toMatchObject({
        model: "fixture-model",
        tools: [{ type: "web_search" }],
        stream: false
      });
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects the Web MCP route when the invocation UI switch is disabled", async () => {
    const proxy = await startProtocolProxy({
      sourceProtocol: "chat-completions",
      targetProtocol: "responses",
      gatewayUrl: "http://127.0.0.1:9/v1",
      gatewayApiKey: "upstream-secret",
      webSearchModel: "fixture-model",
      webSearchEnabled: false,
      force: true,
      validateGatewayTarget: async () => undefined
    });
    try {
      const response = await fetch(`${proxy.baseUrl}/web-mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${proxy.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("disabled");
    } finally {
      await proxy.close();
    }
  });

  it("records a provider SSE error without leaking either Gateway credential", async () => {
    let secret = "";
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ type: "error", error: { message: `capacity exhausted upstream-fixture-key ${secret}` } })}\n\n`);
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("fixture upstream did not listen");
    const traces: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const proxy = await startProtocolProxy({ sourceProtocol: "responses", targetProtocol: "responses",
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`, gatewayApiKey: "upstream-fixture-key", force: true,
      validateGatewayTarget: async () => undefined, onTrace: (_kind, message, data) => { traces.push({ message, data }); } });
    secret = proxy.token;
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST",
        headers: { Authorization: `Bearer ${proxy.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "fixture-model", input: "test", stream: true }) });
      await response.text();
      const error = traces.find(trace => trace.message === "Protocol proxy received a provider stream error");
      expect(error?.data?.error).toContain("capacity exhausted");
      expect(JSON.stringify(error)).not.toContain("upstream-fixture-key");
      expect(JSON.stringify(error)).not.toContain(proxy.token);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    }
  });

  it("validates tool argument envelopes without taking over tool semantics", () => {
    expect(validateToolArguments('{"path":"report.md","content":"ok"}')).toEqual({
      valid: true,
      normalized: '{"path":"report.md","content":"ok"}'
    });
    expect(validateToolArguments(
      '{"path":"report.md"}\n,\n"description":"trailing data"'
    )).toMatchObject({ valid: false });
    expect(validateToolArguments("[]")).toEqual({
      valid: false,
      reason: "tool arguments must be a JSON object"
    });
    expect(validateToolArguments(
      "<tool_call><function=write><parameter=path>report.md</parameter></function></tool_call>",
      "write"
    )).toEqual({
      valid: true,
      normalized: '{"path":"report.md"}'
    });
  });

  it("keeps optional recovery fields optional when routing to Responses", () => {
    const parameters = { type: "object", additionalProperties: false,
      properties: { operation: { type: "string" }, repairNodeId: { type: "string" } }, required: ["operation"] };
    const routed = routeProtocolRequest({ ...request, tools: [{ name: "retry_member", inputSchema: parameters }] }, "responses");
    expect(routed.body.tools).toEqual([{ type: "function", name: "retry_member", description: undefined, parameters, strict: false }]);
    expect(parameters.required).toEqual(["operation"]);
  });

  it.each([true, false])("preserves an explicit strict=%s through namespaced and flat tool conversions", strict => {
    const parameters = { type: "object", additionalProperties: false, properties: { operation: { type: "string" } }, required: ["operation"] };
    for (const tools of [
      [{ type: "function", name: "retry_member", parameters, strict }],
      [{ type: "function", function: { name: "retry_member", parameters, strict } }],
      [{ type: "namespace", name: "mcp", tools: [{ type: "function", name: "retry_member", parameters, strict }] }]
    ]) {
      const normalized = normalizeIncomingRequest({ model: "fixture-model", input: "test", tools }, "responses");
      expect(normalized.tools?.[0]?.strict).toBe(strict);
      expect((routeProtocolRequest(normalized, "responses").body.tools as Array<Record<string, unknown>>)[0]?.strict).toBe(strict);
      const chat = routeProtocolRequest(normalized, "chat-completions");
      expect((chat.body.tools as Array<{ function: { strict: boolean } }>)[0]?.function.strict).toBe(strict);
      const roundTrip = normalizeIncomingRequest(chat.body, "chat-completions");
      expect(roundTrip.tools?.[0]?.strict).toBe(strict);
    }
  });

  it("rejects a link-local metadata upstream before opening an invocation-local proxy", async () => {
    await expect(startProtocolProxy({
      sourceProtocol: "responses",
      targetProtocol: "chat-completions",
      gatewayUrl: "https://169.254.169.254/v1",
      gatewayApiKey: "secret"
    })).rejects.toThrow("被禁止的本机、链路本地、元数据、CGNAT、组播或保留地址");
  });

  it("maps common messages and tools into all three provider protocols", () => {
    const forcedRequest = { ...request, requiredToolName: "finish" };
    const responses = routeProtocolRequest(forcedRequest, "responses", "secret");
    expect(responses.endpointSuffix).toBe("responses");
    expect(responses.body).toMatchObject({ model: request.model, stream: true, max_output_tokens: 128 });
    expect(responses.body.tools).toEqual([expect.objectContaining({ type: "function", name: "finish" })]);
    expect(responses.body.tool_choice).toEqual({ type: "function", name: "finish" });

    const chat = routeProtocolRequest(forcedRequest, "chat-completions", "secret");
    expect(chat.endpointSuffix).toBe("chat/completions");
    expect(chat.body).toMatchObject({
      model: request.model,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 128
    });
    expect(chat.body.tools).toEqual([expect.objectContaining({ function: expect.objectContaining({ name: "finish" }) })]);
    expect(chat.body.tool_choice).toBe("required");

    const anthropic = routeProtocolRequest(forcedRequest, "anthropic-messages", "secret");
    expect(anthropic.endpointSuffix).toBe("messages");
    expect(anthropic.headers).toMatchObject({ "x-api-key": "secret", "anthropic-version": "2023-06-01" });
    expect(anthropic.body).toMatchObject({ system: "Follow the project rules.", max_tokens: 128 });
    expect(anthropic.body.tools).toEqual([expect.objectContaining({ name: "finish", input_schema: { type: "object" } })]);
    expect(anthropic.body.tool_choice).toEqual({ type: "tool", name: "finish" });

    expect(routeProtocolRequest({ ...request, requireTool: true }, "responses").body.tool_choice).toBe("required");
    expect(routeProtocolRequest({ ...request, requireTool: true }, "chat-completions").body.tool_choice).toBe("required");
    expect(routeProtocolRequest({ ...request, requireTool: true }, "anthropic-messages").body.tool_choice).toEqual({ type: "any" });

    const multipleTools = { ...forcedRequest, tools: [...request.tools, { name: "other", description: "Other", inputSchema: { type: "object" } }] };
    expect(routeProtocolRequest(multipleTools, "chat-completions").body.tool_choice).toEqual({
      type: "function", function: { name: "finish" }
    });
    expect(routeProtocolRequest({ ...forcedRequest, requiredToolName: "missing" }, "chat-completions").body.tool_choice).toEqual({
      type: "function", function: { name: "missing" }
    });
  });

  it("applies the resolved Gateway reasoning string after every protocol conversion", () => {
    const baseReasoning = {
      mode: "option" as const,
      optionId: "high",
      label: "High",
      value: "xhigh",
      fingerprint: "a".repeat(64)
    };
    expect(routeProtocolRequest({
      ...request,
      gatewayReasoning: { ...baseReasoning, parameter: "reasoning_effort" }
    }, "chat-completions").body).toMatchObject({ reasoning_effort: "xhigh" });
    expect(routeProtocolRequest({
      ...request,
      gatewayReasoning: { ...baseReasoning, parameter: "reasoning.effort" }
    }, "responses").body).toMatchObject({ reasoning: { effort: "xhigh" } });
    expect(routeProtocolRequest({
      ...request,
      gatewayReasoning: {
        ...baseReasoning,
        parameter: "chat_template_kwargs.reasoning_effort"
      }
    }, "anthropic-messages").body).toMatchObject({
      chat_template_kwargs: { reasoning_effort: "xhigh" }
    });
    expect(routeProtocolRequest({ ...request }, "responses").body)
      .not.toHaveProperty("reasoning");
    expect(routeProtocolRequest({ ...request }, "chat-completions").body)
      .not.toHaveProperty("reasoning_effort");
  });

  it.each(reasoningMatrixHarnesses.flatMap(({ harness, sourceProtocol }) =>
    (["resident", "one-shot"] as const).flatMap((mode) =>
      reasoningMatrixOptions.map(({ parameter, targetProtocol }, optionIndex) => ({
        harness,
        sourceProtocol,
        mode,
        parameter,
        targetProtocol,
        optionIndex
      }))
    )
  ))("keeps $harness $mode final outbound reasoning solely at $parameter", ({
    harness,
    sourceProtocol,
    mode,
    parameter,
    targetProtocol,
    optionIndex
  }) => {
    const normalized = normalizeIncomingRequest(
      nativeReasoningMatrixRequest(sourceProtocol, mode),
      sourceProtocol
    );
    const value = `gateway-${harness}-${mode}-${optionIndex}`;
    const reasoning: ResolvedGatewayReasoning = {
      mode: "option",
      optionId: `option-${optionIndex}`,
      label: `Option ${optionIndex}`,
      value,
      parameter,
      fingerprint: String(optionIndex).repeat(64)
    };

    const configured = routeProtocolRequest(
      { ...normalized, gatewayReasoning: reasoning },
      targetProtocol
    ).body;
    expect(valueAtPath(configured, parameter)).toBe(value);
    for (const candidate of GATEWAY_REASONING_PARAMETER_PATHS) {
      if (candidate !== parameter) expect(valueAtPath(configured, candidate)).toBeUndefined();
    }
    expect(countScalar(configured, value)).toBe(1);
    expect(countScalar(configured, "adapter-shadow")).toBe(0);

    const providerDefault = routeProtocolRequest(normalized, targetProtocol).body;
    for (const candidate of GATEWAY_REASONING_PARAMETER_PATHS) {
      expect(valueAtPath(providerDefault, candidate)).toBeUndefined();
    }
    expect(countScalar(providerDefault, "adapter-shadow")).toBe(0);
  });

  it("preserves required tool selection while normalizing requests for protocol routing", () => {
    const chat = normalizeIncomingRequest({
      model: "kimi-k3",
      messages: [{ role: "user", content: "Call finish" }],
      tools: [{ type: "function", function: { name: "finish", parameters: { type: "object" } } }],
      tool_choice: "required"
    }, "chat-completions");
    expect(chat.requireTool).toBe(true);
    expect(routeProtocolRequest(chat, "responses").body.tool_choice).toBe("required");
  });

  it("flattens Responses namespace tools to fully-qualified portable functions", () => {
    const normalized = normalizeIncomingRequest({
      model: "model-neutral-a",
      input: [{ role: "user", content: "finish" }],
      tools: [{
        type: "namespace",
        name: "mcp__scienceevolve_orchestration_control",
        description: "OpenFARS control tools",
        tools: [{
          type: "function",
          name: "complete_project",
          description: "Complete the project",
          strict: false,
          parameters: {
            type: "object",
            properties: { callId: { type: "string" }, rationale: { type: "string" } },
            required: ["callId", "rationale"],
            additionalProperties: false
          }
        }]
      }]
    }, "responses");

    expect(normalized.tools).toEqual([{
      name: "mcp__scienceevolve_orchestration_control__complete_project",
      description: "Complete the project",
      inputSchema: {
        type: "object",
        properties: { callId: { type: "string" }, rationale: { type: "string" } },
        required: ["callId", "rationale"],
        additionalProperties: false
      },
      sourceNamespace: "mcp__scienceevolve_orchestration_control",
      sourceName: "complete_project",
      strict: false
    }]);
    expect(routeProtocolRequest(normalized, "chat-completions").body.tools).toEqual([{
      type: "function",
      function: expect.objectContaining({
        name: "mcp__scienceevolve_orchestration_control__complete_project"
      })
    }]);
  });

  it("flattens a prior Responses namespace call back into portable history", () => {
    const normalized = normalizeIncomingRequest({
      model: "model-neutral-a",
      input: [{
        type: "function_call",
        call_id: "call-complete",
        namespace: "mcp__scienceevolve_orchestration_control",
        name: "complete_project",
        arguments: '{"callId":"complete-1","rationale":"done"}'
      }, {
        type: "function_call_output",
        call_id: "call-complete",
        output: "staged"
      }]
    }, "responses");

    expect(normalized.messages).toEqual([{
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-complete",
        name: "mcp__scienceevolve_orchestration_control__complete_project",
        arguments: '{"callId":"complete-1","rationale":"done"}'
      }]
    }, {
      role: "tool",
      toolCallId: "call-complete",
      content: "staged"
    }]);
  });

  it("bridges Codex client tool search and materializes loaded MCP tools", () => {
    const search = {
      type: "tool_search", execution: "client", description: "Find deferred MCP tools",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    };
    const normalized = normalizeIncomingRequest({
      model: "gpt-5.6-terra",
      input: [{ role: "user", content: "Find sentinel" }],
      tools: [search]
    }, "responses");
    expect(normalized.tools).toEqual([{
      name: "tool_search", description: "Find deferred MCP tools",
      inputSchema: search.parameters, sourceType: "tool_search"
    }]);
    expect(routeProtocolRequest(normalized, "responses").body.tools).toEqual([
      expect.objectContaining({ type: "function", name: "tool_search" })
    ]);
    const returned = convertProtocolResponse({
      id: "resp_search", object: "response", model: "gpt-5.6-terra",
      output: [{ type: "function_call", call_id: "call_search", name: "tool_search", arguments: '{"query":"scienceevolve_read_smoke_sentinel"}' }]
    }, "responses", "responses", "gpt-5.6-terra", normalized.tools);
    expect(returned.output).toEqual([{
      type: "tool_search_call", execution: "client", call_id: "call_search",
      status: "completed", arguments: { query: "scienceevolve_read_smoke_sentinel" }
    }]);
    const resumed = normalizeIncomingRequest({
      model: "gpt-5.6-terra",
      input: [
        { type: "tool_search_call", execution: "client", call_id: "call_search", arguments: { query: "scienceevolve_read_smoke_sentinel" } },
        { type: "tool_search_output", execution: "client", call_id: "call_search", tools: [{ type: "function", name: "scienceevolve_read_smoke_sentinel", parameters: { type: "object" } }] }
      ]
    }, "responses");
    expect(resumed.messages).toEqual([{
      role: "assistant", content: "",
      toolCalls: [{ id: "call_search", name: "tool_search", arguments: '{"query":"scienceevolve_read_smoke_sentinel"}' }]
    }, {
      role: "tool", toolCallId: "call_search",
      content: '{"tools":[{"type":"function","name":"scienceevolve_read_smoke_sentinel","parameters":{"type":"object"}}]}'
    }]);
    expect(resumed.tools).toEqual([{
      name: "scienceevolve_read_smoke_sentinel", description: undefined,
      inputSchema: { type: "object" }
    }]);
  });

  it("moves interleaved developer/system instructions to the leading chat message", () => {
    const routed = routeProtocolRequest({
      ...request,
      messages: [
        { role: "user", content: "first" },
        { role: "developer", content: "thread rules" },
        { role: "assistant", content: "ack" },
        { role: "system", content: "latest rules" },
        { role: "user", content: "continue" }
      ]
    }, "chat-completions", "secret");
    expect(routed.body.messages).toEqual([
      { role: "system", content: "thread rules\n\nlatest rules" },
      { role: "user", content: "first" },
      { role: "assistant", content: "ack" },
      { role: "user", content: "continue" }
    ]);
  });

  it("normalizes text, tool, terminal and error events from every protocol", () => {
    expect(normalizeProtocolStreamEvent("responses", { type: "response.output_text.delta", delta: "A" })).toMatchObject({ type: "text_delta", text: "A" });
    expect(normalizeProtocolStreamEvent("responses", { type: "response.function_call_arguments.delta", item_id: "item-1", delta: "{}" })).toMatchObject({
      type: "tool_call_delta",
      toolItemId: "item-1",
      toolCallId: undefined
    });
    expect(normalizeProtocolStreamEvent("chat-completions", { choices: [{ delta: { content: "B" } }] })).toMatchObject({ type: "text_delta", text: "B" });
    expect(normalizeProtocolStreamEvent("chat-completions", { choices: [{ delta: {}, finish_reason: "stop" }] })).toMatchObject({ type: "completed" });
    expect(normalizeProtocolStreamEvent("anthropic-messages", { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } })).toMatchObject({ type: "tool_call_delta", argumentsDelta: "{}" });
    expect(normalizeProtocolStreamEvent("anthropic-messages", { type: "message_stop" })).toMatchObject({ type: "completed" });
    expect(normalizeProtocolStreamEvent("responses", { error: "bad key" })).toMatchObject({ type: "error", error: "bad key" });
  });

  it("recognizes common hidden reasoning extensions without treating them as visible text", () => {
    expect(normalizeProtocolStreamEvent("chat-completions", {
      choices: [{ delta: { reasoning_content: "private chat reasoning" } }]
    })).toMatchObject({ type: "reasoning_delta", text: "private chat reasoning" });
    expect(normalizeProtocolStreamEvent("responses", {
      type: "response.reasoning_summary_text.delta",
      delta: "private responses reasoning"
    })).toMatchObject({ type: "reasoning_delta", text: "private responses reasoning" });
    expect(normalizeProtocolStreamEvent("anthropic-messages", {
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "private anthropic reasoning" }
    })).toMatchObject({ type: "reasoning_delta", text: "private anthropic reasoning" });
  });

  it("retains native Chat reasoning separately from visible content", () => {
    const event = normalizeProtocolStreamEvent("chat-completions", {
      choices: [{ delta: { reasoning_content: "native reasoning" } }]
    });
    expect(convertStreamEvent(event, "chat-completions", request.model, "chat-completions"))
      .toMatchObject([{ choices: [{ delta: { reasoning_content: "native reasoning" }, finish_reason: null }] }]);
    expect(convertStreamEvent(event, "responses", request.model, "chat-completions")).toEqual([]);
    expect(convertStreamEvent(event, "anthropic-messages", request.model, "chat-completions")).toEqual([]);
    expect(convertStreamEvent(event, "chat-completions", request.model, "responses")).toEqual([]);
  });

  it("attributes gateway errors without accepting Harness metadata", () => {
    expect(mapProtocolError("responses", 401, { error: { message: "invalid credential" } })).toMatchObject({ source: "gateway" });
    expect(mapProtocolError("responses", 401, { error: { message: "invalid credential" } }).message).toContain("invalid credential");
  });

  it("converts every one of the six directed protocol pairs with text and tool calls", () => {
    const protocols: AgentProtocol[] = ["responses", "chat-completions", "anthropic-messages"];
    const sourceBodies: Record<AgentProtocol, Record<string, unknown>> = {
      responses: {
        model: request.model,
        input: [
          { role: "system", content: "rules" },
          { role: "user", content: "question" },
          { type: "function_call", call_id: "call-in", name: "lookup", arguments: "{\"q\":\"x\"}" },
          { type: "function_call_output", call_id: "call-in", output: "result" }
        ],
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }]
      },
      "chat-completions": {
        model: request.model,
        messages: [
          { role: "system", content: "rules" },
          { role: "user", content: "question" },
          { role: "assistant", content: null, tool_calls: [{ id: "call-in", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] },
          { role: "tool", tool_call_id: "call-in", content: "result" }
        ],
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }]
      },
      "anthropic-messages": {
        model: request.model,
        system: "rules",
        messages: [
          { role: "user", content: "question" },
          { role: "assistant", content: [{ type: "tool_use", id: "call-in", name: "lookup", input: { q: "x" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call-in", content: "result" }] }
        ],
        tools: [{ name: "lookup", input_schema: { type: "object" } }]
      }
    };
    const targetResponses: Record<AgentProtocol, Record<string, unknown>> = {
      responses: {
        id: "resp-1", model: request.model, output_text: "answer",
        output: [{ type: "message", content: [{ type: "output_text", text: "answer" }] }, { type: "function_call", call_id: "call-out", name: "lookup", arguments: "{\"ok\":true}" }]
      },
      "chat-completions": {
        id: "chat-1", model: request.model,
        choices: [{ message: { role: "assistant", content: "answer", tool_calls: [{ id: "call-out", type: "function", function: { name: "lookup", arguments: "{\"ok\":true}" } }] }, finish_reason: "tool_calls" }]
      },
      "anthropic-messages": {
        id: "msg-1", model: request.model,
        content: [{ type: "text", text: "answer" }, { type: "tool_use", id: "call-out", name: "lookup", input: { ok: true } }]
      }
    };
    for (const source of protocols) {
      const normalized = normalizeIncomingRequest(sourceBodies[source], source);
      expect(normalized.messages.some((message) => message.toolCalls?.length)).toBe(true);
      for (const target of protocols) {
        if (source === target) continue;
        const routed = routeProtocolRequest(normalized, target, "secret");
        expect(routed.endpointSuffix).toBe(target === "responses" ? "responses" : target === "chat-completions" ? "chat/completions" : "messages");
        const converted = convertProtocolResponse(targetResponses[target], target, source, request.model);
        expect(converted).toMatchObject({ model: request.model });
        if (source === "responses") expect(converted).toHaveProperty("object", "response");
        if (source === "chat-completions") expect(converted).toHaveProperty("choices");
        if (source === "anthropic-messages") expect(converted).toHaveProperty("content");
      }
    }
  });

  it("maps text and tool stream events in every directed protocol pair", () => {
    const protocols: AgentProtocol[] = ["responses", "chat-completions", "anthropic-messages"];
    const events: Record<AgentProtocol, unknown> = {
      responses: { type: "response.output_text.delta", delta: "text" },
      "chat-completions": { choices: [{ delta: { content: "text" } }] },
      "anthropic-messages": { type: "content_block_delta", delta: { type: "text_delta", text: "text" } }
    };
    const toolEvents: Record<AgentProtocol, unknown> = {
      responses: { type: "response.output_item.added", item: { type: "function_call", call_id: "call-1", name: "lookup" } },
      "chat-completions": { choices: [{ delta: { tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }] } }] },
      "anthropic-messages": { type: "content_block_start", content_block: { type: "tool_use", id: "call-1", name: "lookup" } }
    };
    for (const target of protocols) {
      const normalized = normalizeProtocolStreamEvent(target, events[target]);
      expect(normalized.type).toBe("text_delta");
      const normalizedTool = normalizeProtocolStreamEvent(target, toolEvents[target]);
      expect(normalizedTool).toMatchObject({ type: "tool_call_delta", toolCallId: "call-1", toolName: "lookup" });
      for (const source of protocols) {
        if (source === target) continue;
        expect(convertStreamEvent(normalized, source, request.model).length).toBeGreaterThan(0);
        expect(convertStreamEvent(normalizedTool, source, request.model).length).toBeGreaterThan(0);
      }
    }
  });

  it("maps usage counters and stop reasons into the selected source protocol", () => {
    const fromAnthropic = convertProtocolResponse({
      id: "msg-usage",
      model: request.model,
      content: [{ type: "text", text: "done" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 7, output_tokens: 5, cache_read_input_tokens: 2 }
    }, "anthropic-messages", "chat-completions", request.model);
    expect(fromAnthropic).toMatchObject({
      choices: [{ finish_reason: "length" }],
      usage: {
        prompt_tokens: 9,
        completion_tokens: 5,
        total_tokens: 14,
        prompt_tokens_details: { cached_tokens: 2 }
      }
    });

    const fromChat = convertProtocolResponse({
      id: "chat-usage",
      model: request.model,
      choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
    }, "chat-completions", "responses", request.model);
    expect(fromChat).toMatchObject({
      status: "completed",
      usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 }
    });

    expect(normalizeProtocolStreamEvent("responses", "[DONE]")).toMatchObject({ type: "completed" });
  });

  it("keeps physical input stable when cached tokens cross protocol boundaries", () => {
    const anthropic = {
      id: "msg-cached", model: request.model,
      content: [{ type: "text", text: "done" }], stop_reason: "end_turn",
      usage: { input_tokens: 200_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 50_000, output_tokens: 100 }
    };
    const chat = convertProtocolResponse(anthropic, "anthropic-messages", "chat-completions", request.model);
    const responses = convertProtocolResponse(anthropic, "anthropic-messages", "responses", request.model);
    expect(chat.usage).toMatchObject({
      prompt_tokens: 350_000, prompt_tokens_details: { cached_tokens: 100_000 }, total_tokens: 350_100
    });
    expect(responses.usage).toMatchObject({
      input_tokens: 350_000, input_tokens_details: { cached_tokens: 100_000 }, total_tokens: 350_100
    });
    const fromChat = convertProtocolResponse({
      id: "chat-cached", model: request.model,
      choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 300_000, prompt_tokens_details: { cached_tokens: 100_000 }, completion_tokens: 100, total_tokens: 300_100 }
    }, "chat-completions", "anthropic-messages", request.model);
    expect(fromChat.usage).toMatchObject({
      input_tokens: 200_000, cache_read_input_tokens: 100_000, output_tokens: 100, total_tokens: 300_100
    });
    const terminal = convertStreamEvent({
      type: "completed",
      usage: anthropic.usage,
      stopReason: "end_turn"
    }, "chat-completions", request.model, "anthropic-messages");
    expect(terminal.at(-1)).toMatchObject({
      usage: { prompt_tokens: 350_000, prompt_tokens_details: { cached_tokens: 100_000 }, total_tokens: 350_100 }
    });
  });

  it("retains the DSH provider's max_completion_tokens across chat and Anthropic routes", () => {
    const normalized = normalizeIncomingRequest({
      model: request.model,
      messages: [{ role: "user", content: "continue" }],
      max_completion_tokens: 8_192,
      stream: false
    }, "chat-completions");
    expect(routeProtocolRequest(normalized, "chat-completions").body.max_completion_tokens).toBe(8_192);
    expect(routeProtocolRequest(normalized, "chat-completions").body.max_tokens).toBeUndefined();
    expect(routeProtocolRequest(normalized, "anthropic-messages").body.max_tokens).toBe(8_192);
  });

  it("normalizes provider usage while retaining Anthropic cache tokens", () => {
    expect(normalizeGatewayTokenUsage(
      "usage-anthropic",
      "anthropic-messages",
      request.model,
      {
        input_tokens: 7,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 11,
        output_tokens: 5
      }
    )).toEqual({
      usageId: "usage-anthropic",
      protocol: "anthropic-messages",
      model: request.model,
      inputTokens: 21,
      cachedInputTokens: 11,
      outputTokens: 5,
      totalTokens: 26
    });
    expect(normalizeGatewayTokenUsage(
      "usage-chat",
      "chat-completions",
      request.model,
      {
        prompt_tokens: 13,
        completion_tokens: 2,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 8 }
      }
    )).toMatchObject({
      inputTokens: 13,
      cachedInputTokens: 8,
      outputTokens: 2,
      totalTokens: 15
    });
  });

  it("keeps tool-call terminals completed while preserving actual incomplete reasons", () => {
    const toolResponse = convertProtocolResponse({
      id: "chat-tool",
      model: request.model,
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-tool", type: "function", function: { name: "lookup", arguments: "{}" } }]
        },
        finish_reason: "tool_calls"
      }]
    }, "chat-completions", "responses", request.model);
    expect(toolResponse).toMatchObject({ status: "completed", output: [{ type: "function_call", call_id: "call-tool" }] });

    const incompleteResponse = convertProtocolResponse({
      id: "chat-limit",
      model: request.model,
      choices: [{ message: { role: "assistant", content: "partial" }, finish_reason: "length" }]
    }, "chat-completions", "responses", request.model);
    expect(incompleteResponse).toMatchObject({ status: "incomplete", incomplete_details: { reason: "length" } });
    expect(normalizeProtocolStreamEvent("responses", {
      type: "response.incomplete",
      response: { id: "r-incomplete", status: "incomplete" }
    })).toMatchObject({ type: "completed", stopReason: "incomplete" });
  });

  it("keeps every tool call when a Chat stream packs multiple deltas into one frame", () => {
    const events = normalizeProtocolStreamEvents("chat-completions", {
      id: "chat-multi",
      choices: [{
        delta: {
          content: "checking",
          tool_calls: [
            { index: 0, id: "call-a", function: { name: "lookup", arguments: "{}" } },
            { index: 1, id: "call-b", function: { name: "verify", arguments: "{}" } }
          ]
        },
        finish_reason: "tool_calls"
      }],
      usage: { prompt_tokens: 2, completion_tokens: 1 }
    });
    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "tool_call_delta",
      "tool_call_delta",
      "completed"
    ]);
    expect(events.filter((event) => event.type === "tool_call_delta").map((event) => event.toolCallId)).toEqual([
      "call-a",
      "call-b"
    ]);
    expect(events.at(-1)).toMatchObject({ stopReason: "tool_calls", usage: { prompt_tokens: 2 } });
  });
});
