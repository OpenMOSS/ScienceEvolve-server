import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReviewCard } from "./WorkspacePage";

describe("ReviewCard", () => {
  it("shows a natural-language worker result", () => {
    render(
      <ReviewCard
        handoff={{
          agent: "review",
          invocationId: "inv-1",
          excerpt: "实验仍需补强。",
          markdown: "缺少关键对照实验。",
          updatedAt: "2026-08-23T00:00:00.000Z"
        }}
      />
    );

    expect(screen.getByText("实验仍需补强。")).toBeInTheDocument();
    expect(screen.getByText("项目进展")).toBeInTheDocument();
    expect(screen.getByText("查看完整交接").closest("details")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("查看完整交接"));
    expect(screen.getByText("缺少关键对照实验。")).toBeInTheDocument();
  });

  it("shows an empty state before any worker result", () => {
    render(<ReviewCard />);
    expect(screen.getByText("等待结果")).toBeInTheDocument();
    expect(screen.getByText(/这里会显示项目正在做什么/)).toBeInTheDocument();
  });

  it("shows the active agent and attention message without dumping raw handoff text", () => {
    render(
      <ReviewCard
        project={{
          status: "running",
          currentAgent: "analyst",
          userIntervention: {
            id: "request-1",
            status: "pending",
            requestedAt: "2026-08-26T00:00:00.000Z",
            message: "请先确认数据源权限。",
            rationale: "需要外部授权。",
            successCriteria: [],
            requestedBy: "analyst",
            requestKind: "worker"
          }
        } as never}
      />
    );

    expect(screen.getByText("等待用户")).toBeInTheDocument();
    expect(screen.getByText("analyst")).toBeInTheDocument();
    expect(screen.getByText("请先确认数据源权限。")).toBeInTheDocument();
    expect(screen.queryByText("查看完整交接")).not.toBeInTheDocument();
  });

  it("does not mark an errored result as passed", () => {
    render(
      <ReviewCard
        project={{ status: "failed", error: "模型服务不可用" } as never}
        handoff={{
          agent: "analyst",
          invocationId: "inv-2",
          excerpt: "已保存部分分析。",
          markdown: "# Result\n\n部分结果。",
          updatedAt: "2026-08-26T00:00:00.000Z"
        }}
      />
    );

    expect(screen.getByText("需要处理")).toBeInTheDocument();
    expect(screen.getByText("需要处理")).not.toHaveClass("passed");
    expect(screen.getByText("模型服务不可用")).toBeInTheDocument();
  });
});
