import { describe, expect, it } from "vitest";
import { sessionRecoveryNote } from "../src/internal/shared/session-recovery.js";

describe("shared Session recovery policy", () => {
  it("requires durable evidence checks before repeating side effects", () => {
    const note = sessionRecoveryNote("the native Session was replaced");

    expect(note).toContain("A missing tool response does not mean the operation did not run");
    expect(note).toContain("command output, files, logs, published artifacts, handoff, checkpoint, and Memory.md");
    expect(note).toContain("repeat only the unfinished part");
    expect(note).toContain("which operation is uncertain");
    expect(note).toContain("Recovery reason: the native Session was replaced");
  });
});
