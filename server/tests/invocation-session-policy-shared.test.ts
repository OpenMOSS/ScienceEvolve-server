import { describe, expect, it } from "vitest";
import { deriveInvocationSessionPolicy } from "../src/internal/shared/invocation-session-policy.js";

describe("shared invocation Session policy", () => {
  it.each([
    ["main", false, true, false],
    ["main", true, true, false],
    ["worker", true, true, false],
    ["worker", false, false, true]
  ] as const)(
    "derives kind=%s persistence=%s",
    (kind, persistence, durableSession, disableCodexGoals) => {
      expect(deriveInvocationSessionPolicy(kind, persistence)).toEqual({
        durableSession,
        disableCodexGoals
      });
    }
  );
});
