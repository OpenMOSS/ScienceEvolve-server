import { describe, expect, it, vi } from "vitest";
import { assertInjectionBudget, fitContextInjection, injectionBudget, injectionTokenEstimate } from "../src/context-injection-budget.js";
import { startProtocolProxy } from "../src/protocol-router.js";

describe("system context injection admission", () => {
  it("uses the selected window's half-limit, including Chinese and fixed instructions", () => {
    expect(injectionBudget("task", 262144).limitTokens).toBe(131072);
    expect(injectionBudget("task", 16000).limitTokens).toBe(8000);
    expect(() => assertInjectionBudget("当前任务".repeat(100), 1000, "permissions")).toThrow(/half/);
    expect(injectionTokenEstimate("ﷺ")).toBeGreaterThan(Buffer.byteLength("ﷺ") + 32);
  });

  it("coarsens only designated indexes while keeping the complete current correction", () => {
    const task = "CURRENT CORRECTION: preserve all successful work; call the missing completion tool.\n".repeat(5);
    const index = "OLD_RECORD_METADATA ".repeat(2000);
    const result = fitContextInjection(`${task}\n${index}`, 4096,
      [{ text: index, alternatives: ["Complete grouped history at /read-only/index.json"] }], "fixed permissions");
    expect(result.prompt).toContain(task);
    expect(result.prompt).toContain("/read-only/index.json");
    expect(result.prompt).not.toContain("OLD_RECORD_METADATA");
    expect(result.budget.estimatedTokens).toBeLessThanOrEqual(2048);
  });

  it("rejects an oversized mandatory task without silently trimming its text or interpreting user markup", () => {
    const task = `<project-context-index>Context index: /a\n${"EXACT_USER_TASK".repeat(2000)}</project-context-index>`;
    expect(() => fitContextInjection(task, 4096)).toThrowError(expect.objectContaining({ code: "CONTEXT_INJECTION_LIMIT_EXCEEDED" }));
  });

  it.each(["responses", "chat-completions", "anthropic-messages"] as const)("checks actual %s tool definitions before any provider call", async protocol => {
    const modelFetch = vi.fn();
    const proxy = await startProtocolProxy({ sourceProtocol: protocol, targetProtocol: protocol,
      gatewayUrl: "https://provider.invalid/v1", gatewayApiKey: "test-key", force: true,
      validateGatewayTarget: async () => undefined, modelFetch,
      getContextInjectionBudget: () => injectionBudget("current task", 4096) });
    try {
      const tool = { name: "large_tool", description: "schema-description ".repeat(2000) };
      const body = protocol === "responses" ? { model: "selected", input: "current task", tools: [{ ...tool, type: "function", parameters: { type: "object" } }] }
        : { model: "selected", max_tokens: 128, messages: [{ role: "user", content: "current task" }], tools: protocol === "anthropic-messages"
          ? [{ ...tool, input_schema: { type: "object" } }] : [{ type: "function", function: { ...tool, parameters: { type: "object" } } }] };
      const endpoint = protocol === "responses" ? "responses" : protocol === "anthropic-messages" ? "messages" : "chat/completions";
      const response = await fetch(`${proxy.baseUrl}/${endpoint}`, { method: "POST",
        headers: { Authorization: `Bearer ${proxy.token}`, "x-api-key": proxy.token, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(modelFetch).not.toHaveBeenCalled();
      expect(proxy.getFailure?.()).toMatchObject({ code: "CONTEXT_INJECTION_LIMIT_EXCEEDED", limitTokens: 2048 });
    } finally { await proxy.close(); }
  });

  it("does not impose the half-window limit on the entire native conversation", async () => {
    const modelFetch = vi.fn(async () => new Response(JSON.stringify({ id: "response", object: "chat.completion", model: "selected",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const proxy = await startProtocolProxy({ sourceProtocol: "chat-completions", targetProtocol: "chat-completions",
      gatewayUrl: "https://provider.invalid/v1", gatewayApiKey: "test-key", force: true,
      validateGatewayTarget: async () => undefined, modelFetch,
      getContextInjectionBudget: () => injectionBudget("new current task", 4096) });
    try {
      const response = await fetch(`${proxy.baseUrl}/chat/completions`, { method: "POST", headers: {
        Authorization: `Bearer ${proxy.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "selected",
        messages: [{ role: "user", content: "previous native history ".repeat(5000) }, { role: "user", content: "new current task" }] }) });
      expect(response.status).toBe(200); expect(modelFetch).toHaveBeenCalledTimes(1);
    } finally { await proxy.close(); }
  });
});
