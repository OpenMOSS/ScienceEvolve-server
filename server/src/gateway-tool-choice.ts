/** Convert a sole required Chat tool to its equivalent named choice. */
export function specifiedToolChoiceFallback(
  url: string,
  requestBody: BodyInit | null | undefined
): string | undefined {
  if (!/\/chat\/completions\/?(?:\?|$)/.test(url) || typeof requestBody !== "string") return undefined;
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(requestBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    body = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (body.tool_choice !== "required" || !Array.isArray(body.tools) || body.tools.length !== 1) return undefined;
  const tool = body.tools[0];
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return undefined;
  const entry = tool as Record<string, unknown>;
  const fn = entry.function;
  if (entry.type !== "function" || !fn || typeof fn !== "object" || Array.isArray(fn)) return undefined;
  const name = (fn as Record<string, unknown>).name;
  if (typeof name !== "string" || !name.trim()) return undefined;
  return JSON.stringify({ ...body, tool_choice: { type: "function", function: { name } } });
}

export function requiredToolChoiceRejected(status: number, errorText: string): boolean {
  return (status === 400 || status === 422) && /tool[_\s-]?choice/i.test(errorText);
}
