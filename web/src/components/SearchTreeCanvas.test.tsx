import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchTreeCanvas } from "./SearchTreeCanvas";

const root = { id: "root", kind: "root" as const, name: "Research" };
const direction = { id: "speed", kind: "direction" as const, parentId: "root", name: "Speed" };
afterEach(() => vi.restoreAllMocks());
function fixture() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 500, width: 900, height: 500, toJSON() {} });
  const select = vi.fn();
  const view = render(<SearchTreeCanvas root={root} nodes={[direction]} selectedId="root" onSelect={select} />);
  const frame = screen.getByLabelText("搜索树交互画布"), world = frame.querySelector<HTMLElement>(".workflow-canvas-world")!;
  return { ...view, select, frame, world };
}

describe("search tree Workflow canvas interactions", () => {
  it("reuses the Workflow viewport, pans by pointer and zooms around the cursor without changing nodes", () => {
    const { frame, world, select } = fixture();
    const initial = world.style.transform;
    expect(frame).toHaveClass("workflow-canvas-presentation");
    expect(screen.getByText("SEARCH TREE")).toBeInTheDocument();
    fireEvent.pointerDown(frame, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 180, clientY: 160 });
    fireEvent.pointerUp(frame, { pointerId: 1, clientX: 180, clientY: 160 });
    expect(world.style.transform).not.toBe(initial);
    expect(frame).not.toHaveClass("is-panning");
    const panned = world.style.transform;
    fireEvent.wheel(frame, { deltaY: -100, clientX: 300, clientY: 200 });
    expect(world.style.transform).not.toBe(panned);
    expect(Number.parseInt(screen.getByRole("button", { name: "重置搜索树缩放" }).textContent!)).toBeGreaterThan(100);
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重置搜索树缩放" }));
    expect(screen.getByRole("button", { name: "重置搜索树缩放" })).toHaveTextContent("100%");
  });
  it("moves nodes and their connections locally, accepts final pointer coordinates and tidies the layout", () => {
    const { frame, select } = fixture();
    const button = screen.getByRole("button", { name: "方向：Speed" });
    const card = button.closest<HTMLElement>(".search-tree-node")!;
    const path = frame.querySelector(".search-tree-links path")!;
    const beforePath = path.getAttribute("d"), beforeX = card.style.left, beforeY = card.style.top;
    fireEvent.pointerDown(button, { pointerId: 2, button: 0, clientX: 400, clientY: 100 });
    fireEvent.pointerUp(frame, { pointerId: 2, clientX: 460, clientY: 180 });
    expect(card.style.left).not.toBe(beforeX); expect(card.style.top).not.toBe(beforeY);
    expect(path.getAttribute("d")).not.toBe(beforePath);
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "整理搜索树布局" }));
    expect(card.style.left).toBe(beforeX); expect(card.style.top).toBe(beforeY);
    expect(path.getAttribute("d")).toBe(beforePath);
    expect(direction.parentId).toBe("root");
  });
  it("cancels interrupted drags and separates clicks from dragging", () => {
    const { frame, select } = fixture();
    const button = screen.getByRole("button", { name: "方向：Speed" });
    const card = button.closest<HTMLElement>(".search-tree-node")!;
    const before = card.style.left;
    fireEvent.pointerDown(button, { pointerId: 3, button: 0, clientX: 400, clientY: 100 });
    fireEvent.pointerMove(frame, { pointerId: 3, clientX: 460, clientY: 100 });
    fireEvent.pointerCancel(frame, { pointerId: 3, clientX: 460, clientY: 100 });
    expect(card.style.left).toBe(before);
    expect(select).not.toHaveBeenCalled();
    fireEvent.pointerDown(button, { pointerId: 4, button: 0, clientX: 400, clientY: 100 });
    fireEvent.pointerUp(frame, { pointerId: 4, clientX: 400, clientY: 100 });
    expect(select).toHaveBeenCalledExactlyOnceWith("speed");
    select.mockClear();
    fireEvent.click(button, { detail: 0 });
    expect(select).toHaveBeenCalledExactlyOnceWith("speed");
  });
});
