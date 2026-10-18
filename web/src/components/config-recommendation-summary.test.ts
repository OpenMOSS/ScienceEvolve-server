import { describe, expect, it } from "vitest";
import { DEFAULT_AGENTS, DEFAULT_AGENT_ORCHESTRATION } from "../lib";
import { summarizeConfigurationChanges } from "./config-recommendation-summary";

const configuration = () => ({ agents: structuredClone(DEFAULT_AGENTS), orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION) });
describe("configuration recommendation change summary", () => {
  it("summarizes Agent additions, removals and the actual modified settings", () => {
    const before = configuration(), after = configuration();
    after.orchestration.agents = after.orchestration.agents.filter(agent => agent.name !== "writing");
    delete after.agents.writing;
    after.orchestration.agents.push({ name: "analyst", description: "分析观测结果" });
    after.agents.analyst = { ...after.agents.idea, model: "new-model" };
    after.agents.idea.model = "other-model";
    after.agents.idea.instructions = "围绕当前课题制定方案";
    after.orchestration.agents.find(agent => agent.name === "idea")!.description = "负责研究方案设计";
    after.agents.idea.skills = [...before.agents.idea.skills, "extra-skill"];
    after.agents.execution.experimentMcp = !before.agents.execution.experimentMcp;
    after.orchestration.termination.condition = "验收全部成果后结束";
    const summary = summarizeConfigurationChanges(before, after);
    expect(summary.addedAgents).toEqual([{ name: "analyst", description: "分析观测结果 · new-model" }]);
    expect(summary.removedAgents).toEqual(["writing"]);
    expect(summary.updatedAgents).toContainEqual({ name: "idea", description: "负责研究方案设计", changes: expect.arrayContaining([
      expect.stringContaining("模型："), "职责提示词已更新", "固定 Skills：新增 1 项"
    ]) });
    expect(summary.updatedAgents).toContainEqual({ name: "execution", changes: expect.arrayContaining([expect.stringContaining("SII 实验工具：")]) });
    expect(summary.workflowChanges).toEqual(expect.arrayContaining(["Agent 编排", "终止条件"]));
    expect(summary.introduction).toBe("本次推荐新增 1 个 Agent，调整 2 个 Agent，移除 1 个 Agent，更新 2 项 Workflow 设置。");
    expect(summary.workflowOverview).toBe("推荐团队共 5 个 Agent，任务入口为 idea，终止节点为 review。");
  });

  it("does not report reordered object keys, tool order or empty optional lists as modifications", () => {
    const before = configuration(), after = configuration();
    before.agents.idea.skills = ["first", "second"];
    after.agents.idea.skills = ["second", "first"];
    after.orchestration.routes = Object.fromEntries(Object.entries(after.orchestration.routes).reverse());
    before.orchestration.loops = [];
    delete after.orchestration.loops;
    after.agents.idea.experimentMcp = false;
    const summary = summarizeConfigurationChanges(before, after);
    expect(summary).toMatchObject({ addedAgents: [], removedAgents: [], updatedAgents: [], workflowChanges: [] });
    expect(summary.introduction).toBe("推荐结果与当前配置一致，没有需要修改的内容。");
  });

  it("describes tool configuration changes without copying URLs, tokens or full prompts", () => {
    const before = configuration(), after = configuration();
    after.agents.idea.instructions = "private-prompt-content";
    after.agents.idea.mcpServers = [{ name: "research", url: "https://example.test/mcp?token=private-token" }];
    const summary = summarizeConfigurationChanges(before, after);
    expect(summary.updatedAgents[0]?.changes).toEqual(expect.arrayContaining(["职责提示词已更新", "MCP 工具已调整，当前 1 项"]));
    expect(JSON.stringify(summary)).not.toContain("private-token");
    expect(JSON.stringify(summary)).not.toContain("private-prompt-content");
  });
});
