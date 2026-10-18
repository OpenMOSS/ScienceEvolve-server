import { describe, expect, it } from "vitest";
import { contextLimitError, nativeContextLimitMessage } from "../src/context-limit.js";

describe("context limit errors", () => {
  it.each([
    "Your request exceeded model token limit: 1048576 (requested: 1230139)",
    "prompt is too long: 1,230,139 tokens > 1,048,576 maximum",
    "This model's maximum context length is 1048576 tokens. However, you requested 1230139 tokens."
  ])("recognizes provider wording and preserves token counts: %s", (message) => {
    const limit = contextLimitError({ error: { message } });
    expect(limit).toEqual({ limitTokens: 1048576, requestedTokens: 1230139 });
    expect(nativeContextLimitMessage(limit!)).toBe("prompt is too long: 1230139 tokens > 1048576 maximum");
  });

  it("recognizes structured errors without invented token counts", () => {
    expect(contextLimitError({ error: { code: "context_length_exceeded", message: "Request rejected" } })).toEqual({});
    expect(nativeContextLimitMessage({})).toMatch(/^prompt is too long:/);
  });

  it.each([
    "Rate limit exceeded: tokens per minute",
    "max_tokens must be at most 8192",
    "output token limit exceeded",
    "insufficient_quota",
    "upstream timed out"
  ])("does not rebuild context for unrelated errors: %s", (message) => {
    expect(contextLimitError({ error: { message } })).toBeUndefined();
  });
});
