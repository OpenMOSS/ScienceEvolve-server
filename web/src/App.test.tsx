import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./App";

function BrokenView(): never {
  throw new Error("lazy chunk unavailable");
}

describe("AppErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("turns an uncaught render failure into a visible recovery screen", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <AppErrorBoundary>
        <BrokenView />
      </AppErrorBoundary>
    );

    expect(screen.getByRole("alert")).toHaveTextContent("界面加载失败");
    expect(screen.getByRole("alert")).toHaveTextContent("lazy chunk unavailable");
    expect(screen.getByRole("button", { name: "重新加载" })).toBeInTheDocument();
  });
});
