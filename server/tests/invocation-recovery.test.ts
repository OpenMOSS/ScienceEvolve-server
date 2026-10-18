import { describe, expect, it } from "vitest";
import { InvocationRecoveryController } from "../src/harness-runtime/invocation-recovery.js";

describe("InvocationRecoveryController", () => {
  it("counts every started process attempt, including the initial dispatch", () => {
    const budget = new InvocationRecoveryController(3);

    expect(budget.attemptsStarted).toBe(0);
    expect(budget.startAttempt({ kind: "adapter-dispatch" })).toEqual({
      attempt: 1,
      maxAttempts: 3,
      evidence: { kind: "adapter-dispatch" }
    });
    expect(budget.startAttempt({ kind: "process-signal" })).toEqual({
      attempt: 2,
      maxAttempts: 3,
      evidence: { kind: "process-signal" }
    });
    expect(budget.startAttempt({ kind: "same-harness-replacement" })).toEqual({
      attempt: 3,
      maxAttempts: 3,
      evidence: { kind: "same-harness-replacement" }
    });
    expect(budget.attemptsStarted).toBe(3);
    expect(() => budget.startAttempt({ kind: "provider-transport" })).toThrow(
      expect.objectContaining({
        code: "INVOCATION_ATTEMPT_BUDGET_EXHAUSTED",
        source: "runtime",
        retryable: false,
        details: {
          attemptsStarted: 3,
          maxAttempts: 3,
          requestedEvidence: "provider-transport"
        }
      })
    );
    expect(budget.attemptsStarted).toBe(3);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid maxAttempts value (%s)",
    (maxAttempts) => {
      expect(() => new InvocationRecoveryController(maxAttempts)).toThrow(RangeError);
    }
  );

  it("rejects empty Adapter evidence instead of spending a process attempt", () => {
    const budget = new InvocationRecoveryController(2);

    expect(() => budget.startAttempt({ kind: "  " })).toThrow(TypeError);
    expect(budget.attemptsStarted).toBe(0);
  });
});
