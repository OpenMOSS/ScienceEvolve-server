import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ProjectServiceFailureNotice } from "./ProjectServiceFailureNotice";
import { ProjectAuthorizationNotice } from "./ProjectAuthorizationNotice";
import { StatusBadge } from "./Common";
import { normalizeProject } from "../lib";
const project = normalizeProject({ id: "project", status: "interrupted", phase: "collaboration:writer-lease-lost",
  git: { enabled: true, status: "waiting_for_github" }, runtime: { stateRevision: 1, status: "interrupted", phase: "collaboration:writer-lease-lost",
    executionCount: 1, activities: [], waiting: { kind: "service", reason: "服务停止写入，项目记录和原会话已保留。",
      failedAt: "2026-11-03T12:26:32.762Z", errorCode: "WRITER_LEASE_STALE" } } });
it("shows the service cause and timestamp instead of automatic retry or historical authorization", () => {
  render(<><StatusBadge status={project.status} runtime={project.runtime} /><ProjectServiceFailureNotice project={project} />
    <ProjectAuthorizationNotice project={project} /></>);
  expect(screen.getByText("服务不可用")).toBeVisible();
  expect(screen.getByRole("alert", { name: "服务写入租约失效" })).toHaveTextContent("原会话已保留");
  expect(screen.getByText(/WRITER_LEASE_STALE/)).toBeVisible();
  expect(screen.queryByRole("alert", { name: "GitHub 授权异常" })).not.toBeInTheDocument();
  expect(screen.queryByText("等待重试")).not.toBeInTheDocument();
});
it("clears the service warning when the original task resumes", () => {
  const view = render(<ProjectServiceFailureNotice project={project} compact />);
  view.rerender(<ProjectServiceFailureNotice project={{ ...project, status: "running", phase: "model:running" }} compact />);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it.each(["draft", "completed", "cancelled"] as const)("keeps %s history settled", status => {
  render(<ProjectServiceFailureNotice project={{ ...project, status }} />); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
