import { describe, expect, it } from "vitest";
import {
  applyGatewayUsageReport,
  createProjectTokenUsage,
  isProjectTokenUsage,
  normalizeGatewayTokenUsage
} from "../src/internal/shared/token-usage-ledger.js";

describe("shared provider request token ledger", () => {
  it("deduplicates reports and repairs unknown usage without double counting", () => {
    const usage = createProjectTokenUsage(["main", "worker"]);
    const unknown = {
      usageId: "request-1",
      protocol: "responses" as const,
      model: "model-a",
      status: "unknown" as const,
      reason: "transport-outcome-unknown" as const,
      processingState: "indeterminate" as const
    };
    applyGatewayUsageReport(usage, "main", unknown, "2026-01-01T00:00:00.000Z");
    applyGatewayUsageReport(usage, "main", unknown, "2026-01-01T00:00:01.000Z");
    expect(usage).toMatchObject({
      inputTokens: 0,
      totalTokens: 0,
      invocations: 0,
      unknownRequests: 1,
      complete: false
    });

    const known = {
      usageId: "request-1",
      protocol: "responses" as const,
      model: "model-a",
      inputTokens: 7,
      cachedInputTokens: 3,
      outputTokens: 2,
      totalTokens: 9
    };
    applyGatewayUsageReport(usage, "main", known, "2026-01-01T00:00:02.000Z");
    applyGatewayUsageReport(
      usage,
      "main",
      { ...known, totalTokens: 999 },
      "2026-01-01T00:00:03.000Z"
    );
    expect(usage).toMatchObject({
      inputTokens: 7,
      cachedInputTokens: 3,
      outputTokens: 2,
      totalTokens: 9,
      invocations: 1,
      unknownRequests: 0,
      complete: true
    });
    expect(usage.byAgent.main).toMatchObject({ totalTokens: 9, invocations: 1 });
    expect(usage.requestLedger?.["request-1"]).toMatchObject({ status: "known" });
    expect(isProjectTokenUsage(usage, ["main", "worker"])).toBe(true);
  });

  it("normalizes Anthropic cache reads and writes as physical input", () => {
    expect(normalizeGatewayTokenUsage(
      "request-cache",
      "anthropic-messages",
      "model-a",
      {
        input_tokens: 7,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 11,
        output_tokens: 5
      }
    )).toEqual({
      usageId: "request-cache",
      protocol: "anthropic-messages",
      model: "model-a",
      inputTokens: 21,
      cachedInputTokens: 11,
      outputTokens: 5,
      totalTokens: 26
    });
  });
});
