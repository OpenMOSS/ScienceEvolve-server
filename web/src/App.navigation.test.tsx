import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("./pages/ProjectListPage", () => ({
  ProjectListPage: ({ onCreate, onOpen, onEditSavedTask, quickDraft }: {
    onCreate: () => void;
    onOpen: (id: string) => void;
    onEditSavedTask: (id: string) => void;
    quickDraft: {
      requirement: string;
      onRequirementChange: (value: string) => void;
    };
  }) => <main>
    <h1>项目首页</h1>
    <textarea
      aria-label="研究任务需求"
      value={quickDraft.requirement}
      onChange={(event) => quickDraft.onRequirementChange(event.target.value)}
    />
    <button onClick={onCreate}>发起新课题</button>
    <button onClick={() => onOpen("project/one")}>打开任务详情</button>
    <button onClick={() => onEditSavedTask("task/one")}>编辑已保存任务</button>
  </main>
}));

vi.mock("./pages/NewProjectPage", () => ({
  NewProjectPage: ({ savedTaskId, onBack }: { savedTaskId?: string; onBack: () => void }) => <main>
    <h1>{savedTaskId ? "编辑已保存的科研任务" : "定义你的下一个科研课题"}</h1>
    <input aria-label="项目名称" defaultValue={savedTaskId ? "已保存标题" : ""} />
    <textarea aria-label="课题方向与具体要求" />
    <button onClick={onBack}>返回项目</button>
  </main>
}));

vi.mock("./pages/GatewayManagementPage", () => ({
  GatewayManagementPage: ({ onBack }: { onBack: () => void }) => <main>
    <h1>全局网关库</h1>
    <button onClick={onBack}>返回项目</button>
  </main>
}));

vi.mock("./pages/GitHubAccountManagementPage", () => ({
  GitHubAccountManagementPage: ({ onBack }: { onBack: () => void }) => <main>
    <h1>GitHub 账号库</h1>
    <button onClick={onBack}>返回项目</button>
  </main>
}));

vi.mock("./pages/WorkspacePage", () => ({
  WorkspacePage: ({ onBack }: { onBack: () => void }) => <main>
    项目工作区
    <button onClick={onBack}>返回项目列表</button>
  </main>
}));

describe("gateway navigation", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "#/projects");
  });

  it("returns to the new project editor with all unsaved fields intact", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "发起新课题" }));
    const title = await screen.findByRole("textbox", { name: "项目名称" });
    await user.type(title, "未保存的课题");
    await user.type(screen.getByRole("textbox", { name: "课题方向与具体要求" }), "研究内容草稿");

    await user.click(screen.getByRole("button", { name: "全局网关库" }));
    expect(await screen.findByRole("heading", { name: "全局网关库" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回项目" }));

    await waitFor(() => expect(window.location.hash).toBe("#/new"));
    expect(screen.getByRole("textbox", { name: "项目名称" })).toHaveValue("未保存的课题");
    expect(screen.getByRole("textbox", { name: "课题方向与具体要求" })).toHaveValue("研究内容草稿");
  });

  it("returns to the same saved task editor with its edits intact", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "编辑已保存任务" }));
    const title = await screen.findByRole("textbox", { name: "项目名称" });
    await user.clear(title);
    await user.type(title, "尚未保存的修改");

    await user.click(screen.getByRole("button", { name: "全局网关库" }));
    await user.click(await screen.findByRole("button", { name: "返回项目" }));

    await waitFor(() => expect(window.location.hash).toBe("#/saved-tasks/task%2Fone/edit"));
    expect(screen.getByRole("textbox", { name: "项目名称" })).toHaveValue("尚未保存的修改");
  });

  it("returns from the GitHub account library without discarding the project draft", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "发起新课题" }));
    const title = await screen.findByRole("textbox", { name: "项目名称" });
    await user.type(title, "等待选择 GitHub 账号的课题");

    await user.click(screen.getByRole("button", { name: "GitHub 账号" }));
    expect(await screen.findByRole("heading", { name: "GitHub 账号库" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回项目" }));

    await waitFor(() => expect(window.location.hash).toBe("#/new"));
    expect(screen.getByRole("textbox", { name: "项目名称" }))
      .toHaveValue("等待选择 GitHub 账号的课题");
  });

  it("returns to the project list when entered from there", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "全局网关库" }));
    await user.click(await screen.findByRole("button", { name: "返回项目" }));

    expect(await screen.findByRole("heading", { name: "项目首页" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/projects");
  });

  it("keeps the quick task text across gateway, project detail, and new project pages", async () => {
    const user = userEvent.setup();
    render(<App />);

    const draft = "正在构思的快速研究任务说明";
    await user.type(screen.getByRole("textbox", { name: "研究任务需求" }), draft);

    await user.click(screen.getByRole("button", { name: "全局网关库" }));
    await user.click(await screen.findByRole("button", { name: "返回项目" }));
    expect(await screen.findByRole("textbox", { name: "研究任务需求" })).toHaveValue(draft);

    await user.click(screen.getByRole("button", { name: "打开任务详情" }));
    await user.click(await screen.findByRole("button", { name: "返回项目列表" }));
    expect(await screen.findByRole("textbox", { name: "研究任务需求" })).toHaveValue(draft);

    await user.click(screen.getByRole("button", { name: "发起新课题" }));
    await user.click(await screen.findByRole("button", { name: "返回项目" }));
    expect(await screen.findByRole("textbox", { name: "研究任务需求" })).toHaveValue(draft);
  });
});
