/** Pure trace decoding and grouping; React owns rendering and navigation state. */
import type { AgentEvent } from "./types";


interface CanonicalTraceEvent {
  schemaVersion: 1;
  eventId: string;
  seq?: number;
  invocationId: string;
  harnessId: string;
  kind: string;
  phase?: string;
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
    ...(typeof record.seq === "number" ? { seq: record.seq } : {}),
    invocationId: record.invocationId,
    harnessId: record.harnessId,
    kind: record.kind,
    ...(typeof record.phase === "string" ? { phase: record.phase } : {}),
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
  if (["workflow.node.started", "workflow.node.completed", "session.started", "iteration.started"].includes(event.type)) return true;
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
  contentKind?: "summary";
  tools: AgentEvent[];
  displayState?: "streaming" | "process" | "final" | "incomplete";
}

interface PlainTraceEntry {
  kind: "event";
  id: string;
  event: AgentEvent;
}

export interface AgentExecutionEntry {
  kind: "execution";
  id: string;
  event: AgentEvent;
  updates: AgentEvent[];
  state: "waiting" | "processing" | "completed" | "failed" | "interrupted" | "incomplete";
  updatedAt: string;
}

export type TraceEntry = AgentActivityEntry | PlainTraceEntry | AgentExecutionEntry;

function eventAgent(event: AgentEvent): string {
  return event.agent ?? event.agentId ?? (traceDataString(event, "agentId") || "system");
}

function eventInvocation(event: AgentEvent): string {
  return canonicalTraceEvent(event)?.invocationId ?? event.invocationId ?? traceDataString(event, "invocationId");
}

const EXECUTION_START_TYPES = new Set([
  "invocation.started", "agent.started", "agent.execution.started", "collaboration.execution.started"
]);
const EXECUTION_END_TYPES = new Map<string, AgentExecutionEntry["state"]>([
  ["invocation.completed", "completed"], ["agent.completed", "completed"],
  ["collaboration.execution.completed", "completed"], ["agent.execution.ended", "completed"],
  ["invocation.failed", "failed"], ["agent.failed", "failed"], ["collaboration.execution.failed", "failed"],
  ["agent.interrupted", "interrupted"]
]);

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
  if (canonicalTraceEvent(event)?.kind === "reasoning.summary" || canonicalTraceEvent(event)?.kind === "activity") return false;
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
  if (!tool?.outputPreview?.trim()) return undefined;
  return {
    text: tool.outputPreview,
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
  const invocationId = eventInvocation(event);
  const itemId = canonical?.kind.startsWith("tool.")
    ? canonical.parentItemId
    : canonical?.itemId;
  return JSON.stringify([eventAgent(event), invocationId || "legacy", canonical?.attempt ?? 0,
    canonical?.kind === "reasoning.summary" ? "summary" : "message", itemId || (canonical?.kind === "reasoning.summary" ? canonical.eventId : "legacy")]);
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
  const activeTools = new Map<string, { entry: AgentActivityEntry; index: number }>();
  const groupsByInvocation = new Map<string, AgentActivityEntry[]>();
  const completedInvocations = new Set<string>();
  const executions = new Map<string, AgentExecutionEntry>();
  const seenEvents = new Set<string>();
  const invocationAliases = new Map<string, Set<string>>();
  const identity = (event: AgentEvent, value: string) => JSON.stringify([eventAgent(event), value]);
  for (const event of events) {
    const executionId = event.executionId ?? traceDataString(event, "executionId");
    const invocationId = eventInvocation(event);
    if (!executionId || !invocationId) continue;
    const alias = identity(event, executionId);
    const invocations = invocationAliases.get(alias) ?? new Set<string>();
    invocations.add(invocationId);
    invocationAliases.set(alias, invocations);
  }
  const executionKey = (event: AgentEvent): string | undefined => {
    const invocationId = eventInvocation(event);
    if (invocationId) return identity(event, invocationId);
    const executionId = event.executionId ?? traceDataString(event, "executionId");
    if (!executionId) return undefined;
    const invocations = invocationAliases.get(identity(event, executionId));
    // An execution can contain multiple real invocations. Only an unambiguous
    // identity relation can associate its outer lifecycle with one wake-up.
    if (invocations?.size === 1) return identity(event, [...invocations][0]!);
    if (invocations && invocations.size > 1) return undefined;
    return identity(event, `execution:${executionId}`);
  };
  const updateExecution = (event: AgentEvent, state: AgentExecutionEntry["state"], create: boolean) => {
    const key = executionKey(event);
    if (!key) return false;
    let entry = executions.get(key);
    if (!entry && create) {
      entry = { kind: "execution", id: `execution-${key}`, event, updates: [], state, updatedAt: event.ts };
      executions.set(key, entry);
      entries.push(entry);
    }
    if (!entry) return false;
    const canonical = canonicalTraceEvent(event);
    if (!canonical) entry.updates.push(event);
    if (Date.parse(event.ts) >= Date.parse(entry.updatedAt)) entry.updatedAt = event.ts;
    if ((!["failed", "interrupted", "completed", "incomplete"].includes(entry.state) &&
      !(entry.state === "processing" && state === "waiting")) || state === "failed" || state === "interrupted") entry.state = state;
    return true;
  };
  const createActivity = (event: AgentEvent, thought?: AgentEvent): AgentActivityEntry => {
    const canonical = canonicalTraceEvent(event);
    const itemKey = canonical?.kind.startsWith("tool.") ? canonical.tool?.callId
      : canonical?.itemId ?? (canonical?.kind === "reasoning.summary" ? canonical.eventId : undefined);
    const entry: AgentActivityEntry = {
      kind: "activity",
      id: canonical && itemKey
        ? `activity-${JSON.stringify([eventAgent(event), canonical.invocationId, canonical.attempt ?? 0,
            canonical.kind.startsWith("tool.") ? "tool" : canonical.kind === "reasoning.summary" ? "summary" : "message", itemKey])}`
        : `activity-${event.seq}`,
      event, thought, tools: [],
      ...(canonical?.kind === "reasoning.summary" ? { contentKind: "summary" as const } : {})
    };
    entries.push(entry);
    activeGroups.set(activityStreamKey(event), entry);
    const invocationId = eventInvocation(event);
    if (invocationId && entry.contentKind !== "summary") {
      const key = identity(event, invocationId);
      const groups = groupsByInvocation.get(key) ?? [];
      groups.push(entry);
      groupsByInvocation.set(key, groups);
    }
    return entry;
  };

  for (const event of events) {
    if (isHiddenReasoningTraceEvent(event)) continue;
    const canonical = canonicalTraceEvent(event);
    if (canonical) {
      const key = JSON.stringify([eventAgent(event), canonical.invocationId, canonical.attempt ?? 0, canonical.eventId]);
      if (seenEvents.has(key)) continue;
      seenEvents.add(key);
    }
    const performance = event.data?.performance as { status?: string } | undefined;
    const endState = EXECUTION_END_TYPES.get(event.type) ?? (event.type === "invocation.performance"
      ? performance?.status === "completed" ? "completed" : performance?.status === "incomplete" ? "incomplete" : undefined
      : undefined);
    if (EXECUTION_START_TYPES.has(event.type) || endState) {
      if (!eventInvocation(event)) {
        for (const [key, group] of activeGroups) {
          if (!eventInvocation(group.event) && eventAgent(group.event) === eventAgent(event)) activeGroups.delete(key);
        }
      }
      if (endState === "completed" && eventInvocation(event)) {
        completedInvocations.add(identity(event, eventInvocation(event)));
      }
      if (updateExecution(event, endState ?? "waiting", true)) continue;
    }
    if (canonical?.kind === "activity") {
      updateExecution(event, "processing", true);
      continue;
    }
    if (canonical?.kind === "reasoning.summary") {
      const streamKey = activityStreamKey(event);
      const previous = activeGroups.get(streamKey);
      if (!event.message.trim() && !(canonical.phase === "delta" && previous?.thought && event.message.length)) continue;
      updateExecution(event, "processing", false);
      const group = previous ?? createActivity(event);
      group.thought = canonical.phase === "delta" && event.data?.liveEphemeral !== true
        ? appendAssistantDelta(group.thought, event) : event;
      continue;
    }
    const streamKey = activityStreamKey(event);
    if (isAssistantDeltaEvent(event) || isThoughtEvent(event)) {
      if (!event.message.trim() && !(isAssistantDeltaEvent(event) && activeGroups.has(streamKey) && event.message.length)) continue;
      updateExecution(event, "processing", false);
      const group = activeGroups.get(streamKey) ?? createActivity(event);
      group.thought = isAssistantDeltaEvent(event) && event.data?.livePhase === undefined
        ? appendAssistantDelta(group.thought, event) : event;
      continue;
    }
    if (isToolEvent(event)) {
      updateExecution(event, "processing", false);
      const itemId = canonical?.tool?.callId ?? traceDataString(event, "itemId");
      const status = canonical?.tool?.status ?? traceDataString(event, "status").toLowerCase();
      const toolIdentity = canonical && itemId
        ? JSON.stringify([eventAgent(event), canonical.invocationId, canonical.attempt ?? 0, itemId])
        : `${streamKey}:${itemId || `${traceDataString(event, "itemType")}:${toolCommand(event)}`}`;
      const activeTool = activeTools.get(toolIdentity);
      if (activeTool) {
        activeTool.entry.tools[activeTool.index] = mergeCanonicalToolEvents(activeTool.entry.tools[activeTool.index]!, event);
        if (!canonical && (status === "completed" || status === "failed")) activeTools.delete(toolIdentity);
        continue;
      }
      let group = activeGroups.get(streamKey);
      if (!group || (!canonical?.parentItemId && group.tools.length >= 4)) group = createActivity(event);
      const index = group.tools.push(event) - 1;
      if (canonical || (status !== "completed" && status !== "failed")) activeTools.set(toolIdentity, { entry: group, index });
      continue;
    }
    entries.push({ kind: "event", id: `event-${event.seq}`, event });
  }
  for (const [invocationKey, groups] of groupsByInvocation) {
    const lastAttempt = Math.max(...groups.map(group => canonicalTraceEvent(group.event)?.attempt ?? 0));
    for (const group of groups) {
      const data = (group.thought ?? group.event).data ?? {};
      const canonical = canonicalTraceEvent(group.thought ?? group.event);
      if ((canonical?.attempt ?? 0) < lastAttempt || data.incompleteOutput === true || data.livePhase === "incomplete" || canonical?.sourceType === "assistant.incomplete") {
        group.displayState = "incomplete";
      } else if (data.liveRole === "final") {
        group.displayState = "final";
      } else if (data.livePhase === "streaming" || canonical?.kind === "assistant.delta") {
        group.displayState = "streaming";
      } else {
        group.displayState = "process";
      }
    }
    if (completedInvocations.has(invocationKey)) {
      const finalGroup = [...groups].reverse().find(group => Boolean(group.thought?.message.trim()) && group.displayState !== "incomplete");
      const response = finalGroup?.thought;
      if (finalGroup && response && response.data?.liveRole !== "process" && !isAssistantDeltaEvent(response)) {
        const responseSeq = canonicalTraceEvent(response)?.seq ?? response.seq;
        const toolsFollowResponse = groups.some(group => group.tools.some(tool =>
          (canonicalTraceEvent(tool)?.seq ?? tool.seq) > responseSeq));
        if (!toolsFollowResponse || finalGroup.displayState === "final") finalGroup.displayState = "final";
      }
      for (const group of groups) if (group.displayState === "streaming") group.displayState = "process";
    }
  }
  return entries;
}
