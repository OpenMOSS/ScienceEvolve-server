import {
  boundedPreview,
  contentText,
  diagnosticEvent,
  eventArray,
  eventRecord,
  eventString,
  normalizedUsage,
  safeEventText,
  type HarnessEventDraft,
  type OfficialEventMapper
} from "../official-event-bridge.js";
import { claudeProgressCallId } from "../claude-tool-progress.js";

/** Shallow mapping of Claude Code's official stream-json envelopes. */
export const mapClaudeCodeOfficialEvent: OfficialEventMapper = (event) => {
  const type = eventString(event.type) ?? "unknown";
  if (type === "system") {
    return [{
      kind: "lifecycle",
      sourceType: `${type}.${eventString(event.subtype) ?? "event"}`,
      message: "session initialized"
    }];
  }
  if (type === "assistant") {
    const message = eventRecord(event.message);
    const drafts: HarnessEventDraft[] = [];
    for (const blockValue of eventArray(message?.content)) {
      const block = eventRecord(blockValue);
      if (!block) continue;
      if (block.type === "text") {
        const text = safeEventText(block.text);
        if (text) drafts.push({ kind: "assistant.message", sourceType: type, message: text });
      } else if (block.type === "tool_use") {
        const name = eventString(block.name) ?? "tool";
        const callId = requiredCallId(block.id, "tool_use.id");
        drafts.push({
          kind: "tool.started",
          sourceType: type,
          message: name,
          tool: {
            callId,
            name,
            toolType: "other",
            status: "started",
            ...(block.input !== undefined ? { input: block.input } : {})
          }
        });
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        drafts.push({ kind: "activity", sourceType: type });
      }
    }
    const usage = normalizedUsage(message?.usage, "anthropic-messages");
    if (usage) drafts.push({ kind: "usage", sourceType: type, usage });
    return drafts;
  }
  if (type === "user") {
    const message = eventRecord(event.message);
    const content = eventArray(message?.content);
    if (message?.role === "user" && !content.some(value => eventRecord(value)?.type === "tool_result")) {
      const text = contentText(message.content);
      return text ? [{ kind: "user.message", sourceType: type, message: text }] : [];
    }
    return eventArray(message?.content).flatMap((blockValue): HarnessEventDraft[] => {
      const block = eventRecord(blockValue);
      if (!block || block.type !== "tool_result") return [];
      const failed = block.is_error === true;
      const content = block.content ?? "";
      const bounded = boundedPreview(contentText(content) || content);
      const callId = requiredCallId(block.tool_use_id, "tool_result.tool_use_id");
      return [{
        kind: failed ? "tool.failed" : "tool.completed",
        sourceType: type,
        message: "tool result",
        tool: {
          callId,
          name: eventString(block.name) ?? "tool",
          toolType: "other",
          status: failed ? "failed" : "completed",
          outputPreview: bounded.text,
          truncated: bounded.truncated,
          ...(failed ? { isError: true } : {})
        }
      }];
    });
  }
  if (type === "stream_event") return mapClaudeStream(eventRecord(event.event));
  if (type === "tool_progress") {
    return [{
      kind: "tool.updated",
      sourceType: type,
      itemId: requiredCallId(event.tool_use_id, "tool_progress.tool_use_id"),
      tool: {
        callId: requiredCallId(claudeProgressCallId(event), "tool_progress.parent_tool_use_id/tool_use_id"),
        name: eventString(event.tool_name) ?? "tool",
        toolType: "other",
        status: "updated"
      }
    }];
  }
  if (type === "result") {
    if (event.is_error === true) {
      return [diagnosticEvent(
        type,
        safeEventText(event.result) || "Claude Code failed",
        "error"
      )];
    }
    return [{ kind: "lifecycle", sourceType: type, message: "result completed" }];
  }
  return [];
};

function mapClaudeStream(event: Record<string, unknown> | undefined): HarnessEventDraft[] {
  if (!event) return [];
  const type = eventString(event.type) ?? "stream_event";
  const delta = eventRecord(event.delta);
  if (delta?.type === "text_delta") {
    const message = safeEventText(delta.text);
    return message ? [{ kind: "assistant.delta", sourceType: type, message }] : [];
  }
  if (delta?.type === "thinking_delta" || delta?.type === "signature_delta") {
    return [{ kind: "activity", sourceType: type }];
  }
  const block = eventRecord(event.content_block);
  if (type === "content_block_start" && block?.type === "tool_use") {
    const name = eventString(block.name) ?? "tool";
    const callId = requiredCallId(block.id, "content_block.id");
    return [{
      kind: "tool.started",
      sourceType: type,
      message: name,
      tool: {
        callId,
        name,
        toolType: "other",
        status: "started"
      }
    }];
  }
  if (delta?.type === "input_json_delta") {
    return [{ kind: "activity", sourceType: type }];
  }
  return [];
}

function requiredCallId(value: unknown, field: string): string {
  const callId = eventString(value)?.trim();
  if (!callId) throw new Error(`Claude Code official tool event is missing ${field}`);
  return callId;
}
