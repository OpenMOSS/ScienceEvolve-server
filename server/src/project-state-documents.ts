import type { ActiveAgentExecution, ProjectState } from "./types.js";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { containsCredentialMaterial, isSensitiveCredentialKey, redactTrace } from "./utils.js";

export type ProjectStateDocumentName = "project.checkpoint" | "sii.ledger" | "serial.invocation" | "invocation.commit";
export interface ProjectStateDomain {
  projectId: string;
  protocol: "project-state-v1";
  scheduler: "git" | "serial";
  createdAt: string;
}
export interface ProjectStateDocument {
  projectId: string;
  name: ProjectStateDocumentName;
  revision: number;
  version: string;
  updatedAt: string;
  value: unknown;
}
/** System writers share this store; these methods are never direct MCP tools. */
export interface ProjectStateDocumentStore {
  /** Fixed service configuration, never selected by a project or Agent. */
  source?: { protocol: "project-state-v1"; kind: "sqlite"; databasePath: string };
  domain(projectId: string): ProjectStateDomain | undefined;
  read(projectId: string, name: ProjectStateDocumentName): ProjectStateDocument | undefined;
  write(projectId: string, name: ProjectStateDocumentName, value: unknown, expectedVersion: string,
    publishView?: (document: ProjectStateDocument) => void): ProjectStateDocument;
}

/** Independent readers do not acquire a writer lease, migrate the database or
 * use exported views as a fallback. An unavailable registered source is an error. */
export function readOnlyProjectStateDocuments(source: NonNullable<ProjectStateDocumentStore["source"]>): ProjectStateDocumentStore {
  const query = <T>(read: (database: DatabaseSync) => T): T => {
    const database = new DatabaseSync(source.databasePath, { readOnly: true });
    try { return read(database); } finally { database.close(); }
  };
  return { source,
    domain: projectId => query(database => {
      const row = database.prepare("SELECT * FROM project_state_domains WHERE project_id=?").get(projectId);
      return row ? { projectId, protocol: "project-state-v1", scheduler: row.scheduler as ProjectStateDomain["scheduler"], createdAt: String(row.created_at) } : undefined;
    }),
    read: (projectId, name) => query(database => {
      const row = database.prepare("SELECT * FROM project_state_documents WHERE project_id=? AND document_name=?").get(projectId, name);
      return row ? { projectId, name, revision: Number(row.revision), version: String(row.version), updatedAt: String(row.updated_at), value: JSON.parse(String(row.value_json)) } : undefined;
    }),
    write: () => { throw new Error("Formal state writes require the current lease-fenced runtime"); }
  };
}
export interface ProjectStateCheckpointProjection {
  version: string;
  revision: number;
  lifecycle: Partial<ProjectState>;
  activeAgentExecution?: ActiveAgentExecution;
}
export interface SerialProjectStateInvocation {
  projectId: string;
  agentId: string;
  invocationId: string;
  executionId: string;
  kind: "main" | "worker";
}
export interface UnifiedProjectStateProjection {
  domain: ProjectStateDomain;
  checkpoint: ProjectStateCheckpointProjection;
  experiments: { version: string; revision: number; ledger: import("./sii-experiments.js").SiiExperimentDocument };
  serialInvocation?: SerialProjectStateInvocation;
  serialExecutions: ActiveAgentExecution[];
  invocationCommit: ReturnType<typeof projectStateCommitProjection>;
}

export function projectStateCommitProjection(document: ProjectStateDocument): {
  version: string; revision: number; invocationId?: string; status: "idle" | "in_progress" | "committed"; startedAt?: string; committedAt?: string;
} {
  const journal = document.value as { invocationId: string; status: "in_progress" | "committed"; startedAt: string; committedAt?: string } | null;
  return { version: document.version, revision: document.revision, ...(journal ? {
    invocationId: journal.invocationId, status: journal.status, startedAt: journal.startedAt,
    ...(journal.committedAt ? { committedAt: journal.committedAt } : {}) } : { status: "idle" }) };
}

/** Explicit view envelope also makes an old binary fail closed rather than
 * resume new SQLite projects from an obsolete file copy. */
export function publishProjectStateDocumentView(file: string, document: ProjectStateDocument): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ id: document.projectId,
      formalState: { protocol: "project-state-v1", source: "sqlite", document: document.name,
        version: document.version, revision: document.revision }, view: document.value }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } catch (error) { try { unlinkSync(temporary); } catch { /* Preserve publication failure. */ } throw error; }
}

// Private checkpoints can contain Gateway credentials. Only owned lifecycle
// and task fields enter the public projection. Configuration and Git/scoped
// facts retain their existing authoritative tables and publication gates.
export function projectStateCheckpointProjection(document: ProjectStateDocument,
  scheduler: ProjectStateDomain["scheduler"] = "serial"): ProjectStateCheckpointProjection {
  const state = document.value as ProjectState;
  const fields = ["status", "phase", "createdAt", "updatedAt", "currentAgent", "queuedAgent", "queueEnteredAt", "queueOrder",
    "activeInvocationId", "turn", "cycle", "eventSeq", "consecutiveFailures", "retryAt", "workflowRecovery", "lastError", "completionGeneration",
    "runCounts", "executionCounts", "loopIterations", "loopBatches", "loopTotalIterations", "mainInvocationSeq", "pauseRequest",
    "cancellationRequestedAt", "cancellationSettledAt", "cancelledAt", "completedAt", "cancelledBy", "cancelReason",
    "taskCompletions", "agentSessions", "agentSessionIds", "agentSessionMeta", "taskSessionRefs", "taskSessionIds", "tokenUsage", "computeUsage"] as const;
  // Git derives live status and invocation identity from collaboration
  // tables. A saved checkpoint can lag those fields and must not advertise
  // its copy as current lifecycle. Checkpoint-owned counters, intent,
  // Sessions, private bytes and exact document CAS remain available.
  const collaborationOwned = new Set<string>(["status", "phase", "currentAgent", "activeInvocationId"]);
  const lifecycle = Object.fromEntries(fields.filter(k => state[k] !== undefined &&
    (scheduler !== "git" || !collaborationOwned.has(k))).map(k => [k, structuredClone(state[k])])) as Partial<ProjectState>;
  return projectStatePublicValue({ version: document.version, revision: document.revision, lifecycle,
    ...(state.activeAgentExecution ? { activeAgentExecution: structuredClone(state.activeAgentExecution) } : {}) }) as ProjectStateCheckpointProjection;
}

/** Public views omit credential fields; private source documents retain the
 * already-redacted original tool payload, without changing its wire return. */
export function projectStatePublicValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (!containsCredentialMaterial(value)) return value;
    try { return JSON.stringify(projectStatePublicValue(JSON.parse(value))); } catch { /* Plain diagnostics. */ }
    const redacted = redactTrace(value);
    return containsCredentialMaterial(redacted) ? "[REDACTED]" : redacted;
  }
  if (Array.isArray(value)) return value.map(projectStatePublicValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isSensitiveCredentialKey(key)).map(([key, item]) => [key, projectStatePublicValue(item)]));
  return value;
}

/** SII already redacts its wire payload. Preserve those exact masked fields
 * and native history strings privately, while rejecting actual credentials. */
export function projectStateToolValueIsRedacted(value: unknown): boolean {
  if (typeof value === "string") return !containsCredentialMaterial(value.replace(/(["'])\[REDACTED\]\1/g, "[REDACTED]"));
  if (Array.isArray(value)) return value.every(projectStateToolValueIsRedacted);
  if (value && typeof value === "object") return Object.entries(value).every(([key, item]) =>
    isSensitiveCredentialKey(key) ? item === "[REDACTED]" : projectStateToolValueIsRedacted(item));
  return true;
}

/** Structural changes avoid copying a complete ledger on every heartbeat.
 * Paths and array indices carry storage structure, not business semantics. */
export function projectDocumentChanges(before: unknown, after: unknown, path: Array<string | number> = []): unknown[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === "object" && typeof after === "object" && Array.isArray(before) === Array.isArray(after)) {
    const left = before as Record<string, unknown>, right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(key =>
      projectDocumentChanges(left[key], right[key], [...path, Array.isArray(before) ? Number(key) : key]));
  }
  return [{ path, ...(before === undefined ? { beforeAbsent: true } : { before }), ...(after === undefined ? { afterAbsent: true } : { after }) }];
}
