import type { AgentOrchestrationTemplate, AgentsConfig } from "../../../types";

export interface CanvasHistorySnapshot {
  orchestration: AgentOrchestrationTemplate;
  agents: AgentsConfig;
}

/** A bounded, immutable undo stack. Each user action contributes one entry. */
export class CanvasHistory {
  private readonly entries: CanvasHistorySnapshot[] = [];
  constructor(private readonly limit = 30) {}

  get length(): number { return this.entries.length; }
  get canUndo(): boolean { return this.entries.length > 0; }

  push(snapshot: CanvasHistorySnapshot): void {
    this.entries.push({
      orchestration: structuredClone(snapshot.orchestration),
      agents: structuredClone(snapshot.agents)
    });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  pop(): CanvasHistorySnapshot | undefined {
    const value = this.entries.pop();
    return value ? { orchestration: structuredClone(value.orchestration), agents: structuredClone(value.agents) } : undefined;
  }

  clear(): void { this.entries.length = 0; }
}

export function pushCanvasHistory(
  history: readonly CanvasHistorySnapshot[],
  snapshot: CanvasHistorySnapshot,
  limit = 30
): CanvasHistorySnapshot[] {
  const next = [...history, {
    orchestration: structuredClone(snapshot.orchestration),
    agents: structuredClone(snapshot.agents)
  }];
  return next.slice(-Math.max(1, limit));
}
