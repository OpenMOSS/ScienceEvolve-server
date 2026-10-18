/** Repeated text is stored once inside the same native input. Paths identify
 * exactly the replaced string values; user objects are never interpreted as
 * reference markers merely because they happen to have a matching key. */
export function shareWorkflowNotificationText(original: string): string {
  if (Buffer.byteLength(original, "utf8") < 128 * 1024) return original;
  const newline = original.indexOf("\n");
  if (newline < 0) return original;
  let data: unknown;
  try { data = JSON.parse(original.slice(newline + 1)); } catch { return original; }
  const counts = new Map<string, number>();
  const count = (value: unknown): void => {
    if (typeof value === "string" && value.length >= 256) counts.set(value, (counts.get(value) ?? 0) + 1);
    else if (Array.isArray(value)) value.forEach(count);
    else if (value && typeof value === "object") Object.values(value).forEach(count);
  };
  count(data);
  const ids = new Map<string, string>(), texts: Record<string, string> = {};
  const references: Array<{ path: Array<string | number>; textId: string }> = [];
  const encode = (value: unknown, path: Array<string | number>): unknown => {
    if (typeof value === "string" && (counts.get(value) ?? 0) > 1) {
      let textId = ids.get(value);
      if (!textId) { textId = `text${ids.size + 1}`; ids.set(value, textId); texts[textId] = value; }
      references.push({ path, textId });
      return { sharedText: textId };
    }
    if (Array.isArray(value)) return value.map((item, index) => encode(item, [...path, index]));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, encode(item, [...path, key])]));
    return value;
  };
  const encoded = { encoding: "openfars-shared-text-v1", data: encode(data, []), references, texts };
  if (!references.length) return original;
  const result = original.slice(0, newline) + " This input uses openfars-shared-text-v1: data contains the complete records; " +
    "replace each sharedText marker at the exact path in references with the verbatim string in texts[textId]. " +
    "All proposal and diff content is included in this input. Objects outside those exact paths keep their literal meaning.\n" + JSON.stringify(encoded);
  return Buffer.byteLength(result, "utf8") < Buffer.byteLength(original, "utf8") ? result : original;
}
