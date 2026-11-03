import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectAuthorizationNotice } from "./ProjectAuthorizationNotice";
import { StatusBadge } from "./Common";
import { normalizeProject, withProjectAuthorizationWaiting } from "../lib";
import { githubAuthorizationProject } from "../test/github-authorization-project";

describe("project GitHub authorization notice", () => {
  const blocked = githubAuthorizationProject(normalizeProject({ id: "project" }));
  it("identifies the bound account, retained progress and a direct management link", () => {
    render(<ProjectAuthorizationNotice project={blocked} />);
    expect(screen.getByRole("alert", { name: "GitHub 授权异常" })).toHaveTextContent("test-owner");
    expect(screen.getByText(/项目进度已保留/)).toHaveTextContent("重新登录项目绑定的 GitHub 账号");
    expect(screen.getByRole("link", { name: "前往 GitHub 账号" })).toHaveAttribute("href", "#/github-accounts");
  });
  it("replaces the generic wait even with an older server response", () => {
    const display = withProjectAuthorizationWaiting(blocked);
    render(<StatusBadge status={display.status} runtime={display.runtime} />);
    expect(screen.getByText("等待授权修复")).toBeVisible();
    expect(blocked.runtime?.waiting?.kind).toBe("recovery");
  });
  it.each(["completed", "running", "paused", "cancelled"] as const)("does not turn %s and historical errors into a current authorization warning", status => {
    render(<ProjectAuthorizationNotice project={{ ...blocked, status }} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("clears the warning when recovery reaches a user question, another error or a live turn", () => {
    const view = render(<ProjectAuthorizationNotice project={blocked} />);
    view.rerender(<ProjectAuthorizationNotice project={{ ...blocked, phase: "user-intervention-required", error: undefined }} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    view.rerender(<ProjectAuthorizationNotice project={{ ...blocked, error: "A new unrelated error" }} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    view.rerender(<ProjectAuthorizationNotice project={{ ...blocked, runtime: { ...blocked.runtime!, activities: [{} as never] } }} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("explains a 403 permission failure without calling it token expiration", () => {
    render(<ProjectAuthorizationNotice project={{ ...blocked, failureAttempts: [{ ...blocked.failureAttempts![0]!, metadata: { status: 403 } }] }} />);
    expect(screen.getByText(/权限不足/)).toBeVisible();
    expect(screen.queryByText(/已失效/)).not.toBeInTheDocument();
  });
});
