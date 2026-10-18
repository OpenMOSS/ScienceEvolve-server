import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasToolbar } from "./CanvasToolbar";

function renderToolbar(overrides: Partial<React.ComponentProps<typeof CanvasToolbar>> = {}) {
  const callbacks = {
    onTidy: vi.fn(),
    onLayered: vi.fn(),
    onFit: vi.fn()
  };
  render(<CanvasToolbar edgeKind="strong" zoom={1} {...callbacks} {...overrides} />);
  return callbacks;
}

describe("CanvasToolbar layout controls", () => {
  it("runs each directly visible layout command", () => {
    const callbacks = renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "智能整理布局" }));
    fireEvent.click(screen.getByRole("button", { name: "依次执行分层重排、智能整理和适应画布" }));
    fireEvent.click(screen.getByRole("button", { name: "适应画布" }));
    expect(callbacks.onTidy).toHaveBeenCalledOnce();
    expect(callbacks.onLayered).toHaveBeenCalledOnce();
    expect(callbacks.onFit).toHaveBeenCalledOnce();
  });

  it("opens the collapsed menu, runs an action, and closes it", () => {
    const callbacks = renderToolbar();
    const trigger = screen.getByRole("button", { name: "更多布局操作" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "分层重排" }));
    expect(callbacks.onLayered).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes the menu on Escape and outside pointer input", () => {
    renderToolbar();
    const trigger = screen.getByRole("button", { name: "更多布局操作" });
    fireEvent.click(trigger);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("disables every layout entry point while editing is unavailable", () => {
    renderToolbar({ readOnly: true });
    expect(screen.getByRole("button", { name: "智能整理布局" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "依次执行分层重排、智能整理和适应画布" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "适应画布" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "更多布局操作" })).toBeDisabled();
  });

  it("shows only supported scoped commands and permits read-only fit without editing", () => {
    const fit = vi.fn();
    render(<CanvasToolbar edgeKind="weak" zoom={.8} readOnly allowFitWhenReadOnly
      addAgentLabel="引用 Agent" onAddAgent={vi.fn()} onFit={fit} />);
    expect(screen.getByRole("button", { name: "引用 Agent" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "清空画布" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "智能整理布局" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分层重排" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "适应画布" }));
    expect(fit).toHaveBeenCalledOnce();
  });

  it("keeps undo and redo accessible with hidden labels and disabled without history or edit authority", () => {
    const undo = vi.fn();
    const redo = vi.fn();
    const view = render(<CanvasToolbar edgeKind="strong" zoom={1} onUndo={undo} onRedo={redo} />);
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重做" })).toBeDisabled();
    view.rerender(<CanvasToolbar edgeKind="strong" zoom={1} onUndo={undo} onRedo={redo} canUndo canRedo />);
    screen.getByRole("button", { name: "撤销" }).querySelector("span")!.style.display = "none";
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(undo).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    expect(redo).toHaveBeenCalledOnce();
    view.rerender(<CanvasToolbar edgeKind="strong" zoom={1} onUndo={undo} onRedo={redo} canUndo canRedo readOnly />);
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重做" })).toBeDisabled();
  });
});
