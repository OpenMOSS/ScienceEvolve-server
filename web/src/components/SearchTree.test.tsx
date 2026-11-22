import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { SearchTreeEditor, SearchTreePanel } from "./SearchTree";
import { normalizeProject, normalizeSavedResearchTasks } from "../lib";
import type { SearchTreeConfig } from "../types";
import { searchTreeRequest } from "../api";
vi.mock("../api", () => ({ searchTreeRequest: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const config: SearchTreeConfig = { root: { name: "Initial" }, directions: [{ id: "speed", kind: "direction", name: "Speed", parentId: "root" }] };
describe("optional search tree", () => {
  it("preserves planning through project and saved-task normalization", () => {
    expect(normalizeProject({ id: "p", searchTree: config }).searchTree).toEqual(config);
    expect(normalizeProject({ id: "p" })).not.toHaveProperty("searchTree");
    expect(normalizeSavedResearchTasks({ tasks: [{ schemaVersion: 2, kind: "scienceevolve-saved-research-task", id: "t",
      title: "Task", requirement: "Research", createdAt: "now", updatedAt: "now", searchTree: config }] })[0].searchTree).toEqual(config);
    expect(() => normalizeProject({ searchTree: { ...config, directions: [{ ...config.directions[0], parentId: "speed" }] } })).toThrow("cycle");
  });
  it("supports an empty root and nested initial planning without experiment fields", () => {
    function Editor() { const [value, setValue] = useState<SearchTreeConfig>(); return <SearchTreeEditor value={value} onChange={setValue} />; }
    render(<Editor />);
    fireEvent.click(screen.getByRole("checkbox", { name: "启用搜索树" }));
    expect(screen.getByRole("textbox", { name: "根节点名称" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "添加方向" }));
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "添加方向" }));
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
  });
  it("fetches candidate details only when selected and shows explicit read errors", async () => {
    vi.mocked(searchTreeRequest).mockResolvedValueOnce({ revision: "a".repeat(40), root: { id: "root", kind: "root", name: "Initial" },
      nodes: [...config.directions, { id: "cache", kind: "candidate", parentId: "speed", name: "Cache" }] }).mockRejectedValueOnce(new Error("revision unavailable"));
    render(<SearchTreePanel projectId="p" />);
    fireEvent.click(screen.getByText("搜索树与探索记录"));
    fireEvent.click(await screen.findByRole("button", { name: "候选：Cache" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("revision unavailable");
    expect(searchTreeRequest).toHaveBeenNthCalledWith(2, "p", { operation: "node", nodeId: "cache" });
  });
});
