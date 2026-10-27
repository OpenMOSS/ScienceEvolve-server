/** Pure trace decoding and grouping; React owns rendering and navigation state. */
import type { AgentEvent } from "./types";


interface CanonicalTraceEvent {
  schemaVersion: 1;
  eventId: string;
  invocationId: string;
  harnessId: string;
  kind: string;
  sourceType?: string;
  attempt?: number;
  itemId?: string;
  parentItemId?: string;
  message?: string;
  messageTruncated?: boolean;
  tool?: {
    callId: string;
    name: string;
    status: "started" | "updated" | "completed" | "failed";
    input?: unknown;
    outputPreview?: string;
    truncated?: boolean;
    isError?: boolean;
  };
  diagnostic?: {
    source?: string;
    level?: string;
    message?: string;
  };
}

export function canonicalTraceEvent(event: AgentEvent): CanonicalTraceEvent | undefined {
  const value = event.data?.canonicalEvent;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.eventId !== "string" ||
    typeof record.invocationId !== "string" ||
    typeof record.harnessId !== "string" ||
    typeof record.kind !== "string"
  ) return undefined;
  const rawTool = record.tool;
  const toolRecord = rawTool && typeof rawTool === "object" && !Array.isArray(rawTool)
    ? rawTool as Record<string, unknown>
    : undefined;
  const status = toolRecord?.status;
  const tool: CanonicalTraceEvent["tool"] = toolRecord &&
    typeof toolRecord.callId === "string" &&
    typeof toolRecord.name === "string" &&
    (status === "started" || status === "updated" || status === "completed" || status === "failed")
      ? {
          callId: toolRecord.callId,
          name: toolRecord.name,
          status,
          ...(toolRecord.input === undefined ? {} : { input: toolRecord.input }),
          ...(typeof toolRecord.outputPreview === "string" ? { outputPreview: toolRecord.outputPreview } : {}),
          ...(toolRecord.truncated === true ? { truncated: true } : {}),
          ...(toolRecord.isError === true ? { isError: true } : {})
        }
      : undefined;
  return {
    schemaVersion: 1,
    eventId: record.eventId,
    invocationId: record.invocationId,
    harnessId: record.harnessId,
    kind: record.kind,
    ...(typeof record.sourceType === "string" ? { sourceType: record.sourceType } : {}),
    ...(typeof record.attempt === "number" ? { attempt: record.attempt } : {}),
    ...(typeof record.itemId === "string" ? { itemId: record.itemId } : {}),
    ...(typeof record.parentItemId === "string"
      ? { parentItemId: record.parentItemId }
      : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(record.messageTruncated === true ? { messageTruncated: true } : {}),
    ...(tool ? { tool } : {}),
    ...(record.diagnostic && typeof record.diagnostic === "object" && !Array.isArray(record.diagnostic)
      ? { diagnostic: record.diagnostic as CanonicalTraceEvent["diagnostic"] }
      : {})
  };
}

export function isDiagnosticTraceEvent(event: AgentEvent): boolean {
  const canonical = canonicalTraceEvent(event);
  if (canonical?.kind === "diagnostic" || event.data?.diagnostic === true) return true;
  const source = traceDataString(event, "diagnosticSource").toLowerCase();
  if (source === "proxy" || source === "cli" || source === "adapter") return true;
  const legacyKind = traceDataString(event, "kind").toLowerCase();
  const legacyItemType = traceDataString(event, "itemType").toLowerCase();
  if (legacyKind === "stderr" || legacyKind === "diagnostic" || legacyItemType === "diagnostic") {
    return true;
  }
  return /^protocol proxy\b/i.test(event.message);
}

export interface AgentActivityEntry {
  kind: "activity";
  id: string;
  event: AgentEvent;
  thought?: AgentEvent;
  tools: AgentEvent[];
  displayState?: "streaming" | "process" | "final" | "incomplete";
}

interface PlainTraceEntry {
  kind: "event";
  id: string;
  event: AgentEvent;
}

export type TraceEntry = AgentActivityEntry | PlainTraceEntry;

export function traceDataString(event: AgentEvent, key: string): string {
  const value = event.data?.[key];
  return typeof value === "string" ? value : "";
}

export function traceDataStrings(event: AgentEvent | undefined, key: string): string[] {
  const value = event?.data?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

export function isThoughtEvent(event: AgentEvent): boolean {
  const canonical = canonicalTraceEvent(event);
  if (canonical?.kind === "assistant.message") return true;
  if (event.type !== "agent.trace") return false;
  const kind = traceDataString(event, "kind").toLowerCase();
  const itemType = traceDataString(event, "itemType").toLowerCase();
  return (
    kind === "message" &&
    itemType === "agent_message"
  );
}

export function isHiddenReasoningTraceEvent(event: AgentEvent): boolean {
  if (canonicalTraceEvent(event)?.kind === "activity") return true;
  if (event.type !== "agent.trace") return false;
  const kind = traceDataString(event, "kind").toLowerCase();
  const itemType = traceDataString(event, "itemType").toLowerCase();
  return kind === "reasoning" || [
    "reasoning",
    "thinking",
    "redacted_thinking"
  ].includes(itemType);
}

function isAssistantDeltaEvent(event: AgentEvent): boolean {
  return canonicalTraceEvent(event)?.kind === "assistant.delta";
}

export function isToolEvent(event: AgentEvent): boolean {
  if (canonicalTraceEvent(event)?.kind.startsWith("tool.")) return true;
  return (
    event.type === "agent.trace" &&
    traceDataString(event, "kind").toLowerCase() === "tool"
  );
}

export function thoughtSummary(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ["summary", "assessment", "markdown"]) {
      if (typeof parsed[key] === "string" && parsed[key].trim()) {
        return parsed[key].trim();
      }
    }
  } catch {
    // Historical plain-text traces can start with a brace; show them unchanged.
  }
  return trimmed;
}

export function toolCommand(event: AgentEvent): string {
  const canonical = canonicalTraceEvent(event);
  if (canonical?.tool?.input !== undefined) {
    return typeof canonical.tool.input === "string"
      ? canonical.tool.input
      : safeStructuredPreview(canonical.tool.input);
  }
  if (canonical?.tool?.name) return canonical.tool.name;
  const structured = traceDataString(event, "command");
  if (structured) return structured;
  const status = traceDataString(event, "status");
  if (status && event.message.endsWith(` · ${status}`)) {
    return event.message.slice(0, -(status.length + 3));
  }
  return event.message.replace(/ · (?:in_progress|completed|failed|item\.(?:started|completed))$/, "");
}

export function toolLabel(event: AgentEvent): string {
  const canonical = canonicalTraceEvent(event);
  if (canonical?.tool?.name) return canonical.tool.name;
  const labels: Record<string, string> = {
    command_execution: "Shell 命令",
    mcp_tool_call: "MCP 工具",
    collab_tool_call: "协作工具",
    file_change: "文件修改",
    web_search: "网页搜索"
  };
  const itemType = traceDataString(event, "itemType");
  return labels[itemType] ?? "工具调用";
}

export function toolStatus(event: AgentEvent): { label: string; tone: string } {
  const status = canonicalTraceEvent(event)?.tool?.status
    ?? traceDataString(event, "status").toLowerCase();
  if (status === "completed" || status === "item.completed") {
    return { label: "完成", tone: "completed" };
  }
  if (status === "failed") return { label: "失败", tone: "failed" };
  return { label: "运行中", tone: "running" };
}

export function toolOutput(event: AgentEvent): { text: string; truncated: boolean } | undefined {
  const tool = canonicalTraceEvent(event)?.tool;
  if (tool?.outputPreview === undefined) return undefined;
  return {
    text: tool.outputPreview === "" ? "（空结果）" : tool.outputPreview,
    truncated: tool.truncated === true
  };
}

function safeStructuredPreview(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function mergeCanonicalToolEvents(previous: AgentEvent, next: AgentEvent): AgentEvent {
  const previousCanonical = canonicalTraceEvent(previous);
  const nextCanonical = canonicalTraceEvent(next);
  if (!previousCanonical?.tool || !nextCanonical?.tool) return next;
  return {
    ...next,
    message: next.message || previous.message,
    data: {
      ...(previous.data ?? {}),
      ...(next.data ?? {}),
      canonicalEvent: {
        ...previousCanonical,
        ...nextCanonical,
        tool: {
          ...previousCanonical.tool,
          ...nextCanonical.tool,
          // Some official result envelopes only carry the call ID. Their
          // mappers therefore use the canonical placeholder; never let that
          // erase the real name learned from the matching start event.
          name:
            nextCanonical.tool.name === "tool" && previousCanonical.tool.name !== "tool"
              ? previousCanonical.tool.name
              : nextCanonical.tool.name,
          input: nextCanonical.tool.input ?? previousCanonical.tool.input,
          outputPreview:
            nextCanonical.tool.outputPreview ?? previousCanonical.tool.outputPreview,
          truncated:
            nextCanonical.tool.truncated ?? previousCanonical.tool.truncated
        }
      }
    }
  };
}

function activityStreamKey(event: AgentEvent): string {
  const canonical = canonicalTraceEvent(event);
  const invocationId = canonical?.invocationId
    ?? traceDataString(event, "invocationId")
    ?? "legacy";
  const itemId = canonical?.kind.startsWith("tool.")
    ? canonical.parentItemId
    : canonical?.itemId;
  return `${event.agent ?? "system"}:${invocationId || "legacy"}:${itemId || "legacy"}`;
}

function appendAssistantDelta(previous: AgentEvent | undefined, next: AgentEvent): AgentEvent {
  if (!previous) return next;
  const previousCanonical = canonicalTraceEvent(previous);
  const nextCanonical = canonicalTraceEvent(next);
  if (!previousCanonical || !nextCanonical) return next;
  const message = `${previousCanonical.message ?? previous.message}${nextCanonical.message ?? next.message}`.slice(-200_000);
  return {
    ...next,
    message,
    data: {
      ...(next.data ?? {}),
      canonicalEvent: { ...nextCanonical, message }
    }
  };
}

export function buildTraceEntries(events: AgentEvent[]): TraceEntry[] {
  const entries: TraceEntry[] = [];
  const activeGroups = new Map<string, AgentActivityEntry>();
  const activeTools = new Map<
    string,
    { entry: AgentActivityEntry; index: number }
  >();
  const groupsByInvocation = new Map<string, AgentActivityEntry[]>();
  const completedInvocations = new Set<string>();

  const createActivity = (
    event: AgentEvent,
    thought?: AgentEvent
  ): AgentActivityEntry => {
    const canonical = canonicalTraceEvent(event);
    const itemKey = canonical?.kind.startsWith("tool.") ? canonical.tool?.callId : canonical?.itemId;
    const entry: AgentActivityEntry = {
      kind: "activity",
      // Durable rows replace ephemeral rows with a different timeline seq.
      // Keep the card mounted so an expanded tool result stays expanded.
      id: canonical && itemKey
        ? `activity-${JSON.stringify([event.agent, canonical.invocationId, canonical.attempt ?? 0,
            canonical.kind.startsWith("tool.") ? "tool" : "message", itemKey])}`
        : `activity-${event.seq}`,
      event,
      thought,
      tools: []
    };
    entries.push(entry);
    activeGroups.set(activityStreamKey(event), entry);
    const invocationId = canonical?.invocationId ?? traceDataString(event, "invocationId");
    if (invocationId) {
      const key = `${event.agent ?? "system"}:${invocationId}`;
      const groups = groupsByInvocation.get(key) ?? [];
      groups.push(entry);
      groupsByInvocation.set(key, groups);
    }
    return entry;
  };

  for (const event of events) {
    // Canonical activity and historical reasoning rows are heartbeats, not
    // display content. In particular, never fall through to EventCard where
    // a legacy raw reasoning message would become visible again.
    if (isHiddenReasoningTraceEvent(event)) continue;
    const streamKey = activityStreamKey(event);
    if (isAssistantDeltaEvent(event)) {
      const group = activeGroups.get(streamKey) ?? createActivity(event);
      group.thought = appendAssistantDelta(group.thought, event);
      continue;
    }
    if (isThoughtEvent(event)) {
      const group = activeGroups.get(streamKey);
      if (group) {
        group.thought = event;
        continue;
      }
      createActivity(event, event);
      continue;
    }
    if (isToolEvent(event)) {
      const canonical = canonicalTraceEvent(event);
      const itemId = canonical?.tool?.callId ?? traceDataString(event, "itemId");
      const status = canonical?.tool?.status ?? traceDataString(event, "status").toLowerCase();
      const legacyIdentity = `${streamKey}:${traceDataString(event, "itemType")}:${toolCommand(event)}`;
      const toolIdentity = itemId ? `${streamKey}:${itemId}` : legacyIdentity;
      const activeTool = activeTools.get(toolIdentity);
      if (activeTool) {
        activeTool.entry.tools[activeTool.index] = mergeCanonicalToolEvents(
          activeTool.entry.tools[activeTool.index]!,
          event
        );
        if (status === "completed" || status === "failed") {
          activeTools.delete(toolIdentity);
        }
        continue;
      }
      let group = activeGroups.get(streamKey);
      if (!group || (!canonical?.parentItemId && group.tools.length >= 4)) {
        group = createActivity(event);
      }
      const index = group.tools.push(event) - 1;
      if (status !== "completed" && status !== "failed") {
        activeTools.set(toolIdentity, { entry: group, index });
      }
      continue;
    }

    entries.push({ kind: "event", id: `event-${event.seq}`, event });
    if (event.type === "invocation.completed" || event.type === "agent.completed") {
      const invocationId = traceDataString(event, "invocationId");
      if (invocationId) completedInvocations.add(`${event.agent ?? "system"}:${invocationId}`);
    }
    if (
      event.type === "agent.started" ||
      event.type === "agent.completed" ||
      event.type === "agent.failed"
    ) {
      activeGroups.delete(streamKey);
    }
  }
  for (const [invocationKey, groups] of groupsByInvocation) {
    for (const group of groups) {
      const data = (group.thought ?? group.event).data ?? {};
      const canonical = canonicalTraceEvent(group.thought ?? group.event);
      if (data.incompleteOutput === true || canonical?.sourceType === "assistant.incomplete") {
        group.displayState = "incomplete";
      } else if (data.liveRole === "process" || group.tools.length > 0) {
        group.displayState = "process";
      } else if (data.livePhase === "streaming") {
        group.displayState = "streaming";
      } else if (data.liveRole === "final") {
        group.displayState = "final";
      }
    }
    if (completedInvocations.has(invocationKey)) {
      const finalGroup = [...groups].reverse().find((group) =>
        Boolean(group.thought) && group.displayState !== "incomplete"
      );
      if (finalGroup && finalGroup.displayState !== "process") {
        finalGroup.displayState = "final";
      }
    }
  }
  return entries;
}
