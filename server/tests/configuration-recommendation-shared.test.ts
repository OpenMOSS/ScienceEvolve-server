import { describe, expect, it, vi } from "vitest";
import {
  CONFIGURATION_ADVISOR_PROMPT,
  ConfigRecommendationError,
  generateConfigurationRecommendation,
  parseConfigurationRecommendationAnswer
} from "../src/internal/shared/configuration-recommendation.js";

describe("shared configuration recommendation core", () => {
  it.each([false, true])("declares JSON output in generation and recovery input messages (with image: %s)", async (withImage) => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      // Some Responses gateways check input messages, excluding instructions.
      if (!/json/i.test(JSON.stringify(body.input))) {
        return new Response('data: {"type":"response.failed","response":{"status":"failed","error":{"message":"Input messages must contain json"}}}\n\n', {
          headers: { "content-type": "text/event-stream" }
        });
      }
      return Response.json({ output_text: fetcher.mock.calls.length === 1
        ? "not valid output"
        : '{"agents":{"main":{}},"orchestration":{"routes":{}}}' });
    });
    const result = await generateConfigurationRecommendation({
      gateway: { url: "https://gateway.example/v1", apiKey: "test", protocol: "responses" },
      model: "advisor-model",
      evidence: { task: { title: "新课题", requirement: "调查研究并输出中文报告" } },
      attachments: withImage ? [{ path: "reference.png", kind: "image", mediaType: "image/png", data: "aW1hZ2U=" }] : [],
      signal: new AbortController().signal,
      fetcher: fetcher as typeof fetch,
      validate: (answer) => ({ value: parseConfigurationRecommendationAnswer(answer), warnings: [] }),
      validationError: () => new ConfigRecommendationError("invalid recommendation")
    });
    expect(result.value).toHaveProperty("agents.main");
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) {
      const body = JSON.parse(String(init?.body));
      expect(body.text.format.type).toBe("json_object");
      const content = body.input[0].content;
      const evidence = withImage ? content[0].text : content;
      expect(JSON.parse(evidence).outputFormat).toBe("json");
      if (withImage) expect(content).toContainEqual({ type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" });
    }
  });

  it("extracts the complete configuration object without trusting surrounding text", () => {
    expect(parseConfigurationRecommendationAnswer(
      'preamble {"diagnostic":true} result {"agents":{"main":{}},"orchestration":{"routes":{}}} trailing'
    )).toEqual({ agents: { main: {} }, orchestration: { routes: {} } });
  });

  it("retries one invalid answer without exposing credentials or mutating input", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ output_text: "not JSON" }))
      .mockResolvedValueOnce(Response.json({
        output_text: '{"agents":{"main":{}},"orchestration":{"routes":{}}}'
      }));
    const evidence = { task: { requirement: "Preserve this input" } };
    const result = await generateConfigurationRecommendation({
      gateway: {
        url: "https://gateway.example/v1",
        apiKey: "secret-never-in-evidence",
        protocol: "responses"
      },
      model: "advisor-model",
      evidence,
      signal: new AbortController().signal,
      fetcher: fetcher as typeof fetch,
      recoveryAnswer: answer => answer === "not JSON" ? answer : undefined,
      validate: (answer) => ({
        value: parseConfigurationRecommendationAnswer(answer),
        warnings: []
      }),
      validationError: () => new ConfigRecommendationError("invalid recommendation")
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(firstBody.instructions).toBe(CONFIGURATION_ADVISOR_PROMPT);
    expect(firstBody.input[0].content).toContain("Preserve this input");
    expect(firstBody.input[0].content).not.toContain("secret-never-in-evidence");
    const recoveryBody = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    expect(JSON.parse(recoveryBody.input[0].content).recovery.previousAnswer).toBe("not JSON");
    expect(result.value).toHaveProperty("agents.main");
    expect(result.warnings[0]).toContain("已自动恢复生成");
    expect(evidence).toEqual({ task: { requirement: "Preserve this input" } });
  });

  it("bounds the previous answer included as quoted recovery evidence", async () => {
    const generateAnswer = vi.fn()
      .mockResolvedValueOnce("a".repeat(100_000))
      .mockResolvedValueOnce('{"agents":{},"orchestration":{}}');
    await generateConfigurationRecommendation({
      evidence: { task: { title: "Small task" } },
      signal: new AbortController().signal,
      generateAnswer,
      recoveryAnswer: answer => answer,
      validate: answer => ({ value: parseConfigurationRecommendationAnswer(answer), warnings: [] }),
      validationError: () => new ConfigRecommendationError("invalid JSON")
    });
    const recovery = JSON.parse(generateAnswer.mock.calls[1]![1]).recovery;
    expect(recovery.previousAnswer.length).toBeLessThanOrEqual(64_000);
    expect(recovery.previousAnswerTruncated).toBe(true);
    expect(generateAnswer.mock.calls[1]![0]).toContain("quoted draft data");
  });
});
