import type {
  InvocationRecoveryBudget,
  InvocationRecoveryEvidence,
  InvocationProcessAttempt
} from "./contracts.js";
import { HarnessRuntimeError } from "./errors.js";

/** Total native process attempts allowed for one invocation, including the first. */
export const DEFAULT_INVOCATION_RECOVERY_MAX_ATTEMPTS = 18;

/**
 * Harness-neutral, invocation-scoped process-attempt controller. Adapters
 * identify why each launch is requested, while this shared controller owns the
 * total limit across initial dispatch, internal recovery, and replacement.
 */
export class InvocationRecoveryController implements InvocationRecoveryBudget {
  private started = 0;

  constructor(
    readonly maxAttempts = DEFAULT_INVOCATION_RECOVERY_MAX_ATTEMPTS
  ) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError("Invocation recovery maxAttempts must be a positive safe integer");
    }
  }

  get attemptsStarted(): number {
    return this.started;
  }

  startAttempt(evidence: InvocationRecoveryEvidence): InvocationProcessAttempt {
    if (!evidence.kind.trim()) {
      throw new TypeError("Invocation recovery evidence kind must not be empty");
    }
    if (this.started >= this.maxAttempts) {
      throw new HarnessRuntimeError(
        "INVOCATION_ATTEMPT_BUDGET_EXHAUSTED",
        "Invocation exhausted its native process attempt budget",
        {
          attemptsStarted: this.started,
          maxAttempts: this.maxAttempts,
          requestedEvidence: evidence.kind
        },
        { source: "runtime" }
      );
    }
    this.started += 1;
    return {
      attempt: this.started,
      maxAttempts: this.maxAttempts,
      evidence: { ...evidence }
    };
  }
}
