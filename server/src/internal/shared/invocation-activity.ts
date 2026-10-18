export const DEFAULT_MODEL_ACTIVITY_IDLE_WINDOW_MS = 20 * 60_000;
export const DEFAULT_TOOL_ACTIVITY_IDLE_WINDOW_MS = 120 * 60_000;

export interface InvocationActivityTimeoutOptions {
  /** Maximum silence while waiting for substantive model progress. */
  agentActivityIdleWindowMs?: number;
  /** Maximum silence for each independently active tool call. */
  agentToolActivityIdleWindowMs?: number;
}

export type AgentActivitySignal =
  | {
      kind: "model";
      phase: "delta" | "completed";
      source: "gateway" | "harness";
      deltaKind?: "visible-text" | "reasoning" | "tool-arguments";
      observedAt?: number;
    }
  | {
      kind: "tool";
      phase: "started" | "updated" | "completed" | "failed";
      source: "harness";
      callId: string;
      name?: string;
      observedAt?: number;
    };

export interface TrackedToolActivity {
  callId: string;
  name?: string;
  startedAt: number;
  lastActivityAt: number;
}

export interface InvocationActivitySnapshot {
  lastModelActivityAt: number;
  lastModelActivitySource: AgentActivitySignal["source"];
  activeTools: TrackedToolActivity[];
}

/**
 * Harness-neutral invocation liveness state.
 *
 * Only callers that have classified an official Harness event or substantive
 * provider frame may call `record`; raw stdout, keep-alives and unknown
 * metadata deliberately have no entry point here.
 */
export class InvocationActivityTracker {
  private lastModelActivityAt: number;
  private lastModelActivitySource: AgentActivitySignal["source"] = "gateway";
  private readonly activeTools = new Map<string, TrackedToolActivity>();
  private readonly waiters = new Set<() => void>();

  constructor(startedAt: number) {
    this.lastModelActivityAt = startedAt;
  }

  beginModelWait(observedAt = Date.now()): void {
    // Invocation staging happens before a Harness can emit model activity.
    // Start the deadline only once setup is complete.
    this.lastModelActivityAt = observedAt;
    this.lastModelActivitySource = "harness";
  }

  record(activity: AgentActivitySignal): void {
    const observedAt = activity.observedAt ?? Date.now();
    if (activity.kind === "model") {
      this.lastModelActivityAt = observedAt;
      this.lastModelActivitySource = activity.source;
    } else if (activity.phase === "started") {
      this.activeTools.set(activity.callId, {
        callId: activity.callId,
        name: activity.name,
        startedAt: observedAt,
        lastActivityAt: observedAt
      });
    } else if (activity.phase === "updated") {
      const current = this.activeTools.get(activity.callId);
      if (current) {
        current.lastActivityAt = observedAt;
        if (activity.name) current.name = activity.name;
      }
    } else {
      const removed = this.activeTools.delete(activity.callId);
      if (removed && this.activeTools.size === 0) {
        // Tool execution is its own phase. The next model wait receives a
        // fresh complete window instead of paying for tool wall-clock time.
        this.lastModelActivityAt = observedAt;
        this.lastModelActivitySource = activity.source;
      }
    }
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  snapshot(): InvocationActivitySnapshot {
    return {
      lastModelActivityAt: this.lastModelActivityAt,
      lastModelActivitySource: this.lastModelActivitySource,
      activeTools: [...this.activeTools.values()].map((tool) => ({ ...tool }))
    };
  }

  waitForChange(
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<"changed" | "timeout" | "aborted"> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve("aborted");
        return;
      }
      let settled = false;
      const settle = (result: "changed" | "timeout" | "aborted") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(onChange);
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onChange = () => settle("changed");
      const onAbort = () => settle("aborted");
      const timer = setTimeout(() => settle("timeout"), Math.max(1, timeoutMs));
      timer.unref();
      this.waiters.add(onChange);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
