import { randomUUID } from "node:crypto";
import { CollaborationStateError } from "./collaboration-state/errors.js";
import { projectStateDigest, type ProjectStateKind, type ProjectStateListItem, type ProjectStatePrincipal } from "./project-state.js";

interface ReadSnapshot {
  id: string;
  owner: string;
  kind?: ProjectStateKind;
  projectRevision: number;
  expiresAt: number;
  objects: ProjectStateListItem[];
  bytes: number;
}

/** Ephemeral complete index snapshots. Every read still requires a live invocation
 * and current authority; snapshots never authorize writes or restore a role. */
export class ProjectStateReadSnapshots {
  private readonly snapshots = new Map<string, ReadSnapshot>();
  private bytes = 0;
  constructor(private readonly now: () => number, private readonly ttlMs = 10 * 60_000) {}

  capture(principal: ProjectStatePrincipal, kind: ProjectStateKind | undefined, projectRevision: number,
    objects: ProjectStateListItem[]): ReadSnapshot {
    this.expire();
    const owner = projectStateDigest(principal);
    const owned = [...this.snapshots.values()].filter(s => s.owner === owner);
    // Retain concurrent per-kind reads without keeping every repeated index.
    while (owned.length >= 16) this.remove(owned.shift()!.id);
    const snapshot: ReadSnapshot = { id: randomUUID(), owner, kind, projectRevision,
      expiresAt: this.now() + this.ttlMs, objects: structuredClone(objects), bytes: Buffer.byteLength(JSON.stringify(objects)) };
    this.snapshots.set(snapshot.id, snapshot); this.bytes += snapshot.bytes;
    // Keep a single large project's index usable even if it exceeds the cache budget.
    while (this.snapshots.size > 64 || (this.bytes > 16 * 1024 * 1024 && this.snapshots.size > 1))
      this.remove(this.snapshots.keys().next().value!);
    return snapshot;
  }

  read(id: string, principal: ProjectStatePrincipal, kind?: ProjectStateKind): ReadSnapshot {
    this.expire();
    const snapshot = this.snapshots.get(id);
    if (!snapshot || snapshot.owner !== projectStateDigest(principal))
      throw new CollaborationStateError("STATE_READ_SNAPSHOT_EXPIRED",
        "Read snapshot is unavailable or expired. Start a fresh state_list without snapshotId or expectedRevision to get the complete index.",
        { invalidField: "snapshotId", nextCall: { tool: "state_list", arguments: { ...(kind ? { kind } : {}) } } });
    if (kind !== undefined && kind !== snapshot.kind)
      throw new CollaborationStateError("INVALID_STATE_TRANSITION", "A read snapshot keeps its original kind filter. Reuse that kind and snapshotId or start a fresh state_list.",
        { invalidField: "kind", nextCall: { tool: "state_list", arguments: { kind } } });
    return snapshot;
  }

  clear(): void { this.snapshots.clear(); this.bytes = 0; }
  private remove(id: string): void {
    const snapshot = this.snapshots.get(id);
    if (snapshot) { this.bytes -= snapshot.bytes; this.snapshots.delete(id); }
  }
  private expire(): void {
    const now = this.now();
    for (const snapshot of this.snapshots.values()) if (snapshot.expiresAt <= now) this.remove(snapshot.id);
  }
}
