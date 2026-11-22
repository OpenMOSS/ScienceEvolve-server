import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SearchTreeDialog } from "./SearchTreeDialog";
import { searchTreeRequest } from "../api";

vi.mock("../api", () => ({ searchTreeRequest: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

it("opens the persisted project tree immediately, reflects Agent updates and stops polling on close", async () => {
  vi.useFakeTimers();
  const root = { id: "root", kind: "root", name: "Original plan", inputs: [] };
  const direction = { id: "speed", kind: "direction", parentId: "root", name: "Speed" };
  const candidate = { id: "cache", kind: "candidate", parentId: "speed", name: "Agent cache", goal: "Reduce latency", source: "Agent",
    version: { status: "uncommitted" }, execution: { status: "succeeded" }, evidence: ["results/cache.json"] };
  vi.mocked(searchTreeRequest).mockResolvedValueOnce({ revision: "a".repeat(40), root, nodes: [direction] })
    .mockResolvedValueOnce({ revision: "b".repeat(40), root, nodes: [direction, candidate] })
    .mockResolvedValueOnce({ revision: "b".repeat(40), node: candidate });
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<SearchTreeDialog projectId="project-live" onClose={vi.fn()} />); });
  expect(screen.getByRole("dialog", { name: "项目搜索树" })).toBeInTheDocument();
  expect(searchTreeRequest).toHaveBeenCalledExactlyOnceWith("project-live", { operation: "overview" });
  expect(screen.getByRole("button", { name: "方向：Speed" })).toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "启用搜索树" })).toBeNull();
  expect(screen.queryByText(/修改已同步到课题草稿/)).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "候选：Agent cache" })); });
  expect(screen.getByText("results/cache.json")).toBeInTheDocument();
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(searchTreeRequest).toHaveBeenCalledTimes(3);
});

it("shows a project tree read failure rather than falling back to a draft", async () => {
  vi.mocked(searchTreeRequest).mockRejectedValue(new Error("Tree storage unavailable"));
  render(<SearchTreeDialog projectId="project-error" onClose={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Tree storage unavailable");
  expect(screen.queryByRole("textbox", { name: "根节点名称" })).toBeNull();
});

it("isolates search-tree keyboard actions from the underlying Workflow and restores focus on close", () => {
  const opener = document.createElement("button"); document.body.append(opener); opener.focus();
  const keydown = vi.fn(), close = vi.fn(), change = vi.fn();
  window.addEventListener("keydown", keydown);
  const beforeOverflow = document.body.style.overflow;
  try {
    const view = render(<SearchTreeDialog files={[]} onChange={change} onClose={close} />);
    const dialog = screen.getByRole("dialog", { name: "编辑搜索树" });
    expect(dialog).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(dialog, { key: "z", ctrlKey: true });
    fireEvent.keyDown(dialog, { key: "Delete" });
    expect(keydown).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe(beforeOverflow);
  } finally { window.removeEventListener("keydown", keydown); opener.remove(); }
});
