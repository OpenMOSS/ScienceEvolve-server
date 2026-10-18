// Test-only real-browser fixture; no project API, Gateway, account or Git writes.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { cloneAgentsConfig, defaultAgentConfig, DEFAULT_AGENTS, DEFAULT_AGENT_ORCHESTRATION } from "../src/lib";
import { WorkflowCanvasEditor } from "../src/components/workflow-canvas/WorkflowCanvasEditor";
import { addScopedGroup, upgradeLegacyGroups } from "../src/components/workflow-canvas/core/scoped-workflow";
import { syncMainOuterRoutes } from "../src/components/workflow-canvas/core/workflow-nodes";
import "../src/styles.css";

const initial = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
const initialAgents = cloneAgentsConfig(DEFAULT_AGENTS);
initial.agents.push({ name: "checker", template: "review" });
initialAgents.checker = defaultAgentConfig("checker", "review");
initial.routes.checker = [{ target: "main", kind: "strong" }];
initial.decisionPlans.checker = "Validate the current result.";
upgradeLegacyGroups(initial);
addScopedGroup(initial, { id: "G", displayName: "Research", leaderAgentId: "main", memberAgentIds: ["idea", "execution", "writing", "review", "checker"] });
addScopedGroup(initial, { id: "H", displayName: "Review team", parentGroupId: "G", leaderAgentId: "main", memberAgentIds: ["review", "checker"] });
const group = initial.scopedWorkflow!.groups.find((item) => item.id === "G")!;
const ids = Object.fromEntries(group.workflow.nodes.flatMap((node) => node.kind === "agent" ? [[node.agentId, node.nodeId]] : []));
group.workflow.input.edges = [ids.idea, ids.review, ids.checker].map((target) => ({ kind: "parallel", target }));
group.workflow.routes[ids.idea] = [{ kind: "strong", target: ids.execution }];
group.workflow.routes[ids.execution] = [{ kind: "strong", target: ids.idea }];
group.workflow.routes[ids.writing] = [{ kind: "strong", target: "finish" }];
group.workflow.routes[ids.review] = [{ kind: "strong", target: "H" }];
group.workflow.routes[ids.checker] = [{ kind: "strong", target: ids.writing }];
group.workflow.routes.H = [{ kind: "strong", target: "finish" }];
group.workflow.loops = [{ id: "verification", from: ids.execution, to: ids.idea, exitTo: ids.writing, maxIterations: 2 }];
initial.routes.G = [{ kind: "strong", target: "main" }];
syncMainOuterRoutes(initial);

function Acceptance() {
  const [orchestration, setOrchestration] = useState(initial);
  const [agents, setAgents] = useState(initialAgents);
  Object.assign(window, { __openfarsAcceptance: { orchestration, agents, ids } });
  return <WorkflowCanvasEditor orchestration={orchestration} agents={agents}
    onOrchestrationChange={setOrchestration} onAgentsChange={setAgents} gitEnabled />;
}
createRoot(document.getElementById("root")!).render(<Acceptance />);
