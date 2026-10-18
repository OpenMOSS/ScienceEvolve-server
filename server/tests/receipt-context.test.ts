import { describe, expect, it } from "vitest";
import { receiptContextFacts } from "../src/terminal-push-coordinator-runtime.js";
import type { TerminalPushCoordinationIncident } from "../src/collaboration-state/contracts.js";

describe("receipt coordination context", () => {
  it("selects only related executions and operations without including the same Agent's unrelated history", () => {
    const incident = { id: "incident", executionId: "execution-current", operationId: "push-current",
      originalInvocationId: "invocation-current", unresolvedRequestId: "request-current" } as TerminalPushCoordinationIncident;
    const current = { id: "push-current", executionId: "execution-current", agentId: "review", status: "merged", providerProof: "actual remote evidence" };
    const unrelated = { id: "push-old", executionId: "execution-old", agentId: "review", output: "unrelated history" };
    const facts = receiptContextFacts({ stateRevision: 123, operations: [unrelated, current],
      scopedRuntime: { executions: [{ executionId: "execution-current", status: "waiting" }, { executionId: "execution-old", status: "completed" }] },
      configuration: { instructions: "unrelated configuration" } }, incident);
    expect(facts).toEqual({ stateRevision: 123, operations: [current], scopedRuntime: { executions: [{ executionId: "execution-current", status: "waiting" }] } });
    expect(JSON.stringify(facts)).not.toContain("unrelated");
  });
});
