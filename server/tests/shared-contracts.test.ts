import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveMainCapabilities,
  SHARED_RUNTIME_EVENT_NAMES,
  type MainCapabilityInput,
  type MainCapabilitySnapshot
} from "../src/internal/shared/contracts.js";

interface FixtureCase extends MainCapabilityInput {
  expected: MainCapabilitySnapshot;
}

const fixture = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "shared-contracts.json"), "utf8")
) as Record<string, FixtureCase>;
const sourceFingerprints = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "shared-source-fingerprints.json"), "utf8")
) as { schemaVersion: 1; files: Record<string, string> };

describe("shared host contracts", () => {
  for (const [name, testCase] of Object.entries(fixture)) {
    it(`derives the ${name} capability snapshot`, () => {
      const { expected, ...input } = testCase;
      expect(deriveMainCapabilities(input)).toEqual(expected);
    });
  }

  it("keeps the published loop and reconfiguration event names stable", () => {
    expect(SHARED_RUNTIME_EVENT_NAMES).toEqual([
      "workflow.loop.batch.started",
      "workflow.loop.iteration",
      "workflow.loop.exhausted",
      "workflow.reconfigured"
    ]);
  });

  it("keeps every host-neutral core pinned to the cross-host source fingerprint", () => {
    const sharedRoot = path.join(import.meta.dirname, "..", "src", "internal", "shared");
    for (const [file, expected] of Object.entries(sourceFingerprints.files)) {
      const source = fs.readFileSync(path.join(sharedRoot, file), "utf8").replace(/\r\n/g, "\n");
      const actual = createHash("sha256").update(source).digest("hex");
      expect(actual, file).toBe(expected);
    }
  });
});
