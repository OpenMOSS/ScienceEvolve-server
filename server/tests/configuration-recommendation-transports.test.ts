import { describe, expect, it, vi } from "vitest";
import { cloneAgentOrchestrationTemplate } from "../src/agent-orchestration.js";
import { mergeAgentConfigs } from "../src/validation.js";
import { configRecommendationInputSchema } from "../src/config-recommendations.js";
import { ConfigRecommendationError, generateConfigurationRecommendation, parseConfigurationRecommendationAnswer } from "../src/internal/shared/configuration-recommendation.js";
import type { AgentProtocol } from "../src/agent-runtime.js";

const gateway = {
  id: `gwy_${"a".repeat(32)}`, apiKey: "secret-never-in-evidence", url: "https://gateway.example/v1",
  defaultModel: "tested-model", protocol: "responses" as AgentProtocol
};
const advisor = { gatewayId: gateway.id, model: gateway.defaultModel };
const input = () => configRecommendationInputSchema.parse({ title: "Test research", requirement: "Find a reproducible research approach", advisor });
function recommendation() {
  const orchestration = cloneAgentOrchestrationTemplate();
  const agents = mergeAgentConfigs(undefined, orchestration);
  for (const config of Object.values(agents)) Object.assign(config, {
    harness: "codex", gatewayId: gateway.id, model: gateway.defaultModel,
    permission: "workspace", skills: [], autoSkills: [], mcpServers: [], webSearch: false
  });
  return { agents, orchestration };
}
function setup(value: unknown = recommendation(), protocol = gateway.protocol) {
  const answer = typeof value === "string" ? value : JSON.stringify(value);
  const fetcher = vi.fn(async () => new Response(JSON.stringify(protocol === "responses"
    ? { output_text: answer }
    : protocol === "chat-completions" ? { choices: [{ finish_reason: "stop", message: { content: answer } }] }
      : { stop_reason: "end_turn", content: [{ type: "text", text: answer }] }), { status: 200 }));
  const service = { recommend: async (current: ReturnType<typeof input>, signal: AbortSignal,
    attachments: import("../src/project-input-uploads.js").RecommendationAttachment[] = []) => {
    const { advisor: selected, ...task } = current;
    return generateConfigurationRecommendation({
      gateway: { ...gateway, protocol }, model: selected?.model ?? gateway.defaultModel,
      evidence: { task, userInputs: { description: current.inputDescription ?? "", files: attachments.map((file) =>
        file.kind === "text" ? { path: file.path, kind: file.kind, content: file.text } : { path: file.path, kind: file.kind, mediaType: file.mediaType }) } },
      attachments: attachments.filter((file) => file.kind !== "text"), signal, fetcher: fetcher as typeof fetch,
      validate: (answer: string) => ({ recommendation: parseConfigurationRecommendationAnswer(answer) as ReturnType<typeof recommendation>, warnings: [] as string[] }),
      validationError: (error: unknown) => new ConfigRecommendationError(error instanceof SyntaxError
        ? "配置顾问返回的内容不是有效 JSON，请换用更擅长结构化输出的模型重试。" : "Invalid configuration")
    });
  } };
  return { service, fetcher };
}

describe("shared configuration recommendation transports", () => {
it.each(["responses", "chat-completions", "anthropic-messages"] as const)("sends text, image and PDF content to the %s advisor", async (protocol) => {
    const { service, fetcher } = setup(recommendation(), protocol);
    const current = input();
    current.inputDescription = "图片展示了实验装置";
    await service.recommend(current, new AbortController().signal, [
      { path: "data/notes.txt", kind: "text", text: "实测样本数 42" },
      { path: "figures/rig.png", kind: "image", mediaType: "image/png", data: "aW1hZ2U=" },
      { path: "references/paper.pdf", kind: "pdf", mediaType: "application/pdf", data: "cGRm" }
    ]);
    const body = JSON.parse(String((fetcher.mock.calls as unknown as [string, RequestInit][])[0]![1].body));
    const content = protocol === "responses" ? body.input[0].content : body.messages.at(-1).content;
    const evidence = JSON.parse(content[0].text);
    expect(evidence.task.title).toBe(current.title);
    expect(evidence.task.requirement).toBe(current.requirement);
    expect(evidence.userInputs.description).toBe("图片展示了实验装置");
    expect(evidence.userInputs.files).toContainEqual({ path: "data/notes.txt", kind: "text", content: "实测样本数 42" });
    expect(evidence.userInputs.files).toContainEqual({ path: "figures/rig.png", kind: "image", mediaType: "image/png" });
    if (protocol === "responses") {
      expect(content[2]).toEqual({ type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" });
      expect(content[4]).toEqual({ type: "input_file", filename: "paper.pdf", file_data: "data:application/pdf;base64,cGRm" });
    } else if (protocol === "chat-completions") {
      expect(content[2]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } });
      expect(content[4]).toEqual({ type: "file", file: { filename: "paper.pdf", file_data: "data:application/pdf;base64,cGRm" } });
    } else {
      expect(content[2]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } });
      expect(content[4]).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "cGRm" } });
    }
    expect(JSON.stringify(content)).toContain("aW1hZ2U=");
    expect(JSON.stringify(content)).toContain("cGRm");
    expect(JSON.stringify(content)).toContain("figures/rig.png");
    expect(JSON.stringify(content)).toContain("references/paper.pdf");
    expect(JSON.stringify(body)).not.toContain(gateway.apiKey);
  });

it.each(["responses", "chat-completions", "anthropic-messages"] as const)("uses a stateless %s model without tools or credentials in evidence", async (protocol) => {
    const { service, fetcher } = setup(recommendation(), protocol);
    const result = await service.recommend(input(), new AbortController().signal);
    expect(result.recommendation.orchestration.input.target).toBe("idea");
    expect(result.recommendation.agents.main?.sessionPersistence).toBe(true);
    const args = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]!;
    expect(args[0]).toMatch(protocol === "responses" ? /\/responses$/ : protocol === "chat-completions" ? /\/chat\/completions$/ : /\/messages$/);
    expect(args[1].redirect).toBe("error");
    expect(String(args[1].body)).not.toContain(gateway.apiKey);
    expect(JSON.parse(String(args[1].body))).not.toHaveProperty("tools");
    expect(JSON.parse(String(args[1].body))).not.toHaveProperty("reasoning_effort");
  });

it.each(["dsv4-flash-0731", "nex-agi/Nex-N2-Pro", "another-model"])("does not override reasoning based on the model name %s", async model => {
    const value = recommendation();
    for (const config of Object.values(value.agents)) config.model = model;
    const { service, fetcher } = setup(value, "chat-completions");
    const current = input(); current.advisor!.model = model;
    await service.recommend(current, new AbortController().signal);
    const body = JSON.parse(String((fetcher.mock.calls as unknown as [string, RequestInit][])[0]![1].body));
    expect(body).not.toHaveProperty("reasoning_effort");
  });

it.each(["responses", "chat-completions", "anthropic-messages"] as const)("reassembles chunked %s SSE output", async (protocol) => {
    const { service, fetcher } = setup(recommendation(), protocol);
    const answer = JSON.stringify(recommendation());
    const middle = Math.floor(answer.length / 2);
    const events = protocol === "responses"
      ? [{ type: "response.output_text.delta", delta: answer.slice(0, middle) }, { type: "response.output_text.delta", delta: answer.slice(middle) }]
      : protocol === "chat-completions"
        ? [{ choices: [{ delta: { content: answer.slice(0, middle) } }] }, { choices: [{ delta: { content: answer.slice(middle) }, finish_reason: "stop" }] }]
        : [{ type: "content_block_delta", delta: { text: answer.slice(0, middle) } }, { type: "content_block_delta", delta: { text: answer.slice(middle) } }];
    const stream = `: keepalive\n\n${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
    const encoded = new TextEncoder().encode(stream);
    fetcher.mockImplementation(async () => new Response(new ReadableStream({
      start(controller) {
        for (let index = 0; index < encoded.length; index += 37) controller.enqueue(encoded.slice(index, index + 37));
        controller.close();
      }
    }), { headers: { "content-type": "text/event-stream" } }));
    const result = await service.recommend(input(), new AbortController().signal);
    expect(result.recommendation.agents.idea).toBeDefined();
    const body = JSON.parse(String((fetcher.mock.calls as unknown as [string, RequestInit][])[0]![1].body));
    expect(body.stream).toBe(true);
  });

it("reads the final Responses event when a gateway omits text delta events", async () => {
    const { service, fetcher } = setup();
    const answer = JSON.stringify(recommendation());
    fetcher.mockImplementation(async () => new Response(`data: ${JSON.stringify({
      type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: answer }] }] }
    })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    expect((await service.recommend(input(), new AbortController().signal)).recommendation.agents.idea).toBeDefined();
  });

it("identifies an incomplete Responses final event instead of reporting invalid JSON", async () => {
    const { service, fetcher } = setup();
    fetcher.mockImplementation(async () => new Response(`data: ${JSON.stringify({
      type: "response.output_text.delta", delta: '{"agents":'
    })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "incomplete" } })}\n\n`, {
      headers: { "content-type": "text/event-stream" }
    }));
    await expect(service.recommend(input(), new AbortController().signal)).rejects.toMatchObject({
      status: 502, message: "配置顾问模型输出被截断，未能生成完整配置。"
    });
  });

it("reports a truncated SSE completion instead of an invalid configuration", async () => {
    const { service, fetcher } = setup(recommendation(), "chat-completions");
    fetcher.mockImplementation(async () => new Response('data: {"choices":[{"delta":{"content":"{\\"agents\\":"},"finish_reason":"length"}]}\n\n', {
      headers: { "content-type": "text/event-stream" }
    }));
    await expect(service.recommend(input(), new AbortController().signal)).rejects.toMatchObject({
      status: 502, message: "配置顾问模型输出被截断，未能生成完整配置。"
    });
  });

it("does not expose a provider error body or gateway credentials", async () => {
    const { service, fetcher } = setup();
    fetcher.mockImplementation(async () => new Response(`provider leaked ${gateway.apiKey}`, { status: 401 }));
    await expect(service.recommend(input(), new AbortController().signal)).rejects.toMatchObject({ status: 502, message: "配置推荐模型请求失败（HTTP 401），请检查网关后重试。" });
  });

it("identifies an upstream gateway timeout", async () => {
    const { service, fetcher } = setup();
    fetcher.mockImplementation(async () => new Response("upstream timeout", { status: 504 }));
    await expect(service.recommend(input(), new AbortController().signal)).rejects.toMatchObject({
      status: 504,
      message: "配置顾问网关返回 HTTP 504：模型生成在网关侧超时。请选响应更快的模型，或缩短课题要求后重试。"
    });
  });

it("distinguishes a transport failure from invalid model output without exposing provider text", async () => {
    const transport = setup();
    transport.fetcher.mockRejectedValue(Object.assign(new Error("secret provider URL"), { cause: { code: "ETIMEDOUT" } }));
    await expect(transport.service.recommend(input(), new AbortController().signal)).rejects.toMatchObject({
      status: 502,
      message: "配置顾问连接所选网关失败（ETIMEDOUT），请检查网络、代理或 TLS 证书。"
    });
    await expect(setup("not-json").service.recommend(input(), new AbortController().signal)).rejects.toMatchObject({
      status: 502,
      message: "配置顾问返回的内容不是有效 JSON，请换用更擅长结构化输出的模型重试。"
    });
  });

it("recovers from a truncated first output", async () => {
    const value = JSON.stringify(recommendation());
    const { service, fetcher } = setup();
    fetcher.mockImplementationOnce(async () => new Response(JSON.stringify({ status: "incomplete" }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ output_text: value }), { status: 200 }));
    expect((await service.recommend(input(), new AbortController().signal)).recommendation.agents.idea).toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

it("falls back when a gateway rejects structured output fields", async () => {
    const value = JSON.stringify(recommendation());
    const { service, fetcher } = setup();
    fetcher.mockImplementationOnce(async () => new Response("unsupported response_format", { status: 400 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ output_text: value }), { status: 200 }));
    await service.recommend(input(), new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    const structuredBody = JSON.parse(String(calls[0]![1].body));
    const fallbackBody = JSON.parse(String(calls[1]![1].body));
    expect(structuredBody.text).toEqual({ format: { type: "json_object" } });
    expect(fallbackBody).not.toHaveProperty("text");
  });
});
