import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import path from "node:path";
import { SkillCatalog } from "../../../../server/src/skill-catalog.js";
import { cloneAgentsConfig, DEFAULT_AGENTS, DEFAULT_AGENT_ORCHESTRATION } from "../../lib";
import type { AgentsConfig } from "../../types";
import { WorkflowCanvasEditor } from "./WorkflowCanvasEditor";

it("selects the real bundled Agent4Sci catalog and preserves fixed selections across workflow reload", async () => {
  // Vitest runs this workspace from web/; jsdom rewrites import.meta.url to HTTP.
  const catalog = await new SkillCatalog([path.resolve("../.agents/skills")]).list();
  const ids = ["research", "experiment", "checklist"].map(name => `builtin:agent4sci-${name}`);
  let saved = cloneAgentsConfig(DEFAULT_AGENTS);
  saved.idea.skills = [];
  saved.idea.autoSkills = [];
  function Harness({ initial }: { initial: AgentsConfig }) {
    const [agents, setAgents] = useState(initial);
    return <WorkflowCanvasEditor orchestration={structuredClone(DEFAULT_AGENT_ORCHESTRATION)}
      agents={agents} skills={catalog} onOrchestrationChange={() => {}}
      onAgentsChange={value => { saved = value; setAgents(value); }} />;
  }
  let view = render(<Harness initial={saved} />);
  fireEvent.click(view.container.querySelector('[data-node-id="idea"]')!);
  for (const id of ids) {
    const select = screen.getByLabelText("添加 Skill");
    expect(within(select).getByRole("option", { name: id.slice(8) })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: id } });
    fireEvent.click(within(select.parentElement!).getByRole("button", { name: "添加" }));
  }
  expect(saved.idea.skills).toEqual(ids);
  expect(saved.idea.autoSkills).toEqual([]);
  const reloaded: AgentsConfig = JSON.parse(JSON.stringify(saved));
  view.unmount();
  view = render(<Harness initial={reloaded} />);
  fireEvent.click(view.container.querySelector('[data-node-id="idea"]')!);
  for (const id of ids) expect(screen.getByLabelText(`${id.slice(8)}加载方式`)).toHaveValue("fixed");
});
