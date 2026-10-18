import type { WorkflowAdjustmentContext, WorkflowAdjustmentSnapshot, WorkflowAdjustmentSubmission,
  WorkflowAdjustmentWithdrawal, WorkflowConfigurationVersion } from "./workflowAdjustments";

export type CanvasTextDrafts = Record<string, { path: string[]; value: string }>;
export interface WorkflowAdjustmentDraft {
  schemaVersion: 1;
  projectId: string;
  base: WorkflowConfigurationVersion;
  baseSnapshot: WorkflowAdjustmentSnapshot;
  snapshot: WorkflowAdjustmentSnapshot;
  explanation: string;
  textDrafts: CanvasTextDrafts;
}
export type WorkflowAdjustmentPendingOperation = { kind: "submit"; input: WorkflowAdjustmentSubmission }
  | { kind: "withdraw"; requestId: string; input: WorkflowAdjustmentWithdrawal };
export type StoredAdjustment<T> = { kind: "empty" } | { kind: "found"; value: T } | { kind: "invalid"; message: string };
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const version = (value: unknown): value is WorkflowConfigurationVersion => object(value) && Number.isSafeInteger(value.revision) && value.revision > 0 && typeof value.hash === "string" && /^[a-f0-9]{64}$/.test(value.hash);
const snapshot = (value: unknown): value is WorkflowAdjustmentSnapshot => object(value) && object(value.orchestration) && Array.isArray(value.orchestration.agents)
  && value.orchestration.agents.every((agent: unknown) => object(agent) && typeof agent.name === "string")
  && object(value.orchestration.input) && typeof value.orchestration.input.target === "string" && object(value.orchestration.routes)
  && object(value.orchestration.decisionPlans) && object(value.orchestration.termination) && typeof value.orchestration.termination.agent === "string"
  && object(value.agents) && Object.values(value.agents).every(agent => object(agent) && typeof agent.model === "string" && typeof agent.instructions === "string"
    && Array.isArray(agent.skills) && Array.isArray(agent.autoSkills) && Array.isArray(agent.mcpServers))
  && object(value.skillDefinitions) && object(value.mcpDefinitions);
const textDrafts = (value: unknown): value is CanvasTextDrafts => object(value) && Object.values(value).every(item => object(item)
  && Array.isArray(item.path) && item.path.length > 0 && item.path.every((part: unknown) => typeof part === "string") && typeof item.value === "string");
const key = (projectId: string, suffix: string) => `openfars.workflow-adjustment.v1.${encodeURIComponent(projectId)}.${suffix}`;
const invalid = (): StoredAdjustment<never> => ({ kind: "invalid", message: "本地草稿或待确认操作无法读取；原缓存仍保留，请核对后重新建立草稿。" });
function read<T>(raw: string | null, accepts: (value: unknown) => value is T): StoredAdjustment<T> {
  if (raw === null) return { kind: "empty" };
  try { const value: unknown = JSON.parse(raw); if (accepts(value)) return { kind: "found", value }; } catch { /* Preserve the original unreadable value. */ }
  return invalid();
}
const isDraft = (value: unknown, projectId: string): value is WorkflowAdjustmentDraft => object(value) && value.schemaVersion === 1 && value.projectId === projectId
  && version(value.base) && snapshot(value.baseSnapshot) && snapshot(value.snapshot) && typeof value.explanation === "string" && textDrafts(value.textDrafts);
const isOperation = (value: unknown): value is WorkflowAdjustmentPendingOperation => object(value) && object(value.input) && (
  value.kind === "submit" && typeof value.input.requestId === "string" && version(value.input.base) && snapshot(value.input.proposal)
  || value.kind === "withdraw" && typeof value.requestId === "string" && typeof value.input.operationId === "string");
type ProjectCache = { draft: StoredAdjustment<WorkflowAdjustmentDraft>; operation: StoredAdjustment<WorkflowAdjustmentPendingOperation> };

function loadCache(storage: Storage, projectId: string): ProjectCache {
  const raw = storage.getItem(key(projectId, "draft"));
  let value: unknown;
  try { value = raw === null ? undefined : JSON.parse(raw); } catch { /* The legacy reader preserves invalid data. */ }
  if (object(value) && value.schemaVersion === 2) {
    if (value.projectId !== projectId || !Array.isArray(value.snapshots) || !value.snapshots.every(snapshot))
      return { draft: invalid(), operation: invalid() };
    const snapshots = value.snapshots;
    const restore = (index: unknown) => Number.isSafeInteger(index) && (index as number) >= 0
      && (index as number) < snapshots.length ? structuredClone(snapshots[index as number]) : undefined;
    const draft = object(value.draft) ? { ...value.draft, baseSnapshot: restore(value.draft.baseSnapshot), snapshot: restore(value.draft.snapshot) } : value.draft;
    const operation = object(value.operation) && value.operation.kind === "submit" && object(value.operation.input)
      ? { ...value.operation, input: { ...value.operation.input, proposal: restore(value.operation.input.proposal) } } : value.operation;
    // A v2 envelope is authoritative even when empty. A legacy key left by a
    // failed cleanup must never resurrect an already-confirmed operation.
    return {
      draft: draft === undefined ? { kind: "empty" } : isDraft(draft, projectId) ? { kind: "found", value: draft } : invalid(),
      operation: operation === undefined ? { kind: "empty" } : isOperation(operation) ? { kind: "found", value: operation } : invalid()
    };
  }
  return { draft: read(raw, (entry): entry is WorkflowAdjustmentDraft => isDraft(entry, projectId)),
    operation: read(storage.getItem(key(projectId, "operation")), isOperation) };
}

/** Store the draft and exact unknown operation atomically. The base, editable
 * snapshot and submitted proposal share only byte-identical snapshots; later
 * edits cannot change the retained proposal. Two legal 2 MiB snapshots fit the
 * usual 5 MiB localStorage quota without a third copy at submission time. */
function saveCache(storage: Storage, projectId: string, draft?: WorkflowAdjustmentDraft, operation?: WorkflowAdjustmentPendingOperation): void {
  const snapshots: WorkflowAdjustmentSnapshot[] = [], indexes = new Map<string, number>();
  const reference = (value: WorkflowAdjustmentSnapshot) => {
    const serialized = JSON.stringify(value), existing = indexes.get(serialized);
    if (existing !== undefined) return existing;
    const index = snapshots.length; snapshots.push(value); indexes.set(serialized, index); return index;
  };
  const compactDraft = draft && { ...draft, baseSnapshot: reference(draft.baseSnapshot), snapshot: reference(draft.snapshot) };
  const compactOperation = operation?.kind === "submit" ? { ...operation, input: { ...operation.input, proposal: reference(operation.input.proposal) } } : operation;
  storage.setItem(key(projectId, "draft"), JSON.stringify({ schemaVersion: 2, projectId, snapshots, draft: compactDraft, operation: compactOperation }));
  // Migration commits before cleanup, so a failed write preserves both old
  // records. Reads never migrate or rewrite existing browser data.
  try { storage.removeItem(key(projectId, "operation")); } catch { /* The committed envelope remains authoritative. */ }
}
export function newWorkflowAdjustmentDraft(projectId: string, current: WorkflowAdjustmentContext["current"]): WorkflowAdjustmentDraft {
  return { schemaVersion: 1, projectId, base: structuredClone(current.version), baseSnapshot: structuredClone(current.snapshot),
    snapshot: structuredClone(current.snapshot), explanation: "", textDrafts: {} };
}
export function loadWorkflowAdjustmentDraft(storage: Storage, projectId: string): StoredAdjustment<WorkflowAdjustmentDraft> {
  return loadCache(storage, projectId).draft;
}
export function saveWorkflowAdjustmentDraft(storage: Storage, draft: WorkflowAdjustmentDraft): void {
  const stored = loadCache(storage, draft.projectId);
  if (stored.operation.kind === "invalid") throw new Error(stored.operation.message);
  saveCache(storage, draft.projectId, draft, stored.operation.kind === "found" ? stored.operation.value : undefined);
}
export function loadWorkflowAdjustmentOperation(storage: Storage, projectId: string): StoredAdjustment<WorkflowAdjustmentPendingOperation> {
  return loadCache(storage, projectId).operation;
}
const operationIdentity = (value: WorkflowAdjustmentPendingOperation) => value.kind === "submit" ? `submit:${value.input.requestId}` : `withdraw:${value.requestId}:${value.input.operationId}`;
export function saveWorkflowAdjustmentOperation(storage: Storage, projectId: string, value: WorkflowAdjustmentPendingOperation): void {
  const cache = loadCache(storage, projectId), stored = cache.operation;
  if (stored.kind === "invalid" || stored.kind === "found" && JSON.stringify(stored.value) !== JSON.stringify(value))
    throw new Error("已有一项结果待确认的操作，请先查询或重试原操作。");
  if (cache.draft.kind === "invalid") throw new Error(cache.draft.message);
  saveCache(storage, projectId, cache.draft.kind === "found" ? cache.draft.value : undefined, value);
}
export function clearWorkflowAdjustmentOperation(storage: Storage, projectId: string, expected: WorkflowAdjustmentPendingOperation): void {
  const cache = loadCache(storage, projectId), stored = cache.operation;
  if (stored.kind !== "found" || operationIdentity(stored.value) !== operationIdentity(expected)) return;
  if (cache.draft.kind === "invalid") throw new Error(cache.draft.message);
  saveCache(storage, projectId, cache.draft.kind === "found" ? cache.draft.value : undefined);
}
export const sameWorkflowVersion = (a: WorkflowConfigurationVersion, b: WorkflowConfigurationVersion) => a.revision === b.revision && a.hash === b.hash;
export function canvasDraftValue(value: unknown, path: string[]): unknown {
  for (const part of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
/** Recommendation context includes every unfinished text field. Formal submit
 * still requires normal field/shared-identity confirmation first. */
export function workflowDraftRecommendationSnapshot(draft: WorkflowAdjustmentDraft): WorkflowAdjustmentSnapshot {
  const value = structuredClone(draft.snapshot);
  for (const field of Object.values(draft.textDrafts)) {
    const parent = canvasDraftValue(value, field.path.slice(0, -1));
    if (object(parent)) Object.defineProperty(parent, field.path.at(-1)!, { value: field.value, enumerable: true, writable: true, configurable: true });
  }
  return value;
}
