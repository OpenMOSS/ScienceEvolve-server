import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENTS, normalizeAgentOrchestration } from "../../lib";
import type { FixedMcpDefinition, GatewayRecord, GitHubAccountRecord, HarnessCatalogEntry } from "../../types";
import type { CanvasEdge, CanvasNode } from "./core/canvas-model";
import { CanvasInspector } from "./CanvasInspector";

const workerNode: CanvasNode = {
  id: "idea",
  kind: "agent",
  name: "idea",
  template: "idea",
  x: 0,
  y: 0
};

function weakEdge(id: string, target: string, fixed = false): CanvasEdge {
  return {
    id,
    source: "idea",
    target,
    kind: target === "finish" ? "termination" : "weak",
    fixed,
    sourcePort: "right",
    targetPort: "left",
    sourcePortPinned: true,
    targetPortPinned: true
  };
}

describe("CanvasInspector", () => {
  it("edits only the explicit experiment choice and honors locked canvas nodes", () => {
    const onAgentPatch = vi.fn();
    const agent = { ...DEFAULT_AGENTS.idea, permission: "workspace" as const, experimentMcp: true };
    const orchestration = normalizeAgentOrchestration(undefined);
    const { rerender } = render(<CanvasInspector node={workerNode} agent={agent} orchestration={orchestration} onAgentPatch={onAgentPatch} />);
    expect(screen.queryByLabelText(/Bash 网络代理/)).toBeNull();
    const checkbox = screen.getByRole("checkbox", { name: "idea SII 实验工具" });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(onAgentPatch).toHaveBeenCalledWith({ experimentMcp: false });
    expect(onAgentPatch.mock.calls[0]?.[0]).not.toHaveProperty("permission");
    rerender(<CanvasInspector node={workerNode} agent={agent} orchestration={orchestration} onAgentPatch={onAgentPatch} readOnly />);
    expect(screen.getByRole("checkbox", { name: "idea SII 实验工具" })).toBeDisabled();
  });
  it("shows a global workflow overview and jumps to the first configuration problem", () => {
    const orchestration = normalizeAgentOrchestration(undefined);
    const onSelectProblemNode = vi.fn();
    render(
      <CanvasInspector
        orchestration={orchestration}
        allEdges={[]}
        layoutMode="main-dispatch"
        onSelectProblemNode={onSelectProblemNode}
      />
    );

    expect(screen.getByRole("complementary", { name: "Workflow 全局摘要" })).toBeVisible();
    expect(screen.getByText("流程概览")).toBeVisible();
    expect(screen.getByText("Main 调度中心")).toBeVisible();
    expect(screen.getByText("用户输入尚未连接")).toBeVisible();
    expect(screen.getByText("结束节点尚未连接")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "选择有问题节点" }));
    expect(onSelectProblemNode).toHaveBeenCalledWith("input");
  });

  it("edits every project-level mode and opens the GitHub repository settings", () => {
    const orchestration = normalizeAgentOrchestration(undefined);
    const onOrchestrationChange = vi.fn();
    const onGitEnabledChange = vi.fn();
    const onGitRepositoryConfigure = vi.fn();
    const accounts: GitHubAccountRecord[] = [
      {
        id: "gha_11111111111111111111111111111111",
        login: "alice",
        providerUserId: 7,
        status: "ready",
        scopes: ["repo"],
        isDefault: true,
        createdAt: "2026-09-24T00:00:00.000Z",
        updatedAt: "2026-09-24T00:00:00.000Z"
      },
      {
        id: "gha_22222222222222222222222222222222",
        login: "bob",
        providerUserId: 9,
        status: "ready",
        scopes: ["repo"],
        isDefault: false,
        createdAt: "2026-09-24T00:00:00.000Z",
        updatedAt: "2026-09-24T00:00:00.000Z"
      }
    ];
    render(
      <CanvasInspector
        orchestration={orchestration}
        onOrchestrationChange={onOrchestrationChange}
        gitEnabled
        onGitEnabledChange={onGitEnabledChange}
        githubAccounts={accounts}
        githubAccountId={accounts[0].id}
        gitRepositoryName="paper-evidence"
        gitRepositoryVisibility="public"
        onGitRepositoryConfigure={onGitRepositoryConfigure}
      />
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "论文" }));
    expect(onOrchestrationChange).toHaveBeenLastCalledWith(expect.objectContaining({
      resultFormat: { presets: ["论文"], custom: "" }
    }));
    fireEvent.change(screen.getByRole("textbox", { name: "画布结果形式补充说明" }), {
      target: { value: "同时生成可复现数据表" }
    });
    expect(onOrchestrationChange).toHaveBeenLastCalledWith(expect.objectContaining({
      resultFormat: { presets: [], custom: "同时生成可复现数据表" }
    }));
    fireEvent.click(screen.getByRole("switch", { name: "画布允许用户介入" }));
    expect(onOrchestrationChange).toHaveBeenLastCalledWith(expect.objectContaining({
      allowUserIntervention: false
    }));
    fireEvent.click(screen.getByRole("switch", { name: "画布允许 Main 自动调整 Workflow" }));
    expect(onOrchestrationChange).toHaveBeenLastCalledWith(expect.objectContaining({
      allowMainReconfiguration: true
    }));
    fireEvent.click(screen.getByRole("switch", { name: "画布启用 Git 机制" }));
    expect(onGitEnabledChange).toHaveBeenCalledWith(false);
    expect(screen.getByText("alice")).toBeVisible();
    expect(screen.getByText("paper-evidence")).toBeVisible();
    expect(screen.getByText("Public")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "配置" }));
    expect(onGitRepositoryConfigure).toHaveBeenCalledOnce();
  });

  it("requires Git while groups exist and keeps it enabled after the last group is removed", () => {
    const orchestration = normalizeAgentOrchestration(undefined);
    const grouped = structuredClone(orchestration);
    grouped.collaborations = [{ id: "research", displayName: "Research", memberAgentIds: ["idea", "execution"], renamePolicy: "editable" }];
    const onGitEnabledChange = vi.fn();
    const { rerender } = render(<CanvasInspector orchestration={grouped} gitEnabled onGitEnabledChange={onGitEnabledChange} />);
    const gitSwitch = screen.getByRole("switch", { name: "画布启用 Git 机制" });
    expect(gitSwitch).toBeChecked();
    expect(gitSwitch).toBeDisabled();
    expect(screen.getByText("当前 Workflow 包含协作组，请先移除所有协作组再关闭 Git 机制。")).toBeVisible();
    fireEvent.click(gitSwitch);
    expect(onGitEnabledChange).not.toHaveBeenCalled();
    rerender(<CanvasInspector orchestration={orchestration} gitEnabled onGitEnabledChange={onGitEnabledChange} />);
    expect(gitSwitch).toBeChecked();
    expect(gitSwitch).toBeEnabled();
    expect(onGitEnabledChange).not.toHaveBeenCalled();
    fireEvent.click(gitSwitch);
    expect(onGitEnabledChange).toHaveBeenCalledWith(false);
  });

  it("edits Loop metadata from any member edge and removes the selected route to break it", () => {
    const orchestration = normalizeAgentOrchestration({
      agents: [
        { name: "main", template: "main" },
        { name: "refine", template: "idea" },
        { name: "evaluate", template: "review" },
        { name: "review", template: "review" }
      ],
      input: { source: "input", target: "refine" },
      routes: {
        main: [{ target: "refine", kind: "weak" }],
        refine: [{ target: "evaluate", kind: "strong" }],
        evaluate: [{ target: "refine", kind: "strong" }],
        review: [{ target: "finish", kind: "weak" }]
      },
      loops: [{
        id: "refinement",
        from: "evaluate",
        to: "refine",
        maxIterations: 3,
        exitTo: "review"
      }],
      decisionPlans: {},
      allowUserIntervention: true,
      termination: { agent: "review", condition: "done", decisionBy: "main", automatic: false }
    });
    const selectedEdge: CanvasEdge = {
      id: "refine->evaluate:0",
      source: "refine",
      target: "evaluate",
      kind: "strong",
      fixed: false,
      sourcePort: "right",
      targetPort: "left",
      sourcePortPinned: true,
      targetPortPinned: true,
      loop: {
        id: "refinement",
        role: "member",
        maxIterations: 3,
        exitTo: "review",
        virtual: false
      }
    };
    const onLoopChange = vi.fn();
    const onEdgeRemove = vi.fn();
    render(
      <CanvasInspector
        selectedEdge={selectedEdge}
        orchestration={orchestration}
        onLoopChange={onLoopChange}
        onEdgeRemove={onEdgeRemove}
      />
    );

    expect(screen.getByRole("heading", { name: "Loop 配置" })).toBeVisible();
    expect(screen.getByText(/虚线不会写入普通 routes/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Loop 每批迭代数"), { target: { value: "5" } });
    expect(onLoopChange).toHaveBeenCalledWith("refinement", { maxIterations: 5 });
    fireEvent.change(screen.getByLabelText("Loop 批次退出目标"), { target: { value: "main" } });
    expect(onLoopChange).toHaveBeenCalledWith("refinement", { exitTo: "main" });
    const id = screen.getByLabelText("Loop ID");
    fireEvent.change(id, { target: { value: "revision-cycle" } });
    fireEvent.blur(id);
    expect(onLoopChange).toHaveBeenCalledWith("refinement", { id: "revision-cycle" });
    expect(screen.getByText(/成员路径：refine → evaluate → refine/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "设为 Loop" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除所选强边并拆开 Loop" }));
    expect(onEdgeRemove).toHaveBeenCalledWith("refine->evaluate:0");
  });

  it("shows the exact failed Harness/Gateway/model reason beside the derived route", () => {
    const gateway: GatewayRecord = {
      id: "gwy_0123456789abcdef0123456789abcdef",
      name: "失败网关",
      url: "https://gateway.example.test/v1",
      models: [DEFAULT_AGENTS.idea.model],
      defaultModel: DEFAULT_AGENTS.idea.model,
      protocol: "responses",
      revision: 1,
      apiKeyConfigured: true,
      test: {
        status: "failed",
        protocol: "responses",
        model: DEFAULT_AGENTS.idea.model,
        error: "上游返回 HTTP 429"
      },
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z"
    };
    const harnesses: HarnessCatalogEntry[] = [{
      id: "codex",
      label: "Codex",
      adapterVersion: "1",
      nativeProtocol: "responses",
      purposes: ["workflow", "explainer", "probe"],
      mode: "workflow",
      notes: "Embedded Codex",
      capabilities: {
        structuredEvents: true, toolResults: true, durableSession: true,
        permissionPrompts: ["workspace", "compute", "yolo"], workspaceInputs: true, autoSkills: true,
        officialEvents: true, toolEvents: true, usageEvents: true,
        readOnlyExplainer: true, webSearch: true, skills: true, mcp: true
      },
      available: true
    }];
    render(
      <CanvasInspector
        node={workerNode}
        agent={{ ...DEFAULT_AGENTS.idea, gatewayId: gateway.id }}
        definition={{ name: "idea", template: "idea" }}
        orchestration={normalizeAgentOrchestration(undefined)}
        gateways={[gateway]}
        harnesses={harnesses}
      />
    );

    expect(screen.getByText(
      "当前 Harness / 网关 / model 组合验证失败：上游返回 HTTP 429；仍可启动，但运行可能失败。"
    )).toHaveAttribute("role", "alert");
    expect(within(screen.getByLabelText("idea model")).getByRole("option", {
      name: `${DEFAULT_AGENTS.idea.model} · 验证失败`
    })).not.toBeDisabled();
    expect(within(screen.getByLabelText("idea全局网关")).getByRole("option", {
      name: "失败网关 · 连接验证失败"
    })).not.toBeDisabled();
    expect(screen.getByText(/以下 model 验证失败，仍可选择并启动：.*上游返回 HTTP 429/)).toBeVisible();
  });

  it("does not infer a direct route for a historical Harness without Catalog protocol metadata", () => {
    const gateway: GatewayRecord = {
      id: "gwy_0123456789abcdef0123456789abcdef",
      name: "历史配置网关",
      url: "https://gateway.example.test/v1",
      models: [DEFAULT_AGENTS.idea.model],
      defaultModel: DEFAULT_AGENTS.idea.model,
      protocol: "responses",
      revision: 1,
      apiKeyConfigured: true,
      test: { status: "untested" },
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z"
    };
    render(
      <CanvasInspector
        node={workerNode}
        agent={{
          ...DEFAULT_AGENTS.idea,
          harness: "retired-harness",
          gatewayId: gateway.id
        }}
        definition={{ name: "idea", template: "idea" }}
        orchestration={normalizeAgentOrchestration(undefined)}
        gateways={[gateway]}
        harnesses={[]}
      />
    );

    expect(screen.getByText("Harness 目录待确认")).toBeVisible();
    expect(screen.queryByText("直连")).not.toBeInTheDocument();
  });

  it("filters non-workflow Harnesses and disables controls from generic capabilities", () => {
    const limitedHarness: HarnessCatalogEntry = {
      id: "fixture-limited",
      label: "Fixture Limited",
      adapterVersion: "1",
      nativeProtocol: "responses",
      purposes: ["workflow", "probe"],
      default: true,
      notes: "limited fixture",
      capabilities: {
        structuredEvents: true,
        toolResults: true,
        durableSession: false,
        permissionPrompts: ["workspace"],
        workspaceInputs: true,
        autoSkills: false,
        officialEvents: true,
        toolEvents: true,
        usageEvents: true,
        readOnlyExplainer: false,
        webSearch: false,
        skills: true,
        mcp: false
      },
      available: true
    };
    const explainerOnly: HarnessCatalogEntry = {
      ...limitedHarness,
      id: "fixture-explainer",
      label: "Fixture Explainer",
      purposes: ["explainer"]
    };
    render(
      <CanvasInspector
        node={workerNode}
        agent={{
          ...DEFAULT_AGENTS.idea,
          harness: limitedHarness.id,
          skills: ["builtin:fixed"]
        }}
        definition={{ name: "idea", template: "idea" }}
        orchestration={normalizeAgentOrchestration(undefined)}
        harnesses={[limitedHarness, explainerOnly]}
        skills={[{ id: "builtin:fixed", name: "Fixed" }]}
        onAgentPatch={vi.fn()}
        onAddMcp={vi.fn()}
        onToggleMcp={vi.fn()}
      />
    );

    const harnessSelect = screen.getByLabelText("idea Harness");
    expect(within(harnessSelect).queryByRole("option", { name: "Fixture Explainer" })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("idea运行权限")).getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: "持续 session" })).toBeDisabled();
    expect(screen.getByText("当前 Harness 不支持持续 session。")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "idea Web Search" })).toBeDisabled();
    fireEvent.click(screen.getByText("添加 MCP", { exact: true }));
    expect(screen.getByRole("button", { name: "添加新 MCP" })).toBeDisabled();
    expect(screen.getByText("当前 Harness 不支持 MCP")).toBeVisible();
    expect(within(screen.getByLabelText("Fixed加载方式")).getByRole("option", { name: "自动选择" })).toBeDisabled();
    expect(screen.getByText("当前 Harness 不支持 Auto Skills，仅可固定加载")).toBeVisible();
  });

  it("toggles child session persistence while keeping Main fixed", () => {
    const orchestration = normalizeAgentOrchestration(undefined);
    const onSessionPersistenceChange = vi.fn();
    const { rerender } = render(
      <CanvasInspector
        node={workerNode}
        agent={DEFAULT_AGENTS.idea}
        definition={{ name: "idea", template: "idea" }}
        orchestration={orchestration}
        onSessionPersistenceChange={onSessionPersistenceChange}
      />
    );

    const session = screen.getByRole("checkbox", { name: "持续 session" });
    expect(session).not.toBeChecked();
    fireEvent.click(session);
    expect(onSessionPersistenceChange).toHaveBeenCalledWith(true);

    rerender(
      <CanvasInspector
        node={{ ...workerNode, id: "main", name: "main", template: "main" }}
        agent={DEFAULT_AGENTS.main}
        definition={{ name: "main", template: "main" }}
        orchestration={orchestration}
      />
    );
    expect(screen.queryByRole("checkbox", { name: "持续 session" })).not.toBeInTheDocument();
    expect(screen.getByText("Main Agent 始终使用持续 session，不能关闭。")).toBeVisible();
  });

  it("edits the role description independently from Agent instructions", () => {
    const orchestration = normalizeAgentOrchestration(undefined);
    const onDescriptionChange = vi.fn();
    const onAgentPatch = vi.fn();
    render(
      <CanvasInspector
        node={workerNode}
        agent={{ ...DEFAULT_AGENTS.idea, instructions: "Keep the execution prompt." }}
        definition={{ name: "idea", template: "idea", description: "原始职责说明" }}
        orchestration={orchestration}
        onDescriptionChange={onDescriptionChange}
        onAgentPatch={onAgentPatch}
      />
    );

    const description = screen.getByRole("textbox", { name: "职责说明" });
    const instructions = screen.getByRole("textbox", { name: "Agent 指令" });
    expect(description).toHaveValue("原始职责说明");
    expect(instructions).toHaveValue("Keep the execution prompt.");
    fireEvent.change(description, { target: { value: "更新后的职责说明" } });
    fireEvent.change(instructions, { target: { value: "更新后的指令" } });
    expect(onDescriptionChange).not.toHaveBeenCalled();
    expect(onAgentPatch).not.toHaveBeenCalled();
    fireEvent.blur(description);
    fireEvent.blur(instructions);
    expect(onDescriptionChange).toHaveBeenCalledWith("更新后的职责说明");
    expect(onAgentPatch).toHaveBeenCalledWith({ instructions: "更新后的指令" });
  });

  it("commits a text draft once before selecting elsewhere", () => {
    const onDescriptionChange = vi.fn();
    render(<CanvasInspector node={workerNode} agent={DEFAULT_AGENTS.idea}
      definition={{ name: "idea", template: "idea" }} orchestration={normalizeAgentOrchestration(undefined)}
      onDescriptionChange={onDescriptionChange} />);
    const description = screen.getByRole("textbox", { name: "职责说明" });
    fireEvent.change(description, { target: { value: "新职责" } });
    fireEvent.pointerDown(document.body);
    fireEvent.blur(description);
    expect(onDescriptionChange).toHaveBeenCalledTimes(1);
    expect(onDescriptionChange).toHaveBeenCalledWith("新职责");
  });

  it("enables weak-edge ownership only for two ordinary weak edges", () => {
    const orchestration = normalizeAgentOrchestration(undefined);
    const workerAgent = { ...DEFAULT_AGENTS.idea, decisionBy: "agent" as const };
    const onWeakDecisionByChange = vi.fn();
    const { rerender } = render(
      <CanvasInspector
        node={workerNode}
        agent={workerAgent}
        definition={{ name: "idea", template: "idea" }}
        orchestration={orchestration}
        edges={[
          weakEdge("ordinary", "execution"),
          weakEdge("fixed", "writing", true),
          weakEdge("finish", "finish")
        ]}
        onWeakDecisionByChange={onWeakDecisionByChange}
      />
    );

    expect(screen.getByRole("button", { name: "Main Agent" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "当前 Agent" })).toBeDisabled();
    expect(screen.getByText("1 条普通弱边")).toBeVisible();

    rerender(
      <CanvasInspector
        node={workerNode}
        agent={workerAgent}
        definition={{ name: "idea", template: "idea" }}
        orchestration={orchestration}
        edges={[weakEdge("first", "execution"), weakEdge("second", "writing")]}
        onWeakDecisionByChange={onWeakDecisionByChange}
      />
    );
    const currentAgent = screen.getByRole("button", { name: "当前 Agent" });
    expect(currentAgent).toBeEnabled();
    expect(currentAgent).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Main Agent" }));
    expect(onWeakDecisionByChange).toHaveBeenCalledWith("main");
  });

  it("adds, changes, and removes Skills without mixing fixed and automatic lists", () => {
    const orchestration = normalizeAgentOrchestration(undefined);
    const onAgentPatch = vi.fn();
    const agent = {
      ...DEFAULT_AGENTS.idea,
      skills: ["builtin:fixed"],
      autoSkills: ["builtin:auto"]
    };
    render(
      <CanvasInspector
        node={workerNode}
        agent={agent}
        definition={{ name: "idea", template: "idea" }}
        orchestration={orchestration}
        skills={[
          { id: "builtin:fixed", name: "Fixed" },
          { id: "builtin:auto", name: "Auto" },
          { id: "builtin:new", name: "New" }
        ]}
        onAgentPatch={onAgentPatch}
      />
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Fixed加载方式" }), {
      target: { value: "auto" }
    });
    expect(onAgentPatch).toHaveBeenCalledWith({
      skills: [],
      autoSkills: ["builtin:auto", "builtin:fixed"]
    });

    fireEvent.change(screen.getByRole("combobox", { name: "添加 Skill" }), {
      target: { value: "builtin:new" }
    });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(onAgentPatch).toHaveBeenCalledWith({
      skills: ["builtin:fixed", "builtin:new"],
      autoSkills: ["builtin:auto"]
    });

    fireEvent.click(screen.getByRole("button", { name: "移除 Skill Auto" }));
    expect(onAgentPatch).toHaveBeenCalledWith({
      skills: ["builtin:fixed"],
      autoSkills: []
    });
  });

  it("creates a custom Skill from the selected Agent inspector and enables it", async () => {
    const orchestration = normalizeAgentOrchestration(undefined);
    const onAgentPatch = vi.fn();
    const onAddSkill = vi.fn().mockResolvedValue({
      id: "user:custom-check",
      name: "Custom Check",
      description: "检查结果"
    });
    render(
      <CanvasInspector
        node={workerNode}
        agent={{ ...DEFAULT_AGENTS.idea, skills: [], autoSkills: [] }}
        definition={{ name: "idea", template: "idea" }}
        orchestration={orchestration}
        skills={[]}
        onAgentPatch={onAgentPatch}
        onAddSkill={onAddSkill}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "新增 Skill" }));
    expect(screen.getByRole("dialog", { name: "为idea创建新 Skill" })).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Skill 标题" }), { target: { value: "Custom Check" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Skill 内容" }), { target: { value: "检查结果" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Skill" }));
    await waitFor(() => expect(onAddSkill).toHaveBeenCalledWith("Custom Check", "检查结果"));
    expect(onAgentPatch).toHaveBeenCalledWith({ skills: ["user:custom-check"], autoSkills: [] });
  });

  it("keeps system MCPs in the selector and creates custom MCPs from the modal", async () => {
    const orchestration = normalizeAgentOrchestration(undefined);
    const systemMcp: FixedMcpDefinition = {
      name: "research-docs",
      url: "https://mcp.example.test/docs",
      description: "科研文档检索"
    };
    const onAgentPatch = vi.fn();
    const onToggleMcp = vi.fn();
    const onAddMcp = vi.fn().mockResolvedValue({ name: "local-tools", url: "https://mcp.example.test/local" });
    render(
      <CanvasInspector
        node={workerNode}
        agent={{ ...DEFAULT_AGENTS.idea, mcpServers: [] }}
        definition={{ name: "idea", template: "idea" }}
        orchestration={orchestration}
        mcpDirectory={[systemMcp]}
        mcpOptions={[systemMcp]}
        onAgentPatch={onAgentPatch}
        onToggleMcp={onToggleMcp}
        onAddMcp={onAddMcp}
      />
    );

    fireEvent.click(screen.getByText("添加 MCP", { exact: true }));
    expect(screen.getByText("系统 MCP")).toBeVisible();
    const systemCheckbox = screen.getByRole("checkbox", { name: /research-docs/ });
    fireEvent.click(systemCheckbox);
    expect(onToggleMcp).toHaveBeenCalledWith(systemMcp, true);

    fireEvent.click(screen.getByRole("button", { name: "添加新 MCP" }));
    expect(screen.getByRole("dialog", { name: "为idea添加 MCP" })).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "MCP 名称" }), { target: { value: "local-tools" } });
    fireEvent.change(screen.getByRole("textbox", { name: "MCP URL" }), { target: { value: "https://mcp.example.test/local" } });
    const mcpDialog = screen.getByRole("dialog", { name: "为idea添加 MCP" });
    fireEvent.click(within(mcpDialog).getByRole("button", { name: "添加 MCP" }));
    await waitFor(() => expect(onAddMcp).toHaveBeenCalledWith("local-tools", "https://mcp.example.test/local"));
    expect(onAgentPatch).not.toHaveBeenCalled();
  });
});
