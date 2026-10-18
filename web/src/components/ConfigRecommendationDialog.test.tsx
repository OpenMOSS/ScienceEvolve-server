import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfigRecommendationDialog, type RecommendationOperation } from "./ConfigRecommendationDialog";

describe("configuration recommendation progress", () => {
  it("identifies the selected route and distinguishes missing updates from completion", () => {
    vi.useFakeTimers();
    const operation: RecommendationOperation = { status: "running", phase: "generation", stage: 1,
      message: "模型正在生成", startedAt: Date.now(), lastProgressAt: Date.now(),
      advisor: { gateway: "Selected gateway", model: "Selected model" } };
    const props = { onClose: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(), canRetry: false };
    const view = render(<ConfigRecommendationDialog {...props} operation={operation} />);
    try {
      expect(screen.getByText("推荐模型：Selected gateway · Selected model")).toBeVisible();
      expect(screen.getByText("第 2 / 4 阶段")).toBeVisible();
      expect(screen.queryByText("25%")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(31_000));
      expect(screen.getByText(/暂未收到新的模型进度/)).toBeVisible();
      view.rerender(<ConfigRecommendationDialog {...props} operation={{ ...operation, lastProgressAt: Date.now(), message: "已接收新的输出" }} />);
      expect(screen.queryByText(/暂未收到新的模型进度/)).not.toBeInTheDocument();
      view.rerender(<ConfigRecommendationDialog {...props} operation={{ ...operation, status: "completed", stage: 4, finishedAt: Date.now() }} />);
      expect(screen.getByText("100%")).toBeVisible();
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    } finally { view.unmount(); vi.useRealTimers(); }
  });
});
