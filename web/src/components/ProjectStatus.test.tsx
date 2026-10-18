import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./Common";
import { normalizeProjectRuntimeProjection } from "../lib";

describe("project wait display", () => {
  it("shows deferred Harness recovery as automatic progress", () => {
    const runtime = normalizeProjectRuntimeProjection({ status: "retrying", phase: "collaboration:harness-recovery", activities: [] });
    render(<StatusBadge status="retrying" runtime={runtime} />);
    expect(screen.getByText("自动恢复中")).toBeInTheDocument();
    expect(screen.queryByText("已暂停")).not.toBeInTheDocument();
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
