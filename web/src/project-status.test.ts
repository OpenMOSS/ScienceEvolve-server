import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { runtimeDisplayState, type RuntimeDisplayState } from "../../server/src/internal/shared/project-runtime-status.js";
import { normalizeStatus } from "./lib";
import { isProjectViewStatus, PROJECT_VIEW_STATUSES } from "./project-status";

const serverTypes = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../server/src/types.ts"), "utf8");

function lifecycleStatuses(source: string): string[] {
  const ast = ts.createSourceFile("server/src/types.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find((node): node is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(node) && node.name.text === "ProjectStatus");
  if (!declaration || !ts.isUnionTypeNode(declaration.type)) {
    throw new Error("Locate the ProjectStatus literal union in server/src/types.ts before updating the ownership check");
  }
  return declaration.type.types.map(node => {
    if (!ts.isLiteralTypeNode(node) || !ts.isStringLiteral(node.literal)) {
      throw new Error("ProjectStatus ownership check needs a literal union, not an unexamined alias");
    }
    return node.literal.text;
  });
}

function missingViewStatuses(source: string): string[] {
  return lifecycleStatuses(source).filter(value => !isProjectViewStatus(value));
}

const lifecycleDisplay: Record<string, RuntimeDisplayState> = {
  queued: "queued", running: "running", retrying: "retrying",
  interrupting: "stopping", interrupted: "interrupted", pausing: "stopping",
  paused: "paused", cancelling: "stopping", cancelled: "stopped", completed: "completed"
};

describe("project status ownership", () => {
  it("covers the actual Server lifecycle and only the retained Web display extensions", () => {
    expect(missingViewStatuses(serverTypes)).toEqual([]);
    expect(new Set(PROJECT_VIEW_STATUSES)).toEqual(new Set([
      ...lifecycleStatuses(serverTypes), "draft", "stopping", "stopped", "failed"
    ]));
    expect(new Set(PROJECT_VIEW_STATUSES).size).toBe(PROJECT_VIEW_STATUSES.length);
    expect(Object.keys(lifecycleDisplay).sort()).toEqual(lifecycleStatuses(serverTypes).sort());
  });

  it("detects a new Server state and refuses an unexamined definition move", () => {
    expect(missingViewStatuses('export type ProjectStatus = "queued" | "future-project-state";')).toEqual(["future-project-state"]);
    expect(() => lifecycleStatuses("export type ProjectStatus = AnotherStatus;")).toThrow(/literal union/);
    expect(() => lifecycleStatuses("export type OtherStatus = 'queued';")).toThrow(/Locate the ProjectStatus/);
  });

  it.each(PROJECT_VIEW_STATUSES)("preserves %s and its existing API case folding", value => {
    expect(isProjectViewStatus(value)).toBe(true);
    expect(normalizeStatus(value)).toBe(value);
    expect(normalizeStatus(value.toUpperCase())).toBe(value);
    expect(isProjectViewStatus(value.toUpperCase())).toBe(false);
  });

  it.for([undefined, null, false, 0, [], {}, "", "unknown", " running ", "__proto__", "constructor",
    "active", "pending", "assigned", "succeeded", "merged", "skipped", "superseded", "waiting"])(
    "retains the draft fallback for unknown or other-object input %j", value => {
      expect(isProjectViewStatus(value)).toBe(false);
      expect(normalizeStatus(value)).toBe("draft");
    }
  );

  it.each(Object.entries(lifecycleDisplay))("keeps the complete %s display mapping", (status, display) => {
    expect(runtimeDisplayState(status)).toBe(display);
  });
});
