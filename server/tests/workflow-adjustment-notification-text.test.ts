import { describe, expect, it } from "vitest";
import { shareWorkflowNotificationText } from "../src/workflow-adjustment-notification-text.js";

describe("complete shared-text Workflow inputs", () => {
  it("keeps ordinary inputs byte-for-byte unchanged", () => {
    const original = 'Header\n{"records":[{"proposal":{"instructions":"ordinary exact instructions"}}]}';
    expect(shareWorkflowNotificationText(original)).toBe(original);
  });

  it("preserves every nested value, escaped Unicode text, literal reference-shaped object and special key", () => {
    const repeated = '准确原文"\\\n🌈'.repeat(20_000);
    const literal = JSON.parse('{"sharedText":"text1","__proto__":{"sharedText":"literal"},"0":"literal numeric key"}');
    const data = { records: [{ proposal: { instructions: repeated, literal, nested: [{ "0": repeated }] },
      changes: [{ path: ["agents", "0", "instructions"], before: repeated, after: repeated }] }] };
    const original = "Exact input\n" + JSON.stringify(data), text = shareWorkflowNotificationText(original);
    expect(Buffer.byteLength(text)).toBeLessThan(Buffer.byteLength(original));
    const payload = JSON.parse(text.slice(text.indexOf("\n") + 1));
    expect(payload.encoding).toBe("openfars-shared-text-v1");
    const restored = structuredClone(payload.data);
    for (const { path, textId } of payload.references) {
      let parent = restored;
      for (const key of path.slice(0, -1)) parent = parent[key];
      expect(parent[path.at(-1)]).toEqual({ sharedText: textId });
      Object.defineProperty(parent, path.at(-1), { value: payload.texts[textId], enumerable: true, configurable: true, writable: true });
    }
    expect(restored).toEqual(data); expect(restored.records[0].proposal.literal).toEqual(literal);
    expect(Object.getPrototypeOf(restored.records[0].proposal.literal)).toBe(Object.prototype);
  });

  it("keeps large inputs with no repeated text in their original complete representation", () => {
    const original = "Exact input\n" + JSON.stringify({ records: [{ proposal: { instructions: "unique text ".repeat(20_000) } }] });
    expect(shareWorkflowNotificationText(original)).toBe(original);
  });
});
