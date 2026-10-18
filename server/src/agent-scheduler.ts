import { type AgentKind, type AgentQueueSnapshot } from "./types.js";

type WaiterState = "queued" | "granted" | "cancelled" | "released";

interface Waiter {
  token: symbol;
  kind: AgentKind;
  projectId: string;
  enteredAt: string;
  queueOrder: number;
  order: number;
  state: WaiterState;
  signal: AbortSignal;
  abort: () => void;
  resolve: (lease: AgentLease) => void;
  reject: (error: AgentQueueAbortedError) => void;
}

interface KindSlot {
  active: Map<symbol, Waiter>;
  queued: Waiter[];
}

export interface AgentLease {
  release(): void;
}

export class AgentQueueAbortedError extends Error {
  constructor(message = "Agent queue wait was interrupted") {
    super(message);
    this.name = "AgentQueueAbortedError";
  }
}

export const DEFAULT_AGENT_KIND_CAPACITY = 10;

/**
 * A bounded FIFO lease pool per Agent kind. Grant, abort and release are
 * synchronous state transitions, so an aborted waiter cannot later become a
 * ghost owner.
 */
export class AgentScheduler {
  private readonly slots: Map<AgentKind, KindSlot>;
  private nextOrder = 0;

  constructor(
    private readonly capacity: number = DEFAULT_AGENT_KIND_CAPACITY
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("Agent kind capacity must be a positive safe integer");
    }
    this.slots = new Map<AgentKind, KindSlot>([
      ["main", { active: new Map(), queued: [] }],
      ["worker", { active: new Map(), queued: [] }]
    ]);
  }

  acquire(
    kind: AgentKind,
    projectId: string,
    enteredAt: string,
    queueOrder: number,
    signal: AbortSignal
  ): Promise<AgentLease> {
    const slot = this.slot(kind);
    if (
      [...slot.active.values()].some(
        (waiter) => waiter.projectId === projectId
      ) ||
      slot.queued.some((waiter) => waiter.projectId === projectId)
    ) {
      throw new Error(
        `Project ${projectId} already owns or awaits the ${kind} agent slot`
      );
    }

    return new Promise<AgentLease>((resolve, reject) => {
      const waiter: Waiter = {
        token: Symbol(`${kind}:${projectId}`),
        kind,
        projectId,
        enteredAt,
        queueOrder,
        order: this.nextOrder++,
        state: "queued",
        signal,
        abort: () => undefined,
        resolve,
        reject
      };
      waiter.abort = () => this.abortWaiter(waiter);
      slot.queued.push(waiter);
      slot.queued.sort(compareWaiters);
      signal.addEventListener("abort", waiter.abort, { once: true });

      if (signal.aborted) {
        this.abortWaiter(waiter);
        return;
      }
      this.drain(kind);
    });
  }

  snapshot(): AgentQueueSnapshot {
    return Object.fromEntries(
      [...this.slots.keys()].sort().map((kind) => {
        const slot = this.slot(kind);
        const activeProjectIds = [...slot.active.values()].map(
          (waiter) => waiter.projectId
        );
        return [
          kind,
          {
            capacity: this.capacity,
            activeProjectIds,
            queued: slot.queued
              .filter((waiter) => waiter.state === "queued")
              .map((waiter, index) => ({
                projectId: waiter.projectId,
                position: index + 1,
                enteredAt: waiter.enteredAt
              }))
          }
        ];
      })
    ) as AgentQueueSnapshot;
  }

  position(
    kind: AgentKind,
    projectId: string
  ): { position: number; depth: number } | undefined {
    const waiting = this.slot(kind).queued.filter(
      (waiter) => waiter.state === "queued"
    );
    const index = waiting.findIndex((waiter) => waiter.projectId === projectId);
    return index < 0
      ? undefined
      : { position: index + 1, depth: waiting.length };
  }

  private slot(kind: AgentKind): KindSlot {
    let slot = this.slots.get(kind);
    if (!slot) {
      slot = { active: new Map<symbol, Waiter>(), queued: [] };
      this.slots.set(kind, slot);
    }
    return slot;
  }

  private abortWaiter(waiter: Waiter): void {
    if (waiter.state !== "queued") return;
    waiter.state = "cancelled";
    waiter.signal.removeEventListener("abort", waiter.abort);
    const slot = this.slot(waiter.kind);
    const index = slot.queued.findIndex(
      (candidate) => candidate.token === waiter.token
    );
    if (index >= 0) slot.queued.splice(index, 1);
    waiter.reject(new AgentQueueAbortedError());
    this.drain(waiter.kind);
  }

  private drain(kind: AgentKind): void {
    const slot = this.slot(kind);

    while (
      slot.active.size < this.capacity &&
      slot.queued.length > 0
    ) {
      const waiter = slot.queued.shift()!;
      if (waiter.state !== "queued") continue;
      if (waiter.signal.aborted) {
        waiter.state = "cancelled";
        waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.reject(new AgentQueueAbortedError());
        continue;
      }

      waiter.state = "granted";
      waiter.signal.removeEventListener("abort", waiter.abort);
      slot.active.set(waiter.token, waiter);
      let released = false;
      waiter.resolve({
        release: () => {
          if (released) return;
          released = true;
          if (
            waiter.state !== "granted" ||
            slot.active.get(waiter.token)?.token !== waiter.token
          ) {
            return;
          }
          waiter.state = "released";
          slot.active.delete(waiter.token);
          this.drain(kind);
        }
      });
    }
  }
}

function compareWaiters(left: Waiter, right: Waiter): number {
  const byQueueOrder = left.queueOrder - right.queueOrder;
  if (byQueueOrder !== 0) return byQueueOrder;
  return left.order - right.order;
}
