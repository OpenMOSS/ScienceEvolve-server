import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./Common";
import { normalizeProjectRuntimeProjection } from "../lib";

describe("project wait display", () => {
  it("distinguishes a confirmed resumable Stop from an ordinary Pause", () => {
    const { rerender } = render(<StatusBadge status="paused" phase="collaboration:user-cancelled" />);
    expect(screen.getByText("已停止")).toBeInTheDocument();
    expect(screen.queryByText("已暂停")).not.toBeInTheDocument();
    rerender(<StatusBadge status="paused" phase="collaboration:user-paused" />);
    expect(screen.getByText("已暂停")).toBeInTheDocument();
    expect(screen.queryByText("已停止")).not.toBeInTheDocument();
  });

  it("uses the current runtime Stop phase but ignores a stale Stop on a running project", () => {
    const runtime = normalizeProjectRuntimeProjection({ status: "paused", phase: "collaboration:user-cancelled", activities: [] });
    const { rerender } = render(<StatusBadge status="paused" runtime={runtime} />);
    expect(screen.getByText("已停止")).toBeInTheDocument();
    rerender(<StatusBadge status="running" runtime={runtime} />);
    expect(screen.getByText("研究中")).toBeInTheDocument();
    expect(screen.queryByText("已停止")).not.toBeInTheDocument();
    rerender(<StatusBadge status="paused" phase="collaboration:user-paused" runtime={runtime} />);
    expect(screen.getByText("已暂停")).toBeInTheDocument();
  });

  it("distinguishes a retry without a scheduled backoff receipt", () => {
    const runtime = normalizeProjectRuntimeProjection({ status: "retrying", phase: "collaboration:harness-recovery", activities: [] });
    render(<StatusBadge status="retrying" runtime={runtime} />);
    expect(screen.getByText("等待重试")).toBeInTheDocument();
    expect(screen.queryByText("已暂停")).not.toBeInTheDocument();
  });
  it.each([
    ["configuration", "interrupted", "等待配置修复"],
    ["authorization", "interrupted", "等待授权修复"],
    ["user-input", "retrying", "等待用户输入"],
    ["backoff", "retrying", "退避重试中"]
  ])("shows real %s waiting conditions without claiming automatic recovery", (kind, status, label) => {
    const runtime = normalizeProjectRuntimeProjection({ status, phase: "collaboration:repair-required", waiting: { kind, reason: "Exact safe condition" } });
    render(<StatusBadge status={status as "interrupted" | "retrying"} runtime={runtime} />);
    expect(screen.getByText(label)).toHaveAttribute("title", "Exact safe condition");
    expect(screen.queryByText("自动恢复中")).not.toBeInTheDocument();
  });

  it("retains the server wait identity through normalization and shows its reason", () => {
    const runtime = normalizeProjectRuntimeProjection({ status: "queued", waiting: { kind: "recovery", reason: "Original Git result is unconfirmed",
      agentId: "worker", executionId: "exec-a", operationId: "push-a" }, activities: [] });
    expect(runtime?.waiting).toMatchObject({ operationId: "push-a", executionId: "exec-a", agentId: "worker" });
    render(<StatusBadge status="queued" runtime={runtime} />);
    expect(screen.getByText("等待恢复")).toHaveAttribute("title", "Original Git result is unconfirmed");
    expect(screen.queryByText("排队中")).not.toBeInTheDocument();
  });

  it("does not let an old wait mask a newly running project", () => {
    const runtime = normalizeProjectRuntimeProjection({ status: "queued", waiting: { kind: "management", reason: "Old wait" } });
    render(<StatusBadge status="running" runtime={runtime} />);
    expect(screen.getByText("研究中")).toBeInTheDocument();
    expect(screen.queryByText("等待协调")).not.toBeInTheDocument();
  });

  it("keeps the resource queue label when wait metadata is absent or invalid", () => {
    const runtime = normalizeProjectRuntimeProjection({ status: "queued", waiting: { kind: "unknown", reason: "Invalid wait" } });
    expect(runtime?.waiting).toBeUndefined();
    render(<StatusBadge status="queued" runtime={runtime} />);
    expect(screen.getByText("排队中")).toBeInTheDocument();
  });

  it("keeps completed projects terminal even if an older wait field was retained by a client", () => {
    const runtime = normalizeProjectRuntimeProjection({ status: "completed", waiting: { kind: "recovery", reason: "Old wait" } });
    render(<StatusBadge status="completed" runtime={runtime} />);
    expect(screen.queryByText("等待恢复")).not.toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
  });
});
