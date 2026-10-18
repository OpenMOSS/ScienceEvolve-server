import type { ProjectExplainerEvent } from "../types";

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
    event.data?.automaticRecovery || event.data?.protocolRecovery);
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
  return { phase: "working", text: "正在处理…" };
}

/** Fold the same canonical items for both Explainer surfaces and history reloads. */
export function mergeExplainerMessages(events: ProjectExplainerEvent[], incoming: ProjectExplainerEvent): ProjectExplainerEvent[] {
  if (events.some(event => event.id === incoming.id || receivedIds.get(event)?.has(incoming.id))) return events;
  const mergeable = incoming.itemId && ["assistant", "reasoning", "tool", "tool_output"].includes(incoming.kind);
  const index = mergeable ? events.findIndex(event => event.kind === incoming.kind && event.turnId === incoming.turnId && event.itemId === incoming.itemId) : -1;
  if (index < 0) return [...events, incoming];
  const prior = events[index];
  const merged = mergeMessage(prior, incoming);
  receivedIds.set(merged, new Set([...(receivedIds.get(prior) ?? [prior.id]), incoming.id]));
  const next = [...events]; next[index] = merged; return next;
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
