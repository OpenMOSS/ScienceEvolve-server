import type { ProjectExplainerEvent } from "../types";
import type { ExplainerAssistantAction } from "../api";
import { invalidateResource, removeCachedResource } from "../resource-cache";
import { EXPLAINER_ACTION_KINDS } from "../../../server/src/internal/shared/explainer-tools.js";

const receivedIds = new WeakMap<ProjectExplainerEvent, ReadonlySet<string>>();

/** Operational status stays in history; Agent actions and user configuration notices remain visible. */
export function isExplainerConversationMessage(event: ProjectExplainerEvent): boolean {
  if (event.kind === "error" && event.data?.diagnostic && event.phase === "delta") return false;
  return event.kind !== "status" || Boolean(event.data?.assistantAction) ||
    !event.data?.diagnostic && (event.data?.interrupted === true || event.data?.nativeSessionRebuilt === true);
}

export interface ExplainerReplyProgress {
  phase: "working" | "completed" | "stopped" | "failed";
  text: string;
  toolName?: string;
}

/** Derive one product status from event semantics, never native diagnostic text. */
export function explainerReplyProgress(events: ProjectExplainerEvent[], active: boolean): ExplainerReplyProgress | undefined {
  const turnId = events.at(-1)?.turnId;
  const turn = events.filter(event => event.turnId === turnId);
  const reverse = [...turn].reverse();
  const terminal = reverse.find(event =>
    event.kind === "error" && event.phase !== "delta" && event.phase !== "started" ||
    event.kind === "status" && (event.data?.turnComplete === true ||
      !event.data?.diagnostic && !event.data?.assistantAction && event.phase === "completed" &&
      (event.data?.interrupted === true || ["回答完成", "解说已停止。"].includes(event.text.trim()))));
  if (!active) {
    if (!terminal) return undefined;
    if (terminal.kind === "error") return { phase: "failed", text: "回答失败" };
    if (terminal.data?.interrupted === true || terminal.text.trim() === "解说已停止。") return { phase: "stopped", text: "已停止" };
    return { phase: "completed", text: "回答完成" };
  }
  const latest = terminal ? undefined : reverse.find(event =>
    ["assistant", "reasoning", "tool", "tool_output"].includes(event.kind) || event.data?.assistantAction ||
    event.data?.automaticRecovery || event.data?.protocolRecovery || event.data?.stage || event.data?.modelActivity);
  if (latest?.data?.automaticRecovery || latest?.data?.protocolRecovery) return { phase: "working", text: "工具参数格式有误，正在自动恢复…" };
  if (latest?.kind === "tool") {
    const tool = (latest.data?.canonicalEvent as { tool?: { name?: string; status?: string; isError?: boolean } } | undefined)?.tool;
    if (latest.phase === "completed" || tool?.isError || ["completed", "failed"].includes(tool?.status ?? ""))
      return { phase: "working", text: "正在处理工具结果…" };
    return { phase: "working", text: "正在调用工具…", toolName: tool?.name ?? latest.text };
  }
  if (latest?.kind === "tool_output") return { phase: "working", text: "正在处理工具结果…" };
  if (latest?.kind === "reasoning") return { phase: "working", text: "正在思考…" };
  if (latest?.kind === "assistant") return { phase: "working", text: "正在生成回复…" };
  if (latest?.data?.assistantAction) return { phase: "working", text: "正在整理操作结果…" };
  if (latest?.data?.stage === "preparing-context") return { phase: "working", text: "正在准备对话上下文…" };
  if (latest?.data?.stage === "connecting-model") return { phase: "working", text: "正在连接模型…" };
  if (latest?.data?.modelActivity) return { phase: "working", text: "模型正在处理…" };
  return { phase: "working", text: "正在处理…" };
}

/** Fold the same canonical items for both Explainer surfaces and history reloads. */
export function mergeExplainerMessages(events: ProjectExplainerEvent[], incoming: ProjectExplainerEvent): ProjectExplainerEvent[] {
  if (events.some(event => event.id === incoming.id || receivedIds.get(event)?.has(incoming.id))) return events;
  if (incoming.kind === "user" && !incoming.data?.clientPending) {
    const pending = events.findIndex(event => event.kind === "user" && event.data?.clientPending && event.text === incoming.text);
    if (pending >= 0) { const next = [...events]; next[pending] = incoming; return next; }
  }
  const mergeable = incoming.itemId && ["assistant", "reasoning", "tool", "tool_output"].includes(incoming.kind);
  const index = mergeable ? events.findIndex(event => event.kind === incoming.kind && event.turnId === incoming.turnId && event.itemId === incoming.itemId) : -1;
  if (index < 0) return [...events, incoming];
  const prior = events[index];
  const merged = mergeMessage(prior, incoming);
  receivedIds.set(merged, new Set([...(receivedIds.get(prior) ?? [prior.id]), incoming.id]));
  const next = [...events]; next[index] = merged; return next;
}

/** Both arguments may already contain folded deltas. Reconcile item snapshots;
 * appending an aggregate as a new delta would repeat text or lose newer output. */
export function reconcileExplainerHistory(current: ProjectExplainerEvent[], history: ProjectExplainerEvent[]): ProjectExplainerEvent[] {
  const result = foldExplainerMessages(history);
  const key = (event: ProjectExplainerEvent) => event.itemId && ["assistant", "reasoning", "tool", "tool_output"].includes(event.kind)
    ? JSON.stringify([event.turnId, event.kind, event.itemId]) : event.id;
  const positions = new Map(result.map((event, index) => [key(event), index]));
  for (const event of current) {
    const index = positions.get(key(event));
    if (index === undefined) { positions.set(key(event), result.length); result.push(event); continue; }
    const stored = result[index];
    const storedIds = receivedIds.get(stored) ?? new Set([stored.id]);
    const liveIds = receivedIds.get(event) ?? new Set([event.id]);
    const liveIsNewer = !storedIds.has(event.id) && (stored.phase !== "completed" || event.phase === "completed") &&
      (liveIds.has(stored.id) || Date.parse(event.ts) > Date.parse(stored.ts) ||
        event.phase === "completed" && stored.phase !== "completed" ||
        event.phase === "delta" && stored.phase === "delta" && event.text.length > stored.text.length && event.text.startsWith(stored.text));
    const chosen = liveIsNewer ? event : stored;
    receivedIds.set(chosen, new Set([...storedIds, ...liveIds]));
    result[index] = chosen;
  }
  return result.filter(event => {
    if (!event.data?.clientPending) return true;
    const anchor = event.data.afterUserId;
    const after = anchor ? result.findIndex(item => item.id === anchor) : -1;
    if (anchor && after < 0) return true;
    return !result.slice(after + 1).some(item => item.kind === "user" && !item.data?.clientPending && item.text === event.text);
  }).sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));
}

export function explainerActionFromEvent(event: ProjectExplainerEvent): ExplainerAssistantAction | undefined {
  const action = event.data?.assistantAction as ExplainerAssistantAction | undefined;
  return action?.context?.id && EXPLAINER_ACTION_KINDS.includes(action.kind) ? action : undefined;
}

export function explainerActionHref(action: ExplainerAssistantAction): string | undefined {
  if (action.kind === "drafts.deleted") return undefined;
  if (action.href && /^\/(?:saved-tasks\/task_[a-f0-9]{32}\/edit|projects\/prj_[a-f0-9]{32})$/.test(action.href)) return action.href;
  const taskId = action.savedTask?.id ?? (!action.context.projectId ? action.context.taskId : undefined);
  if (taskId && /^task_[a-f0-9]{32}$/.test(taskId)) return `/saved-tasks/${taskId}/edit`;
  if (action.kind === "workflow.submitted" && action.context.projectId && /^prj_[a-f0-9]{32}$/.test(action.context.projectId)) return `/projects/${action.context.projectId}`;
}

export function notifyExplainerAction(action: ExplainerAssistantAction): void {
  if (action.kind === "drafts.deleted") {
    const deletedTaskIds = action.deletedTasks?.map(task => task.id) ?? [];
    for (const id of deletedTaskIds) removeCachedResource(`saved-task:${id}`);
    invalidateResource("saved-tasks");
    window.dispatchEvent(new CustomEvent("openfars:saved-tasks-changed", { detail: { deletedTaskIds } }));
  } else if (action.savedTask || action.context.taskId && !action.context.projectId) {
    const taskId = action.savedTask?.id ?? action.context.taskId;
    invalidateResource("saved-tasks");
    if (taskId) invalidateResource(`saved-task:${taskId}`);
    window.dispatchEvent(new CustomEvent("openfars:saved-tasks-changed", { detail: { taskId } }));
  }
  if (action.kind === "workflow.submitted") window.dispatchEvent(new CustomEvent("openfars:workflow-adjusted", { detail: { projectId: action.context.projectId } }));
  if (action.kind === "projects.started") window.dispatchEvent(new Event("openfars:projects-started"));
}

export function pendingExplainerMessage(projectId: string, text: string, previous: ProjectExplainerEvent[] = []): ProjectExplainerEvent {
  const id = `local_${crypto.randomUUID()}`;
  const afterUserId = [...previous].reverse().find(event => event.kind === "user" && !event.data?.clientPending)?.id;
  return { id, projectId, turnId: id, ts: new Date().toISOString(), kind: "user", phase: "started", text, data: { clientPending: "sending", afterUserId } };
}

export function restoreExplainerMessages(events: ProjectExplainerEvent[]): ProjectExplainerEvent[] {
  return events.map(event => event.data?.clientPending === "sending"
    ? { ...event, data: { ...event.data, clientPending: "unconfirmed" } } : event);
}

function mergeMessage(prior: ProjectExplainerEvent, incoming: ProjectExplainerEvent): ProjectExplainerEvent {
  const previousCanonical = prior.data?.canonicalEvent as Record<string, unknown> | undefined;
  const canonical = incoming.data?.canonicalEvent as Record<string, unknown> | undefined;
  return { ...prior, ...incoming,
    text: incoming.phase === "delta" && ["assistant", "reasoning"].includes(incoming.kind) ? prior.text + incoming.text : incoming.text || prior.text,
    data: { ...prior.data, ...incoming.data, ...(canonical ? { canonicalEvent: { ...previousCanonical, ...canonical,
      ...(canonical.tool ? { tool: { ...(previousCanonical?.tool as object), ...(canonical.tool as object) } } : {}) } } : {}) } };
}

/** Fold history in one indexed pass instead of copying/scanning it per row. */
export function foldExplainerMessages(events: readonly ProjectExplainerEvent[]): ProjectExplainerEvent[] {
  const result: ProjectExplainerEvent[] = [];
  const seen = new Set<string>();
  const positions = new Map<string, number>();
  const ids = new Map<number, Set<string>>();
  for (const incoming of events) {
    if (seen.has(incoming.id)) continue;
    const key = incoming.itemId && ["assistant", "reasoning", "tool", "tool_output"].includes(incoming.kind)
      ? JSON.stringify([incoming.kind, incoming.turnId, incoming.itemId]) : undefined;
    let index = key === undefined ? undefined : positions.get(key);
    if (index === undefined) {
      index = result.length;
      result.push(incoming);
      if (key !== undefined) positions.set(key, index);
      ids.set(index, new Set());
    } else result[index] = mergeMessage(result[index]!, incoming);
    for (const id of receivedIds.get(incoming) ?? [incoming.id]) {
      seen.add(id);
      ids.get(index)!.add(id);
    }
  }
  for (const [index, values] of ids) receivedIds.set(result[index]!, values);
  return result;
}
