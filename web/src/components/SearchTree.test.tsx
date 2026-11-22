import { StrictMode, useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { SearchTreeEditor, SearchTreePanel } from "./SearchTree";
import { SearchTreeCanvas, searchTreeDescendants } from "./SearchTreeCanvas";
import { normalizeProject, normalizeSavedResearchTasks } from "../lib";
import type { SearchTreeConfig } from "../types";
import { searchTreeRequest } from "../api";
vi.mock("../api", () => ({ searchTreeRequest: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
const config: SearchTreeConfig = { root: { name: "Initial" }, directions: [{ id: "speed", kind: "direction", name: "Speed", parentId: "root" }] };
const revision = "a".repeat(40), nextRevision = "b".repeat(40);
const root = { id: "root" as const, kind: "root" as const, name: "Initial", inputs: [] };
const candidate = { id: "cache", kind: "candidate" as const, parentId: "speed", name: "Cache", goal: "Reduce repeated work", source: "Agent proposal",
  version: { status: "uncommitted" as const }, execution: { status: "succeeded" as const }, evidence: ["reports/run-1.json"], result: { latency: 10 } };
const overview = { revision, root, nodes: config.directions };
function openTree() { fireEvent.click(screen.getByRole("button", { name: "展开搜索树" })); }

describe("optional search tree", () => {
  it("preserves planning through project and saved-task normalization", () => {
    expect(normalizeProject({ id: "p", searchTree: config }).searchTree).toEqual(config);
    expect(normalizeProject({ id: "p" })).not.toHaveProperty("searchTree");
    expect(normalizeSavedResearchTasks({ tasks: [{ schemaVersion: 2, kind: "scienceevolve-saved-research-task", id: "t",
      title: "Task", requirement: "Research", createdAt: "now", updatedAt: "now", searchTree: config }] })[0].searchTree).toEqual(config);
    expect(() => normalizeProject({ searchTree: { ...config, directions: [{ ...config.directions[0], parentId: "speed" }] } })).toThrow("cycle");
  });
  it("opens a visual tree, edits nested initial directions and excludes cyclic parents", () => {
    const change = vi.fn();
    function Editor() { const [value, setValue] = useState<SearchTreeConfig>(); return <SearchTreeEditor value={value} onChange={next => { change(next); setValue(next); }} />; }
    render(<Editor />);
    fireEvent.click(screen.getByRole("checkbox", { name: "启用搜索树" }));
    expect(screen.getByRole("textbox", { name: "根节点名称" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "添加方向" }));
    fireEvent.change(screen.getByRole("textbox", { name: "方向名称" }), { target: { value: "Speed" } });
    fireEvent.click(screen.getByRole("button", { name: "添加子方向" }));
    fireEvent.change(screen.getByRole("textbox", { name: "方向名称" }), { target: { value: "Latency" } });
    const value = change.mock.calls.at(-1)![0] as SearchTreeConfig;
    expect(value.directions[1].parentId).toBe(value.directions[0].id);
    fireEvent.click(screen.getByRole("button", { name: "方向：Speed" }));
    expect(within(screen.getByRole("combobox", { name: "父方向" })).getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "删除方向" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "收起搜索树规划" }));
    fireEvent.click(screen.getByRole("button", { name: "展开搜索树规划" }));
    expect(screen.getByRole("button", { name: "方向：Latency" })).toBeTruthy();
  });
  it("opens existing planning without replacing its node identities or input snapshots", () => {
    const change = vi.fn();
    render(<SearchTreeEditor value={{ ...config, root: { ...config.root, inputFiles: ["seed.csv"] } }} files={[{ path: "seed.csv" }]} onChange={change} />);
    fireEvent.click(screen.getByRole("button", { name: "展开搜索树规划" }));
    expect(screen.getByRole("button", { name: "方向：Speed" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "seed.csv" })).toBeChecked();
    expect(change).not.toHaveBeenCalled();
  });
  it("collapses branches without changing data and computes all descendant exclusions", () => {
    const nodes = [...config.directions, candidate];
    expect([...searchTreeDescendants(nodes, "speed")]).toEqual(["speed", "cache"]);
    render(<SearchTreeCanvas root={root} nodes={nodes} selectedId="speed" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "折叠 Speed" }));
    expect(screen.queryByRole("button", { name: "候选：Cache" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开 Speed" }));
    expect(screen.getByRole("button", { name: "候选：Cache" })).toBeTruthy();
  });
  it("reveals new children inside collapsed branches without losing initial planning", () => {
    function Editor() { const [value, setValue] = useState<SearchTreeConfig>(config); return <SearchTreeEditor value={value} onChange={next => setValue(next!)} />; }
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "展开搜索树规划" }));
    fireEvent.click(screen.getByRole("button", { name: "方向：Speed" }));
    fireEvent.click(screen.getByRole("button", { name: "添加子方向" }));
    fireEvent.change(screen.getByRole("textbox", { name: "方向名称" }), { target: { value: "Latency" } });
    fireEvent.click(screen.getByRole("button", { name: "方向：Speed" }));
    fireEvent.click(screen.getByRole("button", { name: "折叠 Speed" }));
    expect(screen.queryByRole("button", { name: "方向：Latency" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "添加子方向" }));
    expect(screen.getByRole("button", { name: "方向：新方向" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "方向：Latency" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "折叠 Speed" })).toHaveAttribute("aria-expanded", "true");
  });
  it("preserves explicit branch collapse across refreshes and reveals a newly selected descendant", () => {
    const nodes = [...config.directions, candidate];
    const view = render(<SearchTreeCanvas root={root} nodes={nodes} selectedId="cache" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "折叠 Speed" }));
    view.rerender(<SearchTreeCanvas root={root} nodes={[...nodes]} selectedId="cache" onSelect={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "候选：Cache" })).toBeNull();
    view.rerender(<SearchTreeCanvas root={root} nodes={nodes} selectedId="root" onSelect={vi.fn()} />);
    view.rerender(<SearchTreeCanvas root={root} nodes={nodes} selectedId="cache" onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: "候选：Cache" })).toHaveAttribute("aria-pressed", "true");
  });
  it("loads only on expansion and fetches candidate details on demand with explicit errors", async () => {
    vi.mocked(searchTreeRequest).mockResolvedValueOnce({ ...overview, nodes: [...config.directions, candidate] }).mockRejectedValueOnce(new Error("revision unavailable"));
    render(<StrictMode><SearchTreePanel projectId="p" /></StrictMode>);
    expect(searchTreeRequest).not.toHaveBeenCalled();
    openTree();
    fireEvent.click(await screen.findByRole("button", { name: "候选：Cache" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("revision unavailable");
    expect(searchTreeRequest).toHaveBeenNthCalledWith(2, "p", { operation: "node", nodeId: "cache" });
  });
  it("saves user directions to the persistent tree with version checks", async () => {
    vi.mocked(searchTreeRequest).mockResolvedValueOnce(overview).mockImplementationOnce(async (_id, input) => ({ revision: nextRevision, tree: { root, nodes: [...config.directions, input.node] } }));
    render(<SearchTreePanel projectId="p" />); openTree();
    await screen.findByRole("button", { name: "方向：Speed" });
    fireEvent.click(screen.getByRole("button", { name: "新增方向" }));
    expect(screen.queryByRole("button", { name: "删除节点" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "名称" }), { target: { value: "Quality" } });
    fireEvent.click(screen.getByRole("button", { name: "保存节点" }));
    await screen.findByRole("button", { name: "方向：Quality" });
    expect(searchTreeRequest).toHaveBeenLastCalledWith("p", expect.objectContaining({ operation: "put", expectedRevision: revision,
      requestId: expect.any(String), node: expect.objectContaining({ kind: "direction", parentId: "root", name: "Quality" }) }));
  });
  it("keeps unsaved edits when Agent updates arrive and never rebases a stale write silently", async () => {
    vi.useFakeTimers();
    vi.mocked(searchTreeRequest).mockResolvedValueOnce(overview)
      .mockResolvedValueOnce({ revision, node: config.directions[0] })
      .mockResolvedValueOnce({ ...overview, revision: nextRevision, nodes: [...config.directions, candidate] })
      .mockRejectedValueOnce(new Error("Search tree version conflict"));
    render(<SearchTreePanel projectId="p" />);
    await act(async () => { openTree(); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "方向：Speed" })); });
    fireEvent.change(screen.getByRole("textbox", { name: "名称" }), { target: { value: "My unsaved direction" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByRole("button", { name: "候选：Cache" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "名称" })).toHaveValue("My unsaved direction");
    fireEvent.click(screen.getByRole("button", { name: "候选：Cache" }));
    expect(screen.getByText(/当前节点有未保存的修改/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存节点" })); });
    expect(searchTreeRequest).toHaveBeenLastCalledWith("p", expect.objectContaining({ operation: "put", expectedRevision: revision }));
    expect(screen.getByRole("alert")).toHaveTextContent("version conflict");
    expect(screen.getByRole("textbox", { name: "名称" })).toHaveValue("My unsaved direction");
    const count = vi.mocked(searchTreeRequest).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(searchTreeRequest).toHaveBeenCalledTimes(count);
  });
  it("preserves full candidate evidence during user edits and uses the selected node revision", async () => {
    vi.mocked(searchTreeRequest).mockResolvedValueOnce({ ...overview, nodes: [...config.directions, candidate] })
      .mockResolvedValueOnce({ revision: nextRevision, node: candidate })
      .mockImplementationOnce(async (_id, input) => ({ revision: "c".repeat(40), tree: { root, nodes: [...config.directions, input.node] } }));
    render(<SearchTreePanel projectId="p" />); openTree();
    fireEvent.click(await screen.findByRole("button", { name: "候选：Cache" }));
    expect(await screen.findByText("reports/run-1.json")).toBeTruthy();
    expect(screen.getByText("已成功")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "名称" }), { target: { value: "Updated cache" } });
    fireEvent.click(screen.getByRole("button", { name: "保存节点" }));
    await screen.findByRole("button", { name: "候选：Updated cache" });
    expect(searchTreeRequest).toHaveBeenLastCalledWith("p", expect.objectContaining({ operation: "put", expectedRevision: nextRevision, node: { ...candidate, name: "Updated cache" } }));
  });
  it("stops synchronizing when collapsed and reloads on reopening", async () => {
    vi.useFakeTimers(); vi.mocked(searchTreeRequest).mockResolvedValue(overview);
    render(<SearchTreePanel projectId="p" />);
    await act(async () => { openTree(); });
    fireEvent.click(screen.getByRole("button", { name: "收起搜索树" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(searchTreeRequest).toHaveBeenCalledTimes(1);
    await act(async () => { openTree(); });
    expect(searchTreeRequest).toHaveBeenCalledTimes(2);
  });
  it("does not show a late response from a different project", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(searchTreeRequest).mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValueOnce({ ...overview, root: { ...root, name: "Other project" } });
    const view = render(<SearchTreePanel projectId="p" />); openTree();
    view.rerender(<SearchTreePanel projectId="other" />); openTree();
    await screen.findByRole("button", { name: "根：Other project" });
    await act(async () => resolve(overview));
    expect(screen.queryByRole("button", { name: "根：Initial" })).toBeNull();
  });
  it("renders attributed history and pages older updates", async () => {
    const entry = { revision, requestId: "initialize", actor: { kind: "user" }, at: "2026-11-17T06:00:00Z" };
    vi.mocked(searchTreeRequest).mockResolvedValueOnce(overview).mockResolvedValueOnce({ entries: [entry], nextBefore: nextRevision })
      .mockResolvedValueOnce({ entries: [{ ...entry, revision: nextRevision, requestId: "agent-write", actor: { kind: "agent", agentId: "worker" } }] });
    render(<SearchTreePanel projectId="p" />); openTree();
    fireEvent.click(await screen.findByRole("button", { name: "查看变更历史" }));
    expect(await screen.findByText("创建初始搜索树")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "加载更早记录" }));
    expect(await screen.findByText("Agent · worker")).toBeTruthy();
    expect(searchTreeRequest).toHaveBeenLastCalledWith("p", { operation: "history", before: nextRevision });
  });
});
