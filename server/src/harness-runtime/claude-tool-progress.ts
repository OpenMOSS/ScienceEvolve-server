/** Native tool heartbeats have their own tool_use_id; the parent identifies
 * the still-running business call. Direct progress may omit that parent. */
export function claudeProgressCallId(frame: Readonly<Record<string, unknown>>): string | undefined {
  const progressId = frame.tool_use_id;
  const callId = frame.parent_tool_use_id ?? progressId;
  const valid = (value: unknown): value is string => typeof value === "string" &&
    value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
  return valid(progressId) && valid(callId) ? callId : undefined;
}
