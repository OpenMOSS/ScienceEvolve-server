/** Browser trace cards stay bounded independently from durable handoff files. */
export const ASSISTANT_DISPLAY_CHARACTER_LIMIT = 200_000;

/** Upper bound for one durable natural-language Agent handoff. */
export const HANDOFF_CHARACTER_LIMIT = 1_000_000;

/** Prefix truncation that never leaves a UTF-16 surrogate pair split. */
export function truncateUnicodePrefix(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let end = Math.max(0, maximum);
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}
