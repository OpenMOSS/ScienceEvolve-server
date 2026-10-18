import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENTS, DEFAULT_AGENT_ORCHESTRATION } from "./lib";
import { clearWorkflowAdjustmentOperation, loadWorkflowAdjustmentDraft, loadWorkflowAdjustmentOperation, newWorkflowAdjustmentDraft,
  saveWorkflowAdjustmentDraft, saveWorkflowAdjustmentOperation, workflowDraftRecommendationSnapshot } from "./workflowAdjustmentDraft";

const current = () => ({ version: { revision: 7, hash: "a".repeat(64) }, snapshot: {
  orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION), agents: structuredClone(DEFAULT_AGENTS), skillDefinitions: {}, mcpDefinitions: {} } });
beforeEach(() => localStorage.clear());
describe("project workflow drafts and unconfirmed operations", () => {
  it("restores complete edits, original base and unfinished text independently for each project", () => {
    const first = newWorkflowAdjustmentDraft("first/project", current());
    first.snapshot.agents.main.instructions = "原草稿\n不能静默换底"; first.explanation = "用户公开说明";
    first.textDrafts["instructions"] = { path: ["agents", "main", "instructions"], value: "尚未失焦的完整输入" };
    saveWorkflowAdjustmentDraft(localStorage, first); saveWorkflowAdjustmentDraft(localStorage, newWorkflowAdjustmentDraft("second", current()));
    expect(loadWorkflowAdjustmentDraft(localStorage, "first/project")).toEqual({ kind: "found", value: first });
    expect(loadWorkflowAdjustmentDraft(localStorage, "second")).toEqual({ kind: "found", value: newWorkflowAdjustmentDraft("second", current()) });
    expect(first.base.revision).toBe(7); expect(first.baseSnapshot.agents.main.instructions).not.toBe(first.snapshot.agents.main.instructions);
  });
  it("keeps new formal versions separate from the saved original draft and base", () => {
    const draft = newWorkflowAdjustmentDraft("first", current()); saveWorkflowAdjustmentDraft(localStorage, draft);
    const newer = current(); newer.version.revision++; newer.snapshot.agents.main.instructions = "Main已正式应用的新指令";
    expect(newWorkflowAdjustmentDraft("first", newer).base.revision).toBe(8);
    expect(loadWorkflowAdjustmentDraft(localStorage, "first")).toEqual({ kind: "found", value: draft });
  });
  it.each(["{", JSON.stringify({ schemaVersion: 99 }), JSON.stringify({ ...newWorkflowAdjustmentDraft("other", current()) }),
    JSON.stringify({ ...newWorkflowAdjustmentDraft("first", current()), snapshot: { orchestration: { agents: [] }, agents: {}, skillDefinitions: {}, mcpDefinitions: {} } })])("preserves an invalid or foreign cache instead of resetting it (%s)", raw => {
    const key = "openfars.workflow-adjustment.v1.first.draft"; localStorage.setItem(key, raw);
    expect(loadWorkflowAdjustmentDraft(localStorage, "first").kind).toBe("invalid"); expect(localStorage.getItem(key)).toBe(raw);
  });
  it("holds the complete submission identity/body across reload and rejects replacement while unconfirmed", () => {
    const draft = newWorkflowAdjustmentDraft("first", current());
    const operation = { kind: "submit" as const, input: { requestId: "same-request", base: draft.base, proposal: draft.snapshot, explanation: "原请求" } };
    saveWorkflowAdjustmentOperation(localStorage, "first", operation);
    expect(loadWorkflowAdjustmentOperation(localStorage, "first")).toEqual({ kind: "found", value: operation });
    expect(() => saveWorkflowAdjustmentOperation(localStorage, "first", { ...operation, input: { ...operation.input, requestId: "different" } })).toThrow("待确认");
    expect(() => saveWorkflowAdjustmentOperation(localStorage, "first", { ...operation, input: { ...operation.input, explanation: "改写旧请求" } })).toThrow("待确认");
    saveWorkflowAdjustmentOperation(localStorage, "first", operation);
    clearWorkflowAdjustmentOperation(localStorage, "first", { ...operation, input: { ...operation.input, requestId: "foreign" } });
    expect(loadWorkflowAdjustmentOperation(localStorage, "first").kind).toBe("found");
    clearWorkflowAdjustmentOperation(localStorage, "first", operation); expect(loadWorkflowAdjustmentOperation(localStorage, "first")).toEqual({ kind: "empty" });
  });
  it("preserves an exact withdrawal operation and does not invent an omitted reason", () => {
    const operation = { kind: "withdraw" as const, requestId: "main-request", input: { operationId: "same-withdraw" } };
    saveWorkflowAdjustmentOperation(localStorage, "first", operation);
    expect(loadWorkflowAdjustmentOperation(localStorage, "first")).toEqual({ kind: "found", value: operation });
    expect(operation.input).not.toHaveProperty("note");
  });
  it("uses all unfinished instruction fields for recommendations while keeping the editable snapshot separate", () => {
    const draft = newWorkflowAdjustmentDraft("first", current()), before = structuredClone(draft.snapshot);
    for (const id of ["main", "idea"]) draft.textDrafts[id] = { path: ["agents", id, "instructions"], value: `最新未失焦草稿 ${id}` };
    const recommended = workflowDraftRecommendationSnapshot(draft);
    for (const id of ["main", "idea"]) expect(recommended.agents[id].instructions).toBe(`最新未失焦草稿 ${id}`);
    expect(draft.snapshot).toEqual(before);
  });
  it("reports storage failure without claiming persistence or deleting the previous draft", () => {
    const draft = newWorkflowAdjustmentDraft("first", current()); saveWorkflowAdjustmentDraft(localStorage, draft);
    const storage = { getItem: localStorage.getItem.bind(localStorage), setItem() { throw new DOMException("quota", "QuotaExceededError"); } } as unknown as Storage;
    expect(() => saveWorkflowAdjustmentDraft(storage, { ...draft, explanation: "new" })).toThrow("quota");
    expect(loadWorkflowAdjustmentDraft(localStorage, "first")).toEqual({ kind: "found", value: draft });
  });
  it("keeps a legal 2 MiB base, draft and identical pending proposal within Chromium's 5 MiB quota", () => {
    const context = current();
    context.snapshot.agents.main.instructions = "a".repeat(20_000);
    context.snapshot.skillDefinitions = { large: { files: { "SKILL.md": "# Large reference\n",
      "first.txt": "a".repeat(500_000), "second.txt": "b".repeat(500_000) } } };
    context.snapshot.mcpDefinitions = { large: { command: "node", entrypoint: "tool.mjs", args: [], envFrom: {},
      files: { "tool.mjs": "// Unselected resource\n", "first.txt": "c".repeat(500_000), "second.txt": "d".repeat(500_000) } } };
    const remaining = 2 * 1024 * 1024 - new TextEncoder().encode(JSON.stringify(context.snapshot)).length;
    (context.snapshot.skillDefinitions as { large: { files: Record<string, string> } }).large.files["SKILL.md"] += "e".repeat(remaining);
    const draft = newWorkflowAdjustmentDraft("large", context);
    draft.snapshot.agents.main.instructions = draft.snapshot.agents.main.instructions.replace(/./u, "x");
    expect(new TextEncoder().encode(JSON.stringify(draft.baseSnapshot)).length).toBe(2 * 1024 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(draft.snapshot)).length).toBe(2 * 1024 * 1024);
    const operation = { kind: "submit" as const, input: { requestId: "original-large-request", base: draft.base,
      proposal: structuredClone(draft.snapshot), explanation: "说明".repeat(10_000) } };
    saveWorkflowAdjustmentDraft(localStorage, draft);
    saveWorkflowAdjustmentOperation(localStorage, draft.projectId, operation);
    expect(loadWorkflowAdjustmentDraft(localStorage, draft.projectId)).toEqual({ kind: "found", value: draft });
    expect(loadWorkflowAdjustmentOperation(localStorage, draft.projectId)).toEqual({ kind: "found", value: operation });
    let characters = 0;
    for (let index = 0; index < localStorage.length; index++) {
      const name = localStorage.key(index)!; characters += name.length + localStorage.getItem(name)!.length;
    }
    expect(characters).toBeLessThan(5 * 1024 * 1024);
  });
  it("reads legacy caches without mutation and migrates both complete records on the next edit", () => {
    const draft = newWorkflowAdjustmentDraft("first", current());
    const operation = { kind: "submit" as const, input: { requestId: "original-legacy-request", base: draft.base,
      proposal: structuredClone(draft.snapshot), explanation: "原完整请求" } };
    const draftKey = "openfars.workflow-adjustment.v1.first.draft", operationKey = "openfars.workflow-adjustment.v1.first.operation";
    const rawDraft = JSON.stringify(draft), rawOperation = JSON.stringify(operation);
    localStorage.setItem(draftKey, rawDraft); localStorage.setItem(operationKey, rawOperation);
    expect(loadWorkflowAdjustmentDraft(localStorage, "first")).toEqual({ kind: "found", value: draft });
    expect(loadWorkflowAdjustmentOperation(localStorage, "first")).toEqual({ kind: "found", value: operation });
    expect(localStorage.getItem(draftKey)).toBe(rawDraft); expect(localStorage.getItem(operationKey)).toBe(rawOperation);
    draft.snapshot.agents.main.instructions = "继续编辑，不修改在途请求";
    saveWorkflowAdjustmentDraft(localStorage, draft);
    expect(loadWorkflowAdjustmentDraft(localStorage, "first")).toEqual({ kind: "found", value: draft });
    expect(loadWorkflowAdjustmentOperation(localStorage, "first")).toEqual({ kind: "found", value: operation });
    expect(localStorage.getItem(operationKey)).toBeNull();
    clearWorkflowAdjustmentOperation(localStorage, "first", operation);
    expect(loadWorkflowAdjustmentOperation(localStorage, "first")).toEqual({ kind: "empty" });
    expect(loadWorkflowAdjustmentDraft(localStorage, "first")).toEqual({ kind: "found", value: draft });
  });
  it("preserves an unknown complete proposal when another window saves a different draft", () => {
    const draft = newWorkflowAdjustmentDraft("first", current()); saveWorkflowAdjustmentDraft(localStorage, draft);
    const operation = { kind: "submit" as const, input: { requestId: "original-unknown-request", base: draft.base,
      proposal: structuredClone(draft.snapshot), explanation: "不可改写" } };
    saveWorkflowAdjustmentOperation(localStorage, "first", operation);
    const otherWindow = newWorkflowAdjustmentDraft("first", current());
    otherWindow.snapshot.agents.main.instructions = "另一个窗口的后续草稿";
    saveWorkflowAdjustmentDraft(localStorage, otherWindow);
    expect(loadWorkflowAdjustmentOperation(localStorage, "first")).toEqual({ kind: "found", value: operation });
    expect(() => saveWorkflowAdjustmentOperation(localStorage, "first", { ...operation, input: { ...operation.input,
      proposal: otherWindow.snapshot } })).toThrow("待确认");
    expect(loadWorkflowAdjustmentDraft(localStorage, "first")).toEqual({ kind: "found", value: otherWindow });
  });
  it("preserves both legacy records when the migration cannot commit", () => {
    const draft = newWorkflowAdjustmentDraft("first", current());
    const operation = { kind: "submit" as const, input: { requestId: "original-request", base: draft.base, proposal: draft.snapshot } };
    const draftKey = "openfars.workflow-adjustment.v1.first.draft", operationKey = "openfars.workflow-adjustment.v1.first.operation";
    const rawDraft = JSON.stringify(draft), rawOperation = JSON.stringify(operation);
    localStorage.setItem(draftKey, rawDraft); localStorage.setItem(operationKey, rawOperation);
    const storage = { getItem: localStorage.getItem.bind(localStorage), setItem() { throw new DOMException("quota", "QuotaExceededError"); },
      removeItem() { throw new Error("Cleanup must not run before commit"); } } as unknown as Storage;
    expect(() => saveWorkflowAdjustmentDraft(storage, { ...draft, explanation: "new" })).toThrow("quota");
    expect(localStorage.getItem(draftKey)).toBe(rawDraft); expect(localStorage.getItem(operationKey)).toBe(rawOperation);
  });
  it("does not resurrect a confirmed legacy operation when cleanup fails", () => {
    const draft = newWorkflowAdjustmentDraft("first", current());
    const operation = { kind: "withdraw" as const, requestId: "main-request", input: { operationId: "original-withdrawal" } };
    const operationKey = "openfars.workflow-adjustment.v1.first.operation";
    localStorage.setItem("openfars.workflow-adjustment.v1.first.draft", JSON.stringify(draft));
    localStorage.setItem(operationKey, JSON.stringify(operation));
    const storage = { getItem: localStorage.getItem.bind(localStorage), setItem: localStorage.setItem.bind(localStorage),
      removeItem() { throw new Error("cleanup failed"); } } as unknown as Storage;
    saveWorkflowAdjustmentDraft(storage, draft);
    clearWorkflowAdjustmentOperation(storage, "first", operation);
    expect(localStorage.getItem(operationKey)).not.toBeNull();
    expect(loadWorkflowAdjustmentOperation(localStorage, "first")).toEqual({ kind: "empty" });
    expect(loadWorkflowAdjustmentDraft(localStorage, "first")).toEqual({ kind: "found", value: draft });
  });
  it("restores shared snapshots as independently editable values", () => {
    const draft = newWorkflowAdjustmentDraft("first", current()); saveWorkflowAdjustmentDraft(localStorage, draft);
    const loaded = loadWorkflowAdjustmentDraft(localStorage, "first");
    expect(loaded.kind).toBe("found");
    if (loaded.kind !== "found") throw new Error("Missing draft");
    loaded.value.snapshot.agents.main.instructions = "later edit";
    expect(loaded.value.baseSnapshot).toEqual(draft.baseSnapshot);
    expect(loadWorkflowAdjustmentDraft(localStorage, "first")).toEqual({ kind: "found", value: draft });
  });
  it("preserves malformed snapshot references and refuses to overwrite an unreadable pending proposal", () => {
    const draft = newWorkflowAdjustmentDraft("first", current()); saveWorkflowAdjustmentDraft(localStorage, draft);
    const operation = { kind: "submit" as const, input: { requestId: "original-request", base: draft.base, proposal: draft.snapshot } };
    saveWorkflowAdjustmentOperation(localStorage, "first", operation);
    const draftKey = "openfars.workflow-adjustment.v1.first.draft", value = JSON.parse(localStorage.getItem(draftKey)!);
    value.operation.input.proposal = 99;
    const raw = JSON.stringify(value); localStorage.setItem(draftKey, raw);
    expect(loadWorkflowAdjustmentOperation(localStorage, "first").kind).toBe("invalid");
    expect(() => saveWorkflowAdjustmentDraft(localStorage, { ...draft, explanation: "new" })).toThrow("无法读取");
    expect(() => saveWorkflowAdjustmentOperation(localStorage, "first", operation)).toThrow("待确认");
    expect(localStorage.getItem(draftKey)).toBe(raw);
  });
});
